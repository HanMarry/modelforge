//! RunRecorder (spec mathmodel-parity-and-beyond, requirement 16, design C1): measures one
//! execution of computation code inside a Project and writes its Run_Record.
//!
//! [`RunRecorder::begin`] runs right before the process starts: it hashes the code and the
//! inputs, allocates the run id and remembers the Project tree. [`RunRecorder::finish`] runs
//! after the process ended: it finds and hashes the outputs, builds the record, replaces
//! credential values and writes `.modelforge/runs/<run_id>.json` atomically. A caller that waits
//! for `finish` before doing anything else never leaves a finished step without its record, and
//! a process killed at any point leaves either no record or a complete one (requirement 22.4,
//! Property 51).
//!
//! Inputs and outputs (requirement 16.1): declared paths win. Otherwise the inputs are the
//! existing Project files named in the command or the code, and the outputs are the files whose
//! size or modification time changed during the run. `.modelforge/` and a few tool caches never
//! count. Both lists stop at [`MAX_RECORDED_FILES`].

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, Local};
use sha2::{Digest, Sha256};

use super::run_record::{
    allocate_run_id, format_timestamp, is_project_relative_path, persist_run_record_with_faults,
    redact_run_record, remove_orphaned_temp_files, Dependency, FileHash, NoWriteFaults, RunConfig,
    RunFailure, RunRecord, SecretValue, WriteFaults, MAX_RECORDED_FILES, RUN_RECORD_SCHEMA_VERSION,
    SEED_UNSET,
};

/// Recorded for a provider, model or runtime the recorder has no way to learn.
pub const CONFIG_UNKNOWN: &str = "未知";

/// Never inputs or outputs: ModelForge's own metadata, and tool caches that change on every run
/// without being its products. Skipped at any depth.
const SKIPPED_DIRS: &[&str] = &[
    ".modelforge",
    ".git",
    "__pycache__",
    "node_modules",
    ".venv",
    ".ipynb_checkpoints",
];
/// Bounds the tree walk, for a Project root that turns out to be a home directory.
const MAX_SCANNED_FILES: usize = 100_000;
/// Only the start of a very large code file is searched for input paths.
const MAX_CODE_SCAN_BYTES: u64 = 4 * 1024 * 1024;
/// Distinct path-like strings checked against the file system per run.
const MAX_PATH_CANDIDATES: usize = 20_000;
const MAX_PATH_CANDIDATE_LEN: usize = 1024;
/// A temporary record file this old is left over from a killed writer; a live write takes
/// milliseconds.
const ORPHANED_TEMP_AGE: Duration = Duration::from_secs(10 * 60);

/// Source of the Credential_Store values that must not appear in a Run_Record (requirement 16.2).
///
/// The modeling extension is an MCP server and cannot read the desktop's Credential_Store, so the
/// default [`NoSecretValues`] supplies nothing. Supplying real values is left to the integration
/// layer (tasks.md, layer C).
pub trait SecretValues: Send + Sync {
    fn secret_values(&self) -> Vec<SecretValue>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct NoSecretValues;

impl SecretValues for NoSecretValues {
    fn secret_values(&self) -> Vec<SecretValue> {
        Vec::new()
    }
}

/// Told when a run has started and after its Run_Record is on disk. The desktop marks artifacts
/// "执行中" by run id when a run starts and applies the record when it finishes; forwarding
/// these events over ACP (`runs/finished`) is left to the integration layer (tasks.md, layer C).
/// The default [`NoRunObserver`] does nothing.
pub trait RunObserver: Send + Sync {
    fn run_started(&self, _project_root: &Path, _run: &RunHandle) {}
    fn run_finished(&self, _project_root: &Path, _run: &FinishedRun) {}
}

#[derive(Debug, Default, Clone, Copy)]
pub struct NoRunObserver;

impl RunObserver for NoRunObserver {}

/// How an execution ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunOutcome {
    /// The process exited with this code. A process killed by a signal, which has no exit code,
    /// is reported as 128 + the signal number.
    Exited(i32),
    /// The execution time limit ran out and the process was killed.
    TimedOut,
    /// The user cancelled and the process was killed.
    Cancelled,
}

impl RunOutcome {
    pub fn exit_code(self) -> Option<i32> {
        match self {
            Self::Exited(code) => Some(code),
            Self::TimedOut | Self::Cancelled => None,
        }
    }

    pub fn failure(self) -> Option<RunFailure> {
        match self {
            Self::Exited(0) => None,
            Self::Exited(_) => Some(RunFailure::NonZeroExit),
            Self::TimedOut => Some(RunFailure::Timeout),
            Self::Cancelled => Some(RunFailure::Cancelled),
        }
    }

    pub fn succeeded(self) -> bool {
        self == Self::Exited(0)
    }
}

/// What is about to run.
#[derive(Debug, Clone)]
pub struct RunSpec {
    /// The full command line, recorded as given (credential values are replaced on write).
    pub command: String,
    /// The code file that runs, absolute or relative to the Project root.
    pub code: PathBuf,
    /// Declared input files or directories; `None` detects them from the command and the code.
    pub inputs: Option<Vec<PathBuf>>,
    /// Declared output files or directories; `None` detects the files the run changed.
    pub outputs: Option<Vec<PathBuf>>,
    /// `None` or blank records [`SEED_UNSET`].
    pub seed: Option<String>,
    pub provider: String,
    pub model: String,
}

/// What the run's environment turned out to be; probed while the code runs.
#[derive(Debug, Clone, Default)]
pub struct ProbedEnvironment {
    pub runtime: String,
    pub dependencies: Vec<Dependency>,
}

/// A run between [`RunRecorder::begin`] and [`RunRecorder::finish`]. Dropping it records
/// nothing.
#[derive(Debug)]
pub struct RunHandle {
    run_id: String,
    started_at: DateTime<Local>,
    command: String,
    code: FileHash,
    inputs: Vec<FileHash>,
    inputs_detected: bool,
    more_inputs: bool,
    seed: String,
    provider: String,
    model: String,
    declared_outputs: Option<Vec<PathBuf>>,
    before: Option<TreeSnapshot>,
    notes: Vec<String>,
}

impl RunHandle {
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn started_at(&self) -> String {
        format_timestamp(&self.started_at)
    }

    pub fn command(&self) -> &str {
        &self.command
    }

    pub fn code(&self) -> &FileHash {
        &self.code
    }

    /// Paths that could not be recorded so far, for the tool result.
    pub fn notes(&self) -> &[String] {
        &self.notes
    }
}

/// A run whose Run_Record is on disk.
#[derive(Debug, Clone)]
pub struct FinishedRun {
    /// The record as written; its run id may differ from the handle's if the name was taken.
    pub record: RunRecord,
    pub path: PathBuf,
    /// Paths that could not be recorded, for the tool result. Not part of the record.
    pub notes: Vec<String>,
}

#[derive(Clone)]
pub struct RunRecorder {
    /// Absolute, as given: the working directory of the process.
    project_root: PathBuf,
    /// Resolved, for deciding whether a path is inside the Project.
    canonical_root: PathBuf,
    secrets: Arc<dyn SecretValues>,
}

impl RunRecorder {
    pub fn new(project_root: &Path, secrets: Arc<dyn SecretValues>) -> Result<Self> {
        let project_root = std::path::absolute(project_root)
            .with_context(|| format!("resolving the Project root {}", project_root.display()))?;
        let canonical_root = fs::canonicalize(&project_root)
            .with_context(|| format!("resolving the Project root {}", project_root.display()))?;
        if !canonical_root.is_dir() {
            bail!(
                "the Project root {} is not a directory",
                project_root.display()
            );
        }
        Ok(Self {
            project_root,
            canonical_root,
            secrets,
        })
    }

    pub fn project_root(&self) -> &Path {
        &self.project_root
    }

    /// The Project-relative `/` path of an existing file or directory inside the Project. Links
    /// are resolved first, so nothing outside the Project passes.
    pub fn relative_path(&self, path: &Path) -> Option<String> {
        let absolute = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.project_root.join(path)
        };
        let canonical = fs::canonicalize(absolute).ok()?;
        relative_to_string(canonical.strip_prefix(&self.canonical_root).ok()?)
    }

    /// Like [`Self::relative_path`], for files only.
    pub fn project_file(&self, path: &Path) -> Option<String> {
        let relative = self.relative_path(path)?;
        (is_project_relative_path(&relative) && self.project_root.join(&relative).is_file())
            .then_some(relative)
    }

    pub fn begin(&self, spec: RunSpec) -> Result<RunHandle> {
        remove_orphaned_temp_files(&self.project_root, ORPHANED_TEMP_AGE);
        let started_at = Local::now();
        let mut notes = Vec::new();

        let code_path = self.project_file(&spec.code).ok_or_else(|| {
            anyhow!(
                "the code file {} is not a file inside the Project {}",
                spec.code.display(),
                self.project_root.display()
            )
        })?;
        let code_file = self.project_root.join(&code_path);
        let code = FileHash {
            sha256: sha256_file(&code_file)
                .with_context(|| format!("hashing the code file {code_path}"))?,
            path: code_path,
        };

        let (input_paths, inputs_detected) = match &spec.inputs {
            Some(declared) => (self.declared_files(declared, "input", &mut notes), false),
            None => (
                self.detect_inputs(&code_file, &code.path, &spec.command),
                true,
            ),
        };
        let (inputs, more_inputs) = self.hash_files(input_paths, &mut notes);

        // Taken last, right before the process starts.
        let before = spec
            .outputs
            .is_none()
            .then(|| snapshot_tree(&self.project_root));
        let run_id = allocate_run_id(&self.project_root, &started_at);
        let seed = spec
            .seed
            .filter(|seed| !seed.trim().is_empty())
            .unwrap_or_else(|| SEED_UNSET.to_string());

        Ok(RunHandle {
            run_id,
            started_at,
            command: spec.command,
            code,
            inputs,
            inputs_detected,
            more_inputs,
            seed,
            provider: spec.provider,
            model: spec.model,
            declared_outputs: spec.outputs,
            before,
            notes,
        })
    }

    pub fn finish(
        &self,
        handle: RunHandle,
        outcome: RunOutcome,
        environment: ProbedEnvironment,
    ) -> Result<FinishedRun> {
        self.finish_with_faults(handle, outcome, environment, &mut NoWriteFaults)
    }

    pub(crate) fn finish_with_faults(
        &self,
        handle: RunHandle,
        outcome: RunOutcome,
        environment: ProbedEnvironment,
        faults: &mut dyn WriteFaults,
    ) -> Result<FinishedRun> {
        let RunHandle {
            run_id,
            started_at,
            command,
            code,
            mut inputs,
            inputs_detected,
            more_inputs,
            seed,
            provider,
            model,
            declared_outputs,
            before,
            mut notes,
        } = handle;

        let output_paths = match (&declared_outputs, &before) {
            (Some(declared), _) => self.declared_files(declared, "output", &mut notes),
            (None, Some(before)) => {
                let after = snapshot_tree(&self.project_root);
                if !before.complete || !after.complete {
                    notes.push(format!(
                        "the Project has more than {MAX_SCANNED_FILES} files; only the first \
                         {MAX_SCANNED_FILES} were checked for outputs"
                    ));
                }
                changed_files(before, &after)
            }
            (None, None) => Vec::new(),
        };
        let (outputs, more_outputs) = self.hash_files(output_paths, &mut notes);

        // A detected input the run rewrote is its product, not something it consumed; keeping
        // it would make the fresh output look out of date at once.
        if inputs_detected {
            let produced: HashSet<&str> = outputs.iter().map(|file| file.path.as_str()).collect();
            inputs.retain(|input| !produced.contains(input.path.as_str()));
        }
        let inputs_truncated = more_inputs && inputs.len() == MAX_RECORDED_FILES;
        let outputs_truncated = more_outputs && outputs.len() == MAX_RECORDED_FILES;

        let record = RunRecord {
            schema_version: RUN_RECORD_SCHEMA_VERSION,
            run_id,
            inputs,
            inputs_truncated,
            code,
            config: RunConfig {
                provider,
                model,
                runtime: environment.runtime,
            },
            command,
            dependencies: environment.dependencies,
            seed,
            exit_code: outcome.exit_code(),
            failure: outcome.failure(),
            started_at: format_timestamp(&started_at),
            ended_at: format_timestamp(&Local::now()),
            outputs,
            outputs_truncated,
        };
        let record = redact_run_record(record, &self.secrets.secret_values());
        let (record, path) = persist_run_record_with_faults(&self.project_root, record, faults)?;
        Ok(FinishedRun {
            record,
            path,
            notes,
        })
    }

    /// Hashes up to [`MAX_RECORDED_FILES`] of `paths`; the flag says whether more were left.
    fn hash_files(&self, paths: Vec<String>, notes: &mut Vec<String>) -> (Vec<FileHash>, bool) {
        let mut files = Vec::new();
        for path in paths {
            if files.len() == MAX_RECORDED_FILES {
                return (files, true);
            }
            match sha256_file(&self.project_root.join(&path)) {
                Ok(sha256) => files.push(FileHash { path, sha256 }),
                Err(error) => notes.push(format!("could not hash {path}: {error}")),
            }
        }
        (files, false)
    }

    /// The files named by declared paths, directories expanded in name order.
    fn declared_files(
        &self,
        declared: &[PathBuf],
        kind: &str,
        notes: &mut Vec<String>,
    ) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut files = Vec::new();
        for path in declared {
            let Some(relative) = self.relative_path(path) else {
                notes.push(format!(
                    "declared {kind} {} was not found inside the Project",
                    path.display()
                ));
                continue;
            };
            let absolute = self.project_root.join(&relative);
            if absolute.is_dir() {
                for inner in snapshot_tree(&absolute).files.into_keys() {
                    let full = if relative.is_empty() {
                        inner
                    } else {
                        format!("{relative}/{inner}")
                    };
                    if is_project_relative_path(&full) && seen.insert(full.clone()) {
                        files.push(full);
                    }
                }
            } else if is_project_relative_path(&relative) && seen.insert(relative.clone()) {
                files.push(relative);
            }
        }
        files
    }

    /// Existing Project files named in the command or the code, in the order they appear.
    fn detect_inputs(&self, code_file: &Path, code_path: &str, command: &str) -> Vec<String> {
        let code_text = read_prefix(code_file, MAX_CODE_SCAN_BYTES);
        let code_dir = code_file.parent();
        let mut tried = HashSet::new();
        let mut seen = HashSet::from([code_path.to_string()]);
        let mut inputs = Vec::new();
        let candidates = path_candidates(command)
            .into_iter()
            .chain(path_candidates(&code_text));
        for candidate in candidates {
            if tried.len() == MAX_PATH_CANDIDATES {
                break;
            }
            if !tried.insert(candidate.clone()) {
                continue;
            }
            let Some(input) = self.resolve_candidate(&candidate, code_dir) else {
                continue;
            };
            if !input.starts_with(".modelforge/") && seen.insert(input.clone()) {
                inputs.push(input);
            }
        }
        inputs
    }

    /// A path-like string from code, read relative to the Project root (the working directory)
    /// or to the code file's directory.
    fn resolve_candidate(&self, candidate: &str, code_dir: Option<&Path>) -> Option<String> {
        // Source code escapes backslashes, and Windows-style paths should resolve everywhere.
        let normalized = candidate.trim().replace("\\\\", "/").replace('\\', "/");
        if normalized.is_empty() {
            return None;
        }
        let path = Path::new(&normalized);
        if path.is_absolute() {
            return self.project_file(path);
        }
        self.project_file(path)
            .or_else(|| code_dir.and_then(|dir| self.project_file(&dir.join(path))))
    }
}

/// `/`-joined normal components; `None` for anything else or for names that are not UTF-8.
fn relative_to_string(relative: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str()?),
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

/// Strings in `text` that could be paths: everything between quotes on one line, and bare tokens
/// that contain a dot or a separator.
fn path_candidates(text: &str) -> Vec<String> {
    let mut candidates = Vec::new();
    let mut push = |candidate: &str| {
        if !candidate.is_empty()
            && candidate.len() <= MAX_PATH_CANDIDATE_LEN
            && !candidate.contains('\0')
        {
            candidates.push(candidate.to_string());
        }
    };
    for line in text.lines() {
        for quote in ['"', '\'', '`'] {
            // Every second piece lies between two quotes.
            for inside in line.split(quote).skip(1).step_by(2) {
                push(inside);
            }
        }
        for token in line.split(|c: char| c.is_whitespace() || "\"'`()[]{},;=<>|&".contains(c)) {
            if token.contains(['.', '/', '\\']) && !token.starts_with('-') {
                push(token);
            }
        }
    }
    candidates
}

fn read_prefix(path: &Path, limit: u64) -> String {
    let mut bytes = Vec::new();
    if let Ok(file) = fs::File::open(path) {
        let _ = file.take(limit).read_to_end(&mut bytes);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileStamp {
    len: u64,
    modified: Option<SystemTime>,
}

/// Size and modification time of every file under a directory, keyed by relative `/` path.
#[derive(Debug, Default)]
struct TreeSnapshot {
    files: BTreeMap<String, FileStamp>,
    /// False when the walk stopped at [`MAX_SCANNED_FILES`].
    complete: bool,
}

/// Walks `root` in name order without following links, skipping [`SKIPPED_DIRS`].
fn snapshot_tree(root: &Path) -> TreeSnapshot {
    let mut files = BTreeMap::new();
    let mut pending = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = pending.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<fs::DirEntry> = entries.flatten().collect();
        entries.sort_by_key(fs::DirEntry::file_name);
        let mut subdirs = Vec::new();
        for entry in entries {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let relative = if prefix.is_empty() {
                name.to_string()
            } else {
                format!("{prefix}/{name}")
            };
            if file_type.is_dir() {
                if !SKIPPED_DIRS.contains(&name) {
                    subdirs.push((entry.path(), relative));
                }
            } else if file_type.is_file() {
                if files.len() == MAX_SCANNED_FILES {
                    return TreeSnapshot {
                        files,
                        complete: false,
                    };
                }
                let Ok(metadata) = entry.metadata() else {
                    continue;
                };
                files.insert(
                    relative,
                    FileStamp {
                        len: metadata.len(),
                        modified: metadata.modified().ok(),
                    },
                );
            }
        }
        // The stack pops the last entry first; reversed, directories are visited in name order.
        pending.extend(subdirs.into_iter().rev());
    }
    TreeSnapshot {
        files,
        complete: true,
    }
}

/// Files that are new or whose size or modification time changed, in path order. After an
/// incomplete first walk a file missing from it may simply not have been reached, so only
/// changed files count then.
fn changed_files(before: &TreeSnapshot, after: &TreeSnapshot) -> Vec<String> {
    after
        .files
        .iter()
        .filter(|(path, stamp)| match before.files.get(*path) {
            Some(old) => old != *stamp,
            None => before.complete,
        })
        .map(|(path, _)| path.clone())
        .filter(|path| is_project_relative_path(path))
        .collect()
}

/// Lowercase hexadecimal SHA-256 of a file's content, read in chunks.
pub fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        hasher.update(&buffer[..read]);
    }
    Ok(to_hex(hasher.finalize()))
}

/// Digest output types stopped implementing `LowerHex` in sha2 0.11.
fn to_hex(bytes: impl AsRef<[u8]>) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let bytes = bytes.as_ref();
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        hex.push(char::from(HEX[usize::from(byte >> 4)]));
        hex.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modeling::run_record::{runs_dir, SimulatedCrash, WriteStage};
    use proptest::prelude::*;

    const CODE: &str = "import pandas as pd\n\
        frame = pd.read_csv(\"data/in.csv\")  # the input\n\
        frame.to_csv('results/out.csv')\n";

    fn project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for sub in ["code", "data", "results"] {
            fs::create_dir_all(dir.path().join(sub)).unwrap();
        }
        fs::write(dir.path().join("data/in.csv"), "x,y\n1,2\n").unwrap();
        fs::write(dir.path().join("data/unused.csv"), "z\n3\n").unwrap();
        fs::write(dir.path().join("code/main.py"), CODE).unwrap();
        dir
    }

    fn recorder(project: &tempfile::TempDir) -> RunRecorder {
        RunRecorder::new(project.path(), Arc::new(NoSecretValues)).unwrap()
    }

    fn spec(command: &str) -> RunSpec {
        RunSpec {
            command: command.to_string(),
            code: PathBuf::from("code/main.py"),
            inputs: None,
            outputs: None,
            seed: None,
            provider: "openai".to_string(),
            model: "gpt-4o".to_string(),
        }
    }

    fn paths(files: &[FileHash]) -> Vec<&str> {
        files.iter().map(|file| file.path.as_str()).collect()
    }

    fn read_record(path: &Path) -> RunRecord {
        RunRecord::from_json(&fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn detected_inputs_and_outputs_are_recorded() {
        let project = project();
        let recorder = recorder(&project);
        let handle = recorder.begin(spec("python code/main.py")).unwrap();
        assert_eq!(handle.code().path, "code/main.py");

        // What the code would do, plus files that must not count as outputs.
        fs::write(project.path().join("results/out.csv"), "x,y\n1,2\n").unwrap();
        fs::create_dir_all(project.path().join("code/__pycache__")).unwrap();
        fs::write(project.path().join("code/__pycache__/main.pyc"), "cache").unwrap();
        fs::create_dir_all(runs_dir(project.path())).unwrap();
        fs::write(
            runs_dir(project.path()).join(format!("{}.meta.json", handle.run_id())),
            "{}",
        )
        .unwrap();

        let run = recorder
            .finish(handle, RunOutcome::Exited(0), ProbedEnvironment::default())
            .unwrap();
        let record = &run.record;
        assert_eq!(paths(&record.inputs), vec!["data/in.csv"]);
        assert_eq!(paths(&record.outputs), vec!["results/out.csv"]);
        assert_eq!(
            record.code.sha256,
            sha256_file(&project.path().join("code/main.py")).unwrap()
        );
        assert_eq!(
            record.inputs[0].sha256,
            sha256_file(&project.path().join("data/in.csv")).unwrap()
        );
        assert_eq!(record.seed, SEED_UNSET);
        assert_eq!(record.exit_code, Some(0));
        assert_eq!(record.failure, None);
        assert!(!record.inputs_truncated && !record.outputs_truncated);
        assert_eq!(read_record(&run.path), run.record);
        assert_eq!(
            run.path,
            runs_dir(project.path()).join(format!("{}.json", record.run_id))
        );
    }

    #[test]
    fn a_detected_input_the_run_rewrites_is_only_an_output() {
        let project = project();
        fs::write(project.path().join("results/out.csv"), "old\n").unwrap();
        let recorder = recorder(&project);
        let handle = recorder.begin(spec("python code/main.py")).unwrap();
        fs::write(project.path().join("results/out.csv"), "x,y\n1,2\n").unwrap();
        let run = recorder
            .finish(handle, RunOutcome::Exited(0), ProbedEnvironment::default())
            .unwrap();
        assert_eq!(paths(&run.record.inputs), vec!["data/in.csv"]);
        assert_eq!(paths(&run.record.outputs), vec!["results/out.csv"]);
    }

    #[test]
    fn declared_paths_take_precedence_and_directories_expand() {
        let project = project();
        fs::create_dir_all(project.path().join("data/nested")).unwrap();
        fs::write(project.path().join("data/nested/more.csv"), "m\n").unwrap();
        let recorder = recorder(&project);
        let mut spec = spec("python code/main.py");
        spec.inputs = Some(vec![PathBuf::from("data"), PathBuf::from("missing.csv")]);
        spec.outputs = Some(vec![
            PathBuf::from("results/a.csv"),
            PathBuf::from("results/never.csv"),
        ]);
        spec.seed = Some("42".to_string());
        let handle = recorder.begin(spec).unwrap();
        assert!(handle
            .notes()
            .iter()
            .any(|note| note.contains("missing.csv")));
        fs::write(project.path().join("results/a.csv"), "a\n").unwrap();
        fs::write(project.path().join("results/undeclared.csv"), "b\n").unwrap();
        let run = recorder
            .finish(handle, RunOutcome::Exited(0), ProbedEnvironment::default())
            .unwrap();
        assert_eq!(
            paths(&run.record.inputs),
            vec!["data/in.csv", "data/nested/more.csv", "data/unused.csv"]
        );
        assert_eq!(paths(&run.record.outputs), vec!["results/a.csv"]);
        assert!(run.notes.iter().any(|note| note.contains("never.csv")));
        assert_eq!(run.record.seed, "42");
    }

    #[test]
    fn every_outcome_writes_a_valid_record() {
        let project = project();
        let recorder = recorder(&project);
        for (outcome, exit_code, failure) in [
            (RunOutcome::Exited(0), Some(0), None),
            (
                RunOutcome::Exited(2),
                Some(2),
                Some(RunFailure::NonZeroExit),
            ),
            (
                RunOutcome::Exited(137),
                Some(137),
                Some(RunFailure::NonZeroExit),
            ),
            (
                RunOutcome::Exited(-1),
                Some(-1),
                Some(RunFailure::NonZeroExit),
            ),
            (RunOutcome::TimedOut, None, Some(RunFailure::Timeout)),
            (RunOutcome::Cancelled, None, Some(RunFailure::Cancelled)),
        ] {
            let handle = recorder.begin(spec("python code/main.py")).unwrap();
            let run = recorder
                .finish(handle, outcome, ProbedEnvironment::default())
                .unwrap();
            assert_eq!(run.record.exit_code, exit_code, "{outcome:?}");
            assert_eq!(run.record.failure, failure, "{outcome:?}");
            assert_eq!(read_record(&run.path), run.record);
        }
    }

    struct FixedSecrets;

    impl SecretValues for FixedSecrets {
        fn secret_values(&self) -> Vec<SecretValue> {
            vec![SecretValue {
                reference: "${secret:openai}".to_string(),
                value: "sk-test-1234567890".to_string(),
            }]
        }
    }

    #[test]
    fn credential_values_are_replaced_before_writing() {
        let project = project();
        let recorder = RunRecorder::new(project.path(), Arc::new(FixedSecrets)).unwrap();
        let handle = recorder
            .begin(spec("python code/main.py --key sk-test-1234567890"))
            .unwrap();
        let run = recorder
            .finish(
                handle,
                RunOutcome::Exited(0),
                ProbedEnvironment {
                    runtime: "Python 3.12.4".to_string(),
                    dependencies: vec![Dependency {
                        name: "private-sk-test-1234567890".to_string(),
                        version: "1.0".to_string(),
                    }],
                },
            )
            .unwrap();
        let text = fs::read_to_string(&run.path).unwrap();
        assert!(!text.contains("sk-test-1234567890"), "{text}");
        assert_eq!(
            run.record.command,
            "python code/main.py --key ${secret:openai}"
        );
        assert_eq!(run.record.config.runtime, "Python 3.12.4");
    }

    #[test]
    fn code_outside_the_project_is_rejected() {
        let project = project();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("main.py"), CODE).unwrap();
        let recorder = recorder(&project);
        let mut outside_spec = spec("python main.py");
        outside_spec.code = outside.path().join("main.py");
        assert!(recorder.begin(outside_spec).is_err());
        let mut missing = spec("python code/none.py");
        missing.code = PathBuf::from("code/none.py");
        assert!(recorder.begin(missing).is_err());
        assert!(!runs_dir(project.path()).exists());
    }

    #[test]
    fn more_than_the_cap_of_outputs_is_truncated() {
        let project = project();
        let recorder = recorder(&project);
        let handle = recorder.begin(spec("python code/main.py")).unwrap();
        for index in 0..=MAX_RECORDED_FILES {
            fs::write(
                project.path().join(format!("results/{index:04}.csv")),
                "v\n",
            )
            .unwrap();
        }
        let run = recorder
            .finish(handle, RunOutcome::Exited(0), ProbedEnvironment::default())
            .unwrap();
        assert_eq!(run.record.outputs.len(), MAX_RECORDED_FILES);
        assert!(run.record.outputs_truncated);
        assert_eq!(run.record.outputs[0].path, "results/0000.csv");
        assert_eq!(read_record(&run.path), run.record);
    }

    #[test]
    fn path_candidates_find_quoted_and_bare_paths() {
        let found = path_candidates(
            "df = read(\"data/a b.csv\") + load('x.mat')\ntype data\\in.csv > out.txt --flag=cfg/run.toml",
        );
        for expected in [
            "data/a b.csv",
            "x.mat",
            "data\\in.csv",
            "out.txt",
            "cfg/run.toml",
        ] {
            assert!(
                found.iter().any(|c| c == expected),
                "{expected} in {found:?}"
            );
        }
        assert!(!found.iter().any(|c| c.starts_with("--")));
    }

    #[test]
    fn hashes_are_lowercase_hex_sha256() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty");
        fs::write(&path, "").unwrap();
        assert_eq!(
            sha256_file(&path).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        fs::write(&path, "abc").unwrap();
        assert_eq!(
            sha256_file(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    /// Where the process dies, relative to one step.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Stop {
        /// Between the previous step and this one.
        BeforeBegin,
        /// While the code runs, half of its outputs written.
        WhileRunning,
        /// The code has ended; its record was not written yet.
        BeforeFinish,
        /// Inside the atomic write of the record.
        InWrite(WriteStage),
    }

    struct StopAt(Option<WriteStage>);

    impl WriteFaults for StopAt {
        fn stop_at(&mut self, stage: WriteStage) -> bool {
            self.0 == Some(stage)
        }
    }

    #[derive(Debug, Clone)]
    struct Step {
        outcome: RunOutcome,
        outputs: usize,
    }

    fn step() -> impl Strategy<Value = Step> {
        let outcome = prop_oneof![
            Just(RunOutcome::Exited(0)),
            (1i32..=255).prop_map(RunOutcome::Exited),
            Just(RunOutcome::TimedOut),
            Just(RunOutcome::Cancelled),
        ];
        (outcome, 0usize..=3).prop_map(|(outcome, outputs)| Step { outcome, outputs })
    }

    fn stop() -> impl Strategy<Value = Option<(usize, Stop)>> {
        let point = prop_oneof![
            Just(Stop::BeforeBegin),
            Just(Stop::WhileRunning),
            Just(Stop::BeforeFinish),
            Just(Stop::InWrite(WriteStage::TempCreated)),
            Just(Stop::InWrite(WriteStage::HalfWritten)),
            Just(Stop::InWrite(WriteStage::Written)),
            Just(Stop::InWrite(WriteStage::Synced)),
            Just(Stop::InWrite(WriteStage::Renamed)),
        ];
        prop::option::of((0usize..8, point))
    }

    fn step_output(step: usize, file: usize) -> String {
        format!("results/step{step}-{file}.csv")
    }

    // Feature: mathmodel-parity-and-beyond, Property 51: 步骤记录耐中断
    // The steps run through the real recorder against a temporary Project; the computation is a
    // stand-in that writes files, and the termination point is injected, so no process starts.
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]

        #[test]
        fn finished_steps_survive_any_termination_point(
            steps in prop::collection::vec(step(), 1..=4),
            stop in stop(),
        ) {
            let project = project();
            let recorder = recorder(&project);
            let stop = stop.map(|(step, point)| (step % steps.len(), point));
            let mut finished: Vec<(usize, RunRecord)> = Vec::new();
            let mut stopped_in_write = None;

            for (index, step) in steps.iter().enumerate() {
                let point = stop.filter(|(at, _)| *at == index).map(|(_, point)| point);
                if point == Some(Stop::BeforeBegin) {
                    break;
                }
                let handle = recorder
                    .begin(spec(&format!("python code/main.py --step {index}")))
                    .unwrap();
                let written = if point == Some(Stop::WhileRunning) {
                    step.outputs / 2
                } else {
                    step.outputs
                };
                for file in 0..written {
                    fs::write(project.path().join(step_output(index, file)), format!("{index},{file}\n"))
                        .unwrap();
                }
                if matches!(point, Some(Stop::WhileRunning | Stop::BeforeFinish)) {
                    break;
                }
                let stage = match point {
                    Some(Stop::InWrite(stage)) => Some(stage),
                    _ => None,
                };
                match recorder.finish_with_faults(
                    handle,
                    step.outcome,
                    ProbedEnvironment::default(),
                    &mut StopAt(stage),
                ) {
                    Ok(run) => {
                        prop_assert!(stage.is_none());
                        finished.push((index, run.record));
                    }
                    Err(error) => {
                        prop_assert!(error.downcast_ref::<SimulatedCrash>().is_some(), "{:#}", error);
                        stopped_in_write = stage;
                        break;
                    }
                }
            }

            // Restart: a new recorder over the same Project, after the sweep for leftovers.
            drop(recorder);
            let restarted = RunRecorder::new(project.path(), Arc::new(NoSecretValues)).unwrap();
            remove_orphaned_temp_files(restarted.project_root(), Duration::ZERO);

            let mut on_disk = BTreeMap::new();
            if let Ok(entries) = fs::read_dir(runs_dir(project.path())) {
                for entry in entries {
                    let entry = entry.unwrap();
                    let name = entry.file_name().into_string().unwrap();
                    let text = fs::read_to_string(entry.path()).unwrap();
                    let parsed = RunRecord::from_json(&text);
                    prop_assert!(parsed.is_ok(), "{} is not a complete Run_Record: {:?}", name, text);
                    let record = parsed.unwrap();
                    prop_assert_eq!(&name, &format!("{}.json", record.run_id));
                    on_disk.insert(record.run_id.clone(), record);
                }
            }

            for (index, record) in &finished {
                prop_assert_eq!(on_disk.get(&record.run_id), Some(record));
                prop_assert_eq!(paths(&record.inputs), vec!["data/in.csv"]);
                let expected: Vec<String> =
                    (0..steps[*index].outputs).map(|file| step_output(*index, file)).collect();
                prop_assert_eq!(paths(&record.outputs), expected.iter().map(String::as_str).collect::<Vec<_>>());
                prop_assert_eq!(record.exit_code, steps[*index].outcome.exit_code());
            }
            // Only a writer stopped after the rename leaves one more record, and it is whole.
            let extra = usize::from(stopped_in_write == Some(WriteStage::Renamed));
            prop_assert_eq!(on_disk.len(), finished.len() + extra);
        }
    }
}
