//! Run_Records for the developer `shell` (spec mathmodel-parity-and-beyond, task 21.7,
//! requirement 16.1). A shell command that runs a Project code file with python, Rscript or
//! matlab is measured by [`RunRecorder`] the way the modeling extension's `run_script` is, and the
//! tool result waits until the record is on disk (requirement 22.4). The result carries the same
//! `_meta["modelforge/run"]` as `run_script`, and the start of the process is announced with the
//! tool notification `modelforge/run_started`; the ACP server turns both into `runs/*`
//! notifications (`layer-c-contract-acp.md`, sections 3.1 and 3.2).
//!
//! Which commands are recorded ([`classify`]):
//! - One simple command whose program is `python`, `python3`, `python3.12`, `py`, `Rscript` or
//!   `matlab`, compared case-insensitively on the file name, so a path (`.venv/bin/python`,
//!   `C:\Python312\python.exe`) and a `.exe`, `.bat` or `.cmd` suffix are fine. On POSIX shells
//!   `NAME=value` assignments may come first. `uv run [options] python ...`, `uv run x.py` and
//!   `uv run -m module` count as python.
//! - The code file is python's script argument after its options (a directory or zip archive
//!   runs its `__main__.py`), the module of `-m` as `a/b.py` or `a/b/__main__.py`, Rscript's file
//!   argument, or the script a `matlab -batch` or `-r` statement names (`run('q1.m')`, `q1`),
//!   relative to `-sd` if given. It has to be a file inside the Project.
//! - Redirections (`> out.txt`, `2>&1`, `< in.csv`) are allowed.
//!
//! Recognized but not recorded, and the result says why: command lines that chain or pipe
//! commands (`&&`, `||`, `;`, `|`, `&`, line breaks), since the exit code would not be the
//! interpreter's; inline code (`-c`, `-e`); standard input; modules and files that are not Project
//! files; unbalanced quotes; `uv run --directory`. Anything else (`cd x && python y.py`,
//! `sudo python`, `env X=1 python`, `time python`, PowerShell's `& python`, `uv pip`) is not a
//! computation command: the shell behaves exactly as before and nothing is scanned.
//!
//! Credential values (requirement 16.2): the recorder replaces the values of [`RunSource::secrets`]
//! with their Secret_References before the record is written. The developer extension passes the
//! Kernel's Credential_Store values (`crate::config::run_record_secrets::kernel_secret_values`),
//! the same source goose-cli installs for the modeling extension.

use std::iter::Peekable;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::str::Chars;
use std::sync::Arc;
use std::time::Duration;

use goose_run_record::run_record::{Dependency, FileHash, RunRecord};
use goose_run_record::run_recorder::{
    FinishedRun, ProbedEnvironment, RunHandle, RunOutcome, RunRecorder, RunSpec, SecretValues,
    CONFIG_UNKNOWN,
};
use rmcp::model::{
    Annotations, CallToolResult, ContentBlock, CustomNotification, MetaObject, ServerNotification,
    TextContent,
};
use serde_json::{json, Value};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::session::SessionManager;
use crate::subprocess::SubprocessExt;

/// Tool result `_meta` key with the run id, record path and outcome, as `run_script` writes it
/// (`goose_mcp::modeling::run_script::RUN_META_KEY`).
pub(crate) const RUN_META_KEY: &str = "modelforge/run";
/// Tool notification sent once the process of a recorded run started. Params:
/// `{ "runId", "toolCallId"?, "declaredOutputs" }`; the shell declares no outputs.
pub(crate) const RUN_STARTED_NOTIFICATION: &str = "modelforge/run_started";

const RUNTIME_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const DEPENDENCY_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// A probe still running this long after the command ended is given up, which keeps the record
/// inside requirement 16.1's five seconds.
const PROBE_GRACE_AFTER_RUN: Duration = Duration::from_secs(3);
const LISTED_PATHS: usize = 20;
const R_PACKAGES: &str = "ip <- installed.packages()[, c('Package', 'Version'), drop = FALSE]; \
    cat(paste(ip[, 1], ip[, 2], sep = '\\t'), sep = '\\n')";

/// `uv run` options whose value is the next word.
const UV_RUN_VALUE_OPTIONS: &[&str] = &[
    "--with",
    "-w",
    "--with-editable",
    "--with-requirements",
    "--python",
    "-p",
    "--project",
    "--package",
    "--extra",
    "--group",
    "--only-group",
    "--no-group",
    "--env-file",
    "--index",
    "--default-index",
    "--index-url",
    "-i",
    "--extra-index-url",
    "--find-links",
    "-f",
    "--config-file",
    "--cache-dir",
];

const COMPOUND_COMMAND: &str = "the command line runs more than one command (`&&`, `||`, `;`, \
    `|`, `&` or a line break), so its exit code would not be the interpreter's";
const UNBALANCED_QUOTES: &str = "its quotes are not balanced";
const NO_CODE_FILE: &str = "it does not name a code file to run";
const INLINE_CODE: &str = "the code is given inline (-c or -e), not in a Project file";
const STDIN_CODE: &str = "the code comes from standard input, not from a Project file";
const MATLAB_NO_STATEMENT: &str = "matlab runs code only with -batch or -r";
const MATLAB_NO_SCRIPT: &str = "could not tell which script the MATLAB statement runs";
const UV_DIRECTORY: &str = "uv run --directory changes the working directory";

/// Where a shell tool call may record a run.
pub(crate) struct RunSource {
    /// The ACP tool call id (`agent-tool-call-request-id`), sent with the run start.
    pub(crate) tool_call_id: Option<String>,
    /// Looks up the session's provider and model for the record's config.
    pub(crate) sessions: Option<Arc<SessionManager>>,
    /// The Credential_Store values the record must not contain.
    pub(crate) secrets: Arc<dyn SecretValues>,
}

/// What the shell does about a command, decided before it runs.
pub(crate) enum PreparedRun {
    /// Not a computation command: the shell runs it as always.
    Skip,
    /// A computation command that runs without a Run_Record, and why.
    Unrecorded(String),
    /// [`RunRecorder::begin`] has run; the command is next.
    Record(Box<ActiveRun>),
}

/// A computation command between [`RunRecorder::begin`] and [`RunRecorder::finish`].
pub(crate) struct ActiveRun {
    recorder: RunRecorder,
    handle: RunHandle,
    interpreter: Interpreter,
    tool_call_id: Option<String>,
}

/// Decides whether `command` is a computation command to record and, if so, begins its run:
/// hashes the code and the inputs and snapshots the Project, off the async threads. A command
/// [`classify`] does not recognize costs one pass over its text and touches nothing else.
pub(crate) async fn prepare(
    command: &str,
    project_root: &Path,
    session_id: Option<&str>,
    source: RunSource,
) -> PreparedRun {
    let (interpreter, code) = match classify(command, Syntax::native()) {
        Classification::Other => return PreparedRun::Skip,
        Classification::Unrecordable(reason) => return PreparedRun::Unrecorded(reason),
        Classification::Recordable { interpreter, code } => (interpreter, code),
    };
    let (provider, model) = session_config(source.sessions.as_deref(), session_id).await;
    let command = command.to_string();
    let root = project_root.to_path_buf();
    let secrets = source.secrets;
    let begun =
        tokio::task::spawn_blocking(move || begin(&root, command, &code, provider, model, secrets))
            .await;
    match begun {
        Ok(Ok((recorder, handle))) => PreparedRun::Record(Box::new(ActiveRun {
            recorder,
            handle,
            interpreter,
            tool_call_id: source.tool_call_id,
        })),
        Ok(Err(reason)) => PreparedRun::Unrecorded(reason),
        Err(error) => PreparedRun::Unrecorded(format!("the recorder task failed: {error}")),
    }
}

fn begin(
    root: &Path,
    command: String,
    code: &CodeFile,
    provider: String,
    model: String,
    secrets: Arc<dyn SecretValues>,
) -> Result<(RunRecorder, RunHandle), String> {
    let recorder = RunRecorder::new(root, secrets).map_err(|error| format!("{error:#}"))?;
    let code_file = code
        .candidates
        .iter()
        .find_map(|candidate| recorder.project_file(candidate))
        .ok_or_else(|| format!("{} is not a file inside the Project", code.shown))?;
    let handle = recorder
        .begin(RunSpec {
            command,
            code: PathBuf::from(code_file),
            inputs: None,
            outputs: None,
            seed: None,
            provider,
            model,
        })
        .map_err(|error| format!("{error:#}"))?;
    Ok((recorder, handle))
}

/// The session's provider and model, or [`CONFIG_UNKNOWN`].
async fn session_config(
    sessions: Option<&SessionManager>,
    session_id: Option<&str>,
) -> (String, String) {
    let session = match (sessions, session_id) {
        (Some(sessions), Some(id)) => sessions.get_session(id, false).await.ok(),
        _ => None,
    };
    let known = |value: Option<String>| {
        value
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| CONFIG_UNKNOWN.to_string())
    };
    let provider = known(
        session
            .as_ref()
            .and_then(|session| session.provider_name.clone()),
    );
    let model = known(
        session
            .and_then(|session| session.model_config)
            .map(|config| config.model_name),
    );
    (provider, model)
}

impl ActiveRun {
    /// `modelforge/run_started`, for the shell to send once the process started.
    pub(crate) fn started_notification(&self) -> ServerNotification {
        run_started_notification(self.handle.run_id(), self.tool_call_id.as_deref())
    }

    /// Starts probing the interpreter's version and packages beside the command.
    pub(crate) fn start_probes(&self, login_path: Option<&str>) -> Probes {
        let env = ProbeEnv {
            cwd: self.recorder.project_root().to_path_buf(),
            path: login_path.map(str::to_string),
        };
        Probes {
            started: Instant::now(),
            runtime: ProbeTask(tokio::spawn(probe_runtime(
                self.interpreter.clone(),
                env.clone(),
            ))),
            dependencies: ProbeTask(tokio::spawn(probe_dependencies(
                self.interpreter.clone(),
                env,
            ))),
        }
    }

    /// Writes the Run_Record of a command that ended with `outcome`. `None` means the shell
    /// failed before the command ended, and nothing is recorded.
    pub(crate) async fn finish(self, outcome: Option<RunOutcome>, probes: Probes) -> RunReport {
        let Some(outcome) = outcome else {
            return RunReport::unrecorded("the shell failed before the command ended");
        };
        let ended = Instant::now();
        let runtime = probes
            .runtime
            .finish_by((probes.started + RUNTIME_PROBE_TIMEOUT).min(ended + PROBE_GRACE_AFTER_RUN))
            .await
            .flatten();
        let dependencies = probes
            .dependencies
            .finish_by(
                (probes.started + DEPENDENCY_PROBE_TIMEOUT).min(ended + PROBE_GRACE_AFTER_RUN),
            )
            .await
            .flatten();
        let mut notes = Vec::new();
        if dependencies.is_none() {
            notes.push(format!(
                "the dependency summary of {} could not be read in time; the record lists none",
                self.interpreter.family()
            ));
        }
        let environment = ProbedEnvironment {
            runtime: describe_runtime(&self.interpreter, runtime),
            dependencies: dependencies.unwrap_or_default(),
        };

        let Self {
            recorder, handle, ..
        } = self;
        let run_id = handle.run_id().to_string();
        match tokio::task::spawn_blocking(move || recorder.finish(handle, outcome, environment))
            .await
        {
            Ok(Ok(run)) => {
                // The recorder's own notes are the paths it could not record.
                notes.extend(run.notes.iter().cloned());
                RunReport::recorded(&run, outcome, &notes)
            }
            Ok(Err(error)) => RunReport::unrecorded(&format!(
                "run {run_id} ended but its Run_Record could not be written: {error:#}"
            )),
            Err(error) => RunReport::unrecorded(&format!(
                "run {run_id} ended but the recorder task failed: {error}"
            )),
        }
    }
}

/// How the shell process ended, as the Run_Record counts it. A process killed by a signal has
/// no exit code and is recorded as 128 + the signal, like `run_script` does.
pub(crate) fn run_outcome(
    timed_out: bool,
    cancelled: bool,
    exit_code: Option<i32>,
    signal: Option<i32>,
) -> RunOutcome {
    if timed_out {
        RunOutcome::TimedOut
    } else if cancelled {
        RunOutcome::Cancelled
    } else {
        match (exit_code, signal) {
            (Some(code), _) => RunOutcome::Exited(code),
            (None, Some(signal)) => RunOutcome::Exited(128_i32.saturating_add(signal)),
            (None, None) => RunOutcome::Exited(1),
        }
    }
}

/// What the shell result says about the run: a text block after the command output, and for a
/// written record the `_meta["modelforge/run"]` payload.
#[derive(Debug)]
pub(crate) struct RunReport {
    text: String,
    meta: Option<Value>,
}

impl RunReport {
    pub(crate) fn unrecorded(reason: &str) -> Self {
        Self {
            text: format!("No Run_Record was written: {reason}."),
            meta: None,
        }
    }

    fn recorded(run: &FinishedRun, outcome: RunOutcome, notes: &[String]) -> Self {
        let record = &run.record;
        let mut text = format!(
            "Run_Record: {} (run {} {}; code {})\n",
            record_path(&record.run_id),
            record.run_id,
            describe_outcome(outcome),
            record.code.path,
        );
        push_paths(&mut text, "Inputs", &record.inputs, record.inputs_truncated);
        push_paths(
            &mut text,
            "Outputs",
            &record.outputs,
            record.outputs_truncated,
        );
        if !notes.is_empty() {
            text.push_str("Notes:\n");
            for note in notes {
                text.push_str(&format!("  - {note}\n"));
            }
        }
        Self {
            text: text.trim_end().to_string(),
            meta: Some(run_meta(record)),
        }
    }

    /// Appends the report to the shell result.
    pub(crate) fn attach(self, result: &mut CallToolResult) {
        result.content.push(ContentBlock::Text(
            TextContent::new(self.text).with_annotations(Annotations::default().with_priority(0.0)),
        ));
        if let Some(meta) = self.meta {
            result
                .meta
                .get_or_insert_with(MetaObject::new)
                .0
                .insert(RUN_META_KEY.to_string(), meta);
        }
    }
}

/// `_meta["modelforge/run"]`, field for field what `run_script` sends.
fn run_meta(record: &RunRecord) -> Value {
    let outputs: Vec<&str> = record
        .outputs
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    json!({
        "runId": record.run_id,
        "recordPath": record_path(&record.run_id),
        "exitCode": record.exit_code,
        "failure": record.failure,
        "outputs": outputs,
    })
}

/// Relative to the Project root, with `/` on every platform.
fn record_path(run_id: &str) -> String {
    format!(".modelforge/runs/{run_id}.json")
}

fn run_started_notification(run_id: &str, tool_call_id: Option<&str>) -> ServerNotification {
    let mut params = serde_json::Map::new();
    params.insert("runId".to_string(), json!(run_id));
    if let Some(tool_call_id) = tool_call_id {
        params.insert("toolCallId".to_string(), json!(tool_call_id));
    }
    params.insert("declaredOutputs".to_string(), json!([]));
    ServerNotification::CustomNotification(CustomNotification::new(
        RUN_STARTED_NOTIFICATION,
        Some(Value::Object(params)),
    ))
}

fn describe_outcome(outcome: RunOutcome) -> String {
    match outcome {
        RunOutcome::Exited(0) => "finished with exit code 0".to_string(),
        RunOutcome::Exited(code) => format!("failed with exit code {code} (非零退出码)"),
        RunOutcome::TimedOut => "was stopped by the time limit (超时)".to_string(),
        RunOutcome::Cancelled => "was cancelled (用户取消)".to_string(),
    }
}

fn push_paths(text: &mut String, label: &str, files: &[FileHash], truncated: bool) {
    let more = if truncated { ", more not recorded" } else { "" };
    let listed: Vec<&str> = files
        .iter()
        .take(LISTED_PATHS)
        .map(|file| file.path.as_str())
        .collect();
    let listed = if listed.is_empty() {
        "none".to_string()
    } else {
        listed.join(", ")
    };
    text.push_str(&format!("{label} ({}{more}): {listed}", files.len()));
    if files.len() > LISTED_PATHS {
        text.push_str(&format!(", … and {} more", files.len() - LISTED_PATHS));
    }
    text.push('\n');
}

// ---------------------------------------------------------------------------------------------
// Recognizing computation commands.

/// How a shell command line is quoted: POSIX shells, or cmd and PowerShell on Windows, where a
/// backslash is a path separator rather than an escape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Syntax {
    Posix,
    Windows,
}

impl Syntax {
    fn native() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Posix
        }
    }
}

/// What runs the code, for probing its version and packages. Holds the program as written.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Interpreter {
    Python(String),
    /// `uv run`: uv picks the environment.
    Uv(String),
    R(String),
    Matlab(String),
}

impl Interpreter {
    fn program(&self) -> &str {
        match self {
            Self::Python(program)
            | Self::Uv(program)
            | Self::R(program)
            | Self::Matlab(program) => program,
        }
    }

    /// The name a version line is expected to contain.
    fn family(&self) -> &'static str {
        match self {
            Self::Python(_) => "python",
            Self::Uv(_) => "uv",
            Self::R(_) => "rscript",
            Self::Matlab(_) => "matlab",
        }
    }
}

/// The code file a command runs: the first of `candidates` that is a Project file. `shown` names
/// it in messages.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CodeFile {
    shown: String,
    candidates: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Classification {
    /// Not a python, Rscript or matlab command.
    Other,
    /// A computation command that cannot be recorded, and why.
    Unrecordable(String),
    Recordable {
        interpreter: Interpreter,
        code: CodeFile,
    },
}

/// A recognized interpreter invocation, and where its code comes from.
struct Invocation {
    interpreter: Interpreter,
    code: Result<CodeFile, String>,
}

fn classify(line: &str, syntax: Syntax) -> Classification {
    // A trailing line break ends the one command rather than starting another.
    let split = split_words(line.trim(), syntax);
    let mut words = split.words.as_slice();
    if syntax == Syntax::Posix {
        let assignments = words.iter().take_while(|word| is_assignment(word)).count();
        words = &words[assignments..];
    }
    let Some(invocation) = parse_invocation(words) else {
        return Classification::Other;
    };
    if let Some(problem) = split.problem {
        return Classification::Unrecordable(problem.to_string());
    }
    match invocation.code {
        Ok(code) => Classification::Recordable {
            interpreter: invocation.interpreter,
            code,
        },
        Err(reason) => Classification::Unrecordable(reason),
    }
}

/// `NAME=value` in front of a POSIX command sets its environment.
fn is_assignment(word: &str) -> bool {
    word.split_once('=').is_some_and(|(name, _)| {
        let mut chars = name.chars();
        chars
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProgramKind {
    Python,
    R,
    Matlab,
    Uv,
}

fn program_kind(program: &str) -> Option<ProgramKind> {
    let name = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(program)
        .to_ascii_lowercase();
    let stem = [".exe", ".bat", ".cmd"]
        .iter()
        .find_map(|suffix| name.strip_suffix(*suffix))
        .unwrap_or(name.as_str());
    match stem {
        "py" => Some(ProgramKind::Python),
        "rscript" => Some(ProgramKind::R),
        "matlab" => Some(ProgramKind::Matlab),
        "uv" => Some(ProgramKind::Uv),
        _ if stem
            .strip_prefix("python")
            .is_some_and(|version| version.chars().all(|c| c.is_ascii_digit() || c == '.')) =>
        {
            Some(ProgramKind::Python)
        }
        _ => None,
    }
}

fn parse_invocation(words: &[String]) -> Option<Invocation> {
    let (program, args) = words.split_first()?;
    let invocation = match program_kind(program)? {
        ProgramKind::Python => Invocation {
            interpreter: Interpreter::Python(program.clone()),
            code: python_code(args),
        },
        ProgramKind::R => Invocation {
            interpreter: Interpreter::R(program.clone()),
            code: rscript_code(args),
        },
        ProgramKind::Matlab => Invocation {
            interpreter: Interpreter::Matlab(program.clone()),
            code: matlab_code(args),
        },
        ProgramKind::Uv => return uv_run(program, args),
    };
    Some(invocation)
}

/// `python [options] (script | -m module | -c code | -) [args]`, including the py launcher's
/// version selectors (`py -3.12 x.py`).
fn python_code(args: &[String]) -> Result<CodeFile, String> {
    let mut index = 0;
    while let Some(arg) = args.get(index) {
        index += 1;
        if arg == "-" {
            return Err(STDIN_CODE.to_string());
        }
        if let Some(long) = arg.strip_prefix("--") {
            if long == "check-hash-based-pycs" {
                index += 1;
            }
            continue;
        }
        let Some(flags) = arg.strip_prefix('-') else {
            return Ok(script_file(arg));
        };
        if flags.starts_with(|c: char| c.is_ascii_digit()) || flags.starts_with("V:") {
            continue;
        }
        // A cluster of short options such as -u, -OO, -Werror or -uc.
        let mut chars = flags.chars();
        while let Some(flag) = chars.next() {
            let rest = chars.as_str();
            match flag {
                'c' => return Err(INLINE_CODE.to_string()),
                'm' => {
                    let module = if rest.is_empty() {
                        args.get(index).map(String::as_str)
                    } else {
                        Some(rest)
                    };
                    return match module {
                        Some(module) => module_file(module),
                        None => Err(NO_CODE_FILE.to_string()),
                    };
                }
                'W' | 'X' => {
                    if rest.is_empty() {
                        index += 1;
                    }
                    break;
                }
                _ => {}
            }
        }
    }
    Err(NO_CODE_FILE.to_string())
}

/// A script path; a directory or zip archive runs the `__main__.py` inside it.
fn script_file(path: &str) -> CodeFile {
    CodeFile {
        shown: path.to_string(),
        candidates: vec![PathBuf::from(path), Path::new(path).join("__main__.py")],
    }
}

/// `-m a.b` runs `a/b.py` or the package `a/b`, looked up from the working directory.
fn module_file(module: &str) -> Result<CodeFile, String> {
    let valid = module
        .split('.')
        .all(|part| !part.is_empty() && part.chars().all(|c| c.is_alphanumeric() || c == '_'));
    if !valid {
        return Err(format!("{module} is not a module name"));
    }
    let base: PathBuf = module.split('.').collect();
    Ok(CodeFile {
        shown: format!("module {module}"),
        candidates: vec![base.with_extension("py"), base.join("__main__.py")],
    })
}

/// `Rscript [--options] (file | -e expr) [args]`.
fn rscript_code(args: &[String]) -> Result<CodeFile, String> {
    for arg in args {
        if arg == "-e" {
            return Err(INLINE_CODE.to_string());
        }
        if arg.starts_with('-') {
            continue;
        }
        return Ok(CodeFile {
            shown: arg.clone(),
            candidates: vec![PathBuf::from(arg)],
        });
    }
    Err(NO_CODE_FILE.to_string())
}

/// `matlab [options] (-batch | -r) statement`, with the script found in the statement.
fn matlab_code(args: &[String]) -> Result<CodeFile, String> {
    let mut statement = None;
    let mut folder = None;
    let mut index = 0;
    while let Some(arg) = args.get(index) {
        index += 1;
        match arg.to_ascii_lowercase().as_str() {
            "-batch" | "-r" => {
                statement = args.get(index);
                index += 1;
            }
            "-sd" => {
                folder = args.get(index);
                index += 1;
            }
            "-logfile" | "-c" | "-licmode" => index += 1,
            _ => {}
        }
    }
    let statement = statement.ok_or_else(|| MATLAB_NO_STATEMENT.to_string())?;
    let candidates: Vec<PathBuf> = matlab_scripts(statement)
        .into_iter()
        .map(|script| match folder {
            Some(folder) => Path::new(folder).join(script),
            None => PathBuf::from(script),
        })
        .collect();
    if candidates.is_empty() {
        return Err(MATLAB_NO_SCRIPT.to_string());
    }
    Ok(CodeFile {
        shown: format!("the script that `{statement}` runs"),
        candidates,
    })
}

/// Script files a MATLAB statement may run, most specific first: quoted names
/// (`run('code/q1.m')`), then bare words (`q1`, `run code/q1.m`). A name without an extension
/// gets `.m`; names with another extension are data, not scripts.
fn matlab_scripts(statement: &str) -> Vec<String> {
    let quoted = ['\'', '"']
        .into_iter()
        .flat_map(|quote| statement.split(quote).skip(1).step_by(2))
        .map(str::trim)
        .filter(|name| !name.is_empty());
    let bare = statement
        .split(|c: char| c.is_whitespace() || ";,()'\"".contains(c))
        .filter(|word| is_script_word(word));
    let mut scripts: Vec<String> = Vec::new();
    for name in quoted.chain(bare) {
        let script = match Path::new(name).extension().and_then(|ext| ext.to_str()) {
            Some(extension) if extension.eq_ignore_ascii_case("m") => name.to_string(),
            Some(_) => continue,
            None => format!("{name}.m"),
        };
        if !scripts.contains(&script) {
            scripts.push(script);
        }
    }
    scripts
}

/// A bare MATLAB word that may name a script: an identifier or a path, not a number or operator.
fn is_script_word(word: &str) -> bool {
    word.chars()
        .next()
        .is_some_and(|first| first.is_alphabetic() || matches!(first, '.' | '/' | '\\'))
        && word
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '.' | '/' | '\\' | ':' | '-'))
}

/// `uv run [options] (python ... | script.py ... | -m module ...)`; any other `uv` command is
/// not a computation command.
fn uv_run(program: &str, args: &[String]) -> Option<Invocation> {
    let (subcommand, args) = args.split_first()?;
    if subcommand != "run" {
        return None;
    }
    let interpreter = Interpreter::Uv(program.to_string());
    let mut changes_dir = false;
    let mut index = 0;
    while let Some(arg) = args.get(index) {
        index += 1;
        if arg == "--directory" || arg.starts_with("--directory=") {
            changes_dir = true;
            if arg == "--directory" {
                index += 1;
            }
            continue;
        }
        let code = if arg == "-m" || arg == "--module" {
            match args.get(index) {
                Some(module) => module_file(module),
                None => Err(NO_CODE_FILE.to_string()),
            }
        } else if arg.starts_with('-') {
            if UV_RUN_VALUE_OPTIONS.contains(&arg.as_str()) {
                index += 1;
            }
            continue;
        } else if program_kind(arg) == Some(ProgramKind::Python) {
            python_code(&args[index..])
        } else if is_python_file(arg) {
            Ok(script_file(arg))
        } else {
            return None;
        };
        let code = if changes_dir {
            Err(UV_DIRECTORY.to_string())
        } else {
            code
        };
        return Some(Invocation { interpreter, code });
    }
    None
}

fn is_python_file(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("py") || extension.eq_ignore_ascii_case("pyw")
        })
}

/// The words of a command line with quotes removed and redirections dropped, up to the first
/// operator that makes it more than one simple command.
#[derive(Debug)]
struct SplitWords {
    words: Vec<String>,
    /// Why the line is not one simple command; the words stop there.
    problem: Option<&'static str>,
}

#[derive(Default)]
struct WordBuilder {
    words: Vec<String>,
    current: String,
    /// A word has begun, possibly as empty quotes.
    started: bool,
    /// The word being read names the file of a redirection and is not an argument.
    redirect_target: bool,
}

impl WordBuilder {
    fn push(&mut self, c: char) {
        self.current.push(c);
        self.started = true;
    }

    fn end(&mut self) {
        if !self.started {
            return;
        }
        self.started = false;
        let word = std::mem::take(&mut self.current);
        if !std::mem::take(&mut self.redirect_target) {
            self.words.push(word);
        }
    }
}

fn split_words(line: &str, syntax: Syntax) -> SplitWords {
    let mut builder = WordBuilder::default();
    let mut problem = None;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                builder.started = true;
                if !read_quoted(&mut chars, '\'', None, &mut builder.current) {
                    problem = Some(UNBALANCED_QUOTES);
                    break;
                }
            }
            '"' => {
                builder.started = true;
                let escape = (syntax == Syntax::Posix).then_some('\\');
                if !read_quoted(&mut chars, '"', escape, &mut builder.current) {
                    problem = Some(UNBALANCED_QUOTES);
                    break;
                }
            }
            '\\' if syntax == Syntax::Posix => match chars.next() {
                // A line continuation.
                Some('\n') => {}
                Some(next) => builder.push(next),
                None => builder.push('\\'),
            },
            '\n' | '\r' | ';' | '|' => {
                problem = Some(COMPOUND_COMMAND);
                break;
            }
            '&' if chars.peek() == Some(&'>') => {
                // `&>` and `&>>` redirect both output streams.
                builder.end();
                chars.next();
                read_redirection(&mut chars, &mut builder);
            }
            '&' => {
                problem = Some(COMPOUND_COMMAND);
                break;
            }
            '<' | '>' => {
                let descriptor = builder.started
                    && !builder.current.is_empty()
                    && builder.current.chars().all(|d| d.is_ascii_digit());
                if descriptor {
                    // The digits of `2>` name the redirected descriptor.
                    builder.current.clear();
                    builder.started = false;
                } else {
                    builder.end();
                }
                read_redirection(&mut chars, &mut builder);
            }
            c if c.is_whitespace() => builder.end(),
            c => builder.push(c),
        }
    }
    builder.end();
    SplitWords {
        words: builder.words,
        problem,
    }
}

/// Reads up to the closing `quote`; false when the line ends first. `escape` (POSIX double
/// quotes) keeps the next `"`, `\`, `$` or `` ` `` literally and drops an escaped line break.
fn read_quoted(
    chars: &mut Peekable<Chars<'_>>,
    quote: char,
    escape: Option<char>,
    out: &mut String,
) -> bool {
    while let Some(c) = chars.next() {
        if c == quote {
            return true;
        }
        if Some(c) == escape {
            match chars.next() {
                Some(next @ ('"' | '\\' | '$' | '`')) => out.push(next),
                Some('\n') => {}
                Some(next) => {
                    out.push(c);
                    out.push(next);
                }
                None => return false,
            }
            continue;
        }
        out.push(c);
    }
    false
}

/// After `<`, `>` or `&>`: the rest of the operator, then the file it names, unless the operator
/// duplicates or closes a descriptor (`2>&1`, `>&-`).
fn read_redirection(chars: &mut Peekable<Chars<'_>>, builder: &mut WordBuilder) {
    while chars.next_if(|&c| c == '<' || c == '>').is_some() {}
    if chars.next_if_eq(&'&').is_some()
        && chars
            .peek()
            .is_some_and(|&c| c.is_ascii_digit() || c == '-')
    {
        while chars.next_if(|&c| c.is_ascii_digit() || c == '-').is_some() {}
        return;
    }
    builder.redirect_target = true;
}

// ---------------------------------------------------------------------------------------------
// Probing the environment while the command runs.

#[derive(Debug, Clone)]
struct ProbeEnv {
    /// The Project root, where the shell runs the command.
    cwd: PathBuf,
    /// The PATH the shell runs the command with, when it differs from goose's.
    path: Option<String>,
}

/// Version and package probes running beside a recorded command.
pub(crate) struct Probes {
    started: Instant,
    runtime: ProbeTask<Option<String>>,
    dependencies: ProbeTask<Option<Vec<Dependency>>>,
}

/// A probe task. Dropping it aborts the task, which kills its process.
struct ProbeTask<T>(JoinHandle<T>);

impl<T> ProbeTask<T> {
    async fn finish_by(mut self, deadline: Instant) -> Option<T> {
        match tokio::time::timeout_at(deadline, &mut self.0).await {
            Ok(Ok(value)) => Some(value),
            _ => None,
        }
    }
}

impl<T> Drop for ProbeTask<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Inside Flatpak the shell runs commands on the host, which probes from goose cannot see.
#[cfg(not(windows))]
fn probes_available() -> bool {
    !super::shell::is_flatpak()
}

#[cfg(windows)]
fn probes_available() -> bool {
    true
}

/// A relative program path such as `.venv/bin/python` is relative to the Project, where the
/// shell runs it.
fn resolve_program(program: &str, cwd: &Path) -> PathBuf {
    let path = Path::new(program);
    if path.is_relative() && program.contains(['/', '\\']) {
        cwd.join(path)
    } else {
        path.to_path_buf()
    }
}

/// Stdout and stderr of a successful short command, or `None`.
async fn probe(
    env: &ProbeEnv,
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> Option<(String, String)> {
    if !probes_available() {
        return None;
    }
    let mut command = tokio::process::Command::new(resolve_program(program, &env.cwd));
    command
        .args(args)
        .current_dir(&env.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(path) = &env.path {
        command.env("PATH", path);
    }
    command.set_no_window();
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .ok()?
        .ok()?;
    output.status.success().then(|| {
        (
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    })
}

fn first_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

async fn probe_runtime(interpreter: Interpreter, env: ProbeEnv) -> Option<String> {
    // Starting MATLAB takes many seconds and a license; the family name has to do.
    if matches!(interpreter, Interpreter::Matlab(_)) {
        return None;
    }
    let (stdout, stderr) = probe(
        &env,
        interpreter.program(),
        &["--version"],
        RUNTIME_PROBE_TIMEOUT,
    )
    .await?;
    first_line(&stdout).or_else(|| first_line(&stderr))
}

/// The installed packages, `Some(empty)` when there is nothing to ask, `None` when asking failed.
async fn probe_dependencies(interpreter: Interpreter, env: ProbeEnv) -> Option<Vec<Dependency>> {
    match &interpreter {
        Interpreter::Python(python) => {
            // uv answers in milliseconds and also covers environments without pip.
            let python = resolve_program(python, &env.cwd)
                .to_string_lossy()
                .into_owned();
            let uv_args = [
                "pip",
                "list",
                "--format",
                "json",
                "--python",
                python.as_str(),
            ];
            if let Some((stdout, _)) = probe(&env, "uv", &uv_args, DEPENDENCY_PROBE_TIMEOUT).await {
                if let Some(dependencies) = parse_pip_json(&stdout) {
                    return Some(dependencies);
                }
            }
            let pip_args = [
                "-m",
                "pip",
                "list",
                "--format=json",
                "--disable-pip-version-check",
            ];
            let (stdout, _) = probe(&env, &python, &pip_args, DEPENDENCY_PROBE_TIMEOUT).await?;
            parse_pip_json(&stdout)
        }
        Interpreter::Uv(uv) => {
            let args = ["pip", "list", "--format", "json"];
            let (stdout, _) = probe(&env, uv, &args, DEPENDENCY_PROBE_TIMEOUT).await?;
            parse_pip_json(&stdout)
        }
        Interpreter::R(rscript) => {
            let (stdout, _) =
                probe(&env, rscript, &["-e", R_PACKAGES], DEPENDENCY_PROBE_TIMEOUT).await?;
            Some(parse_tab_separated(&stdout))
        }
        Interpreter::Matlab(_) => Some(Vec::new()),
    }
}

/// `pip list --format=json` output: one JSON array line, possibly after warnings.
fn parse_pip_json(text: &str) -> Option<Vec<Dependency>> {
    let line = text
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| line.starts_with('['))?;
    serde_json::from_str(line).ok()
}

fn parse_tab_separated(text: &str) -> Vec<Dependency> {
    text.lines()
        .filter_map(|line| line.trim_end().split_once('\t'))
        .map(|(name, version)| Dependency {
            name: name.trim().to_string(),
            version: version.trim().to_string(),
        })
        .collect()
}

/// The version line when there is one, the interpreter name otherwise, plus the platform.
fn describe_runtime(interpreter: &Interpreter, probed: Option<String>) -> String {
    let family = interpreter.family();
    let base = match probed {
        Some(line) if line.to_ascii_lowercase().contains(family) => line,
        Some(line) => format!("{family} {line}"),
        None => family.to_string(),
    };
    format!(
        "{base} ({}-{})",
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::extension::PlatformExtensionContext;
    use crate::agents::mcp_client::McpClientTrait;
    use crate::agents::platform_extensions::developer::DeveloperClient;
    use crate::agents::tool_execution::{ToolCallContext, ToolCallNotificationEmitter};
    use goose_run_record::run_record::{is_run_id, runs_dir, RunFailure, SecretValue, SEED_UNSET};
    use goose_run_record::run_recorder::NoSecretValues;
    use rmcp::object;
    use std::fs;
    use tokio_util::sync::CancellationToken;

    fn recordable(line: &str, syntax: Syntax) -> (Interpreter, CodeFile) {
        match classify(line, syntax) {
            Classification::Recordable { interpreter, code } => (interpreter, code),
            other => panic!("{line:?} gave {other:?}"),
        }
    }

    /// The preferred code file, `/`-separated.
    fn code_of(line: &str, syntax: Syntax) -> String {
        let (_, code) = recordable(line, syntax);
        code.candidates[0].to_string_lossy().replace('\\', "/")
    }

    #[test]
    fn interpreters_are_recognized_by_their_file_name() {
        let python = |program: &str| Interpreter::Python(program.to_string());
        for (line, interpreter) in [
            ("python q1.py", python("python")),
            ("python3 q1.py", python("python3")),
            ("python3.12 -u q1.py", python("python3.12")),
            ("py -3.12 q1.py", python("py")),
            ("PYTHON3.EXE q1.py", python("PYTHON3.EXE")),
            (".venv/bin/python q1.py", python(".venv/bin/python")),
            ("Rscript q1.R", Interpreter::R("Rscript".to_string())),
            (
                "/usr/bin/rscript q1.R",
                Interpreter::R("/usr/bin/rscript".to_string()),
            ),
            (
                "matlab -batch q1",
                Interpreter::Matlab("matlab".to_string()),
            ),
            ("uv run python q1.py", Interpreter::Uv("uv".to_string())),
        ] {
            assert_eq!(recordable(line, Syntax::Posix).0, interpreter, "{line}");
        }
        assert_eq!(
            recordable(
                r#""C:\Program Files\Python312\python.exe" q1.py"#,
                Syntax::Windows
            )
            .0,
            python(r"C:\Program Files\Python312\python.exe")
        );
        assert_eq!(
            recordable(r"tools\python.cmd q1.py", Syntax::Windows).0,
            python(r"tools\python.cmd")
        );
    }

    #[test]
    fn the_code_file_is_found_among_the_arguments() {
        for (line, code) in [
            ("python3 code/q1.py --alpha 0.5", "code/q1.py"),
            ("python -u -W ignore -X utf8 q1.py data.csv", "q1.py"),
            ("python -OO -Werror q1.py", "q1.py"),
            ("python --check-hash-based-pycs never q1.py", "q1.py"),
            ("python -m code.q1 --n 3", "code/q1.py"),
            ("python -mcode.q1", "code/q1.py"),
            ("python app", "app"),
            ("Rscript --vanilla code/q1.R 10", "code/q1.R"),
            ("matlab -batch \"run('code/q1.m')\"", "code/q1.m"),
            ("matlab -batch 'run(\"code/q1\")'", "code/q1.m"),
            ("matlab -nodisplay -r \"q1; exit\"", "q1.m"),
            ("matlab -sd code -batch q1", "code/q1.m"),
            ("uv run --with pandas python code/q1.py", "code/q1.py"),
            ("uv run --python 3.12 code/q1.py", "code/q1.py"),
            ("uv run -m code.q1", "code/q1.py"),
            ("MPLBACKEND=Agg python3 q1.py", "q1.py"),
            ("python3 q1.py > results/log.txt 2>&1", "q1.py"),
            ("python3 q1.py < data/in.csv", "q1.py"),
            ("python3 q1.py\n", "q1.py"),
            ("python3 'my code/q1.py'", "my code/q1.py"),
            ("python3 my\\ code/q1.py", "my code/q1.py"),
        ] {
            assert_eq!(code_of(line, Syntax::Posix), code, "{line}");
        }
        for (line, code) in [
            (r"python code\q1.py", "code/q1.py"),
            (r#"python "C:\proj\my code\q1.py""#, "C:/proj/my code/q1.py"),
            (r#"matlab -batch "run('code\q1.m')""#, "code/q1.m"),
            (r"python q1.py >nul 2>&1", "q1.py"),
        ] {
            assert_eq!(code_of(line, Syntax::Windows), code, "{line}");
        }
    }

    #[test]
    fn a_directory_or_package_runs_its_main_module() {
        let (_, script) = recordable("python app", Syntax::Posix);
        assert_eq!(
            script.candidates,
            [PathBuf::from("app"), Path::new("app").join("__main__.py")]
        );
        let (_, module) = recordable("python -m pkg.tool", Syntax::Posix);
        assert_eq!(
            module.candidates,
            [
                Path::new("pkg").join("tool.py"),
                Path::new("pkg").join("tool").join("__main__.py")
            ]
        );
        assert_eq!(module.shown, "module pkg.tool");
    }

    #[test]
    fn computation_commands_that_cannot_be_recorded_say_why() {
        for (line, reason) in [
            ("python3 q1.py && python3 q2.py", COMPOUND_COMMAND),
            ("python3 q1.py | tee log.txt", COMPOUND_COMMAND),
            ("python3 q1.py; echo done", COMPOUND_COMMAND),
            ("python3 q1.py &", COMPOUND_COMMAND),
            ("python3 q1.py\npython3 q2.py", COMPOUND_COMMAND),
            ("python3 -c 'print(1)'", INLINE_CODE),
            ("python3 -uc 'print(1)'", INLINE_CODE),
            ("Rscript -e 'print(1)'", INLINE_CODE),
            ("python3 - < q1.py", STDIN_CODE),
            ("python3", NO_CODE_FILE),
            ("python3 --version", NO_CODE_FILE),
            ("Rscript --version", NO_CODE_FILE),
            ("matlab -nodesktop", MATLAB_NO_STATEMENT),
            ("matlab -batch \"1 + 2\"", MATLAB_NO_SCRIPT),
            ("uv run --directory code python q1.py", UV_DIRECTORY),
            ("python3 'q1.py", UNBALANCED_QUOTES),
        ] {
            assert_eq!(
                classify(line, Syntax::Posix),
                Classification::Unrecordable(reason.to_string()),
                "{line:?}"
            );
        }
    }

    #[test]
    fn other_commands_are_not_computation_commands() {
        for line in [
            "",
            "   ",
            "ls -la",
            "echo python q1.py",
            "cd code && python q1.py",
            "cat q1.py | python3",
            "sudo python q1.py",
            "env X=1 python q1.py",
            "time python q1.py",
            "(python q1.py)",
            "pip install numpy",
            "pythonw q1.py",
            "python-config --libs",
            "uv sync",
            "uv pip install numpy",
            "uv run pytest",
        ] {
            assert_eq!(
                classify(line, Syntax::Posix),
                Classification::Other,
                "{line:?}"
            );
        }
        for line in [
            r#"& "C:\Python312\python.exe" q1.py"#,
            "X=1 python q1.py",
            "dir",
        ] {
            assert_eq!(
                classify(line, Syntax::Windows),
                Classification::Other,
                "{line:?}"
            );
        }
    }

    #[test]
    fn quotes_group_words_and_redirections_are_dropped() {
        assert_eq!(
            split_words(r#"python3 "a b" 'c "d"' e\ f "g\"h" """#, Syntax::Posix).words,
            ["python3", "a b", "c \"d\"", "e f", "g\"h", ""]
        );
        assert_eq!(
            split_words(r#"python "C:\dir\q1.py" 'x y'"#, Syntax::Windows).words,
            ["python", r"C:\dir\q1.py", "x y"]
        );
        let redirected = split_words(
            "python3 q1.py 2>&1 >out.txt 2> err.log < in.csv &>all.log >&2 arg",
            Syntax::Posix,
        );
        assert_eq!(redirected.words, ["python3", "q1.py", "arg"]);
        assert_eq!(redirected.problem, None);
    }

    #[test]
    fn process_ends_map_to_run_outcomes() {
        assert_eq!(
            run_outcome(false, false, Some(0), None),
            RunOutcome::Exited(0)
        );
        assert_eq!(
            run_outcome(false, false, Some(3), None),
            RunOutcome::Exited(3)
        );
        assert_eq!(
            run_outcome(false, false, None, Some(9)),
            RunOutcome::Exited(137)
        );
        assert_eq!(run_outcome(false, false, None, None), RunOutcome::Exited(1));
        assert_eq!(run_outcome(true, false, None, None), RunOutcome::TimedOut);
        assert_eq!(
            run_outcome(false, true, None, Some(9)),
            RunOutcome::Cancelled
        );
    }

    #[test]
    fn the_run_start_names_the_run_and_the_tool_call() {
        const RUN_ID: &str = "20260920T101530123-a1b2c3";
        let params = |tool_call_id: Option<&str>| {
            let ServerNotification::CustomNotification(notification) =
                run_started_notification(RUN_ID, tool_call_id)
            else {
                panic!("expected a custom notification");
            };
            assert_eq!(notification.method, RUN_STARTED_NOTIFICATION);
            notification.params
        };
        assert_eq!(
            params(Some("call_1")),
            Some(json!({ "runId": RUN_ID, "toolCallId": "call_1", "declaredOutputs": [] }))
        );
        assert_eq!(
            params(None),
            Some(json!({ "runId": RUN_ID, "declaredOutputs": [] }))
        );
    }

    // goose depends on goose-mcp only for tests, so the shared name is checked here.
    #[test]
    fn the_result_key_is_the_one_run_script_uses() {
        assert_eq!(RUN_META_KEY, goose_mcp::modeling::run_script::RUN_META_KEY);
    }

    #[test]
    fn probe_output_is_parsed() {
        let pip = "WARNING: something\n[{\"name\": \"numpy\", \"version\": \"2.1.0\"}]\n";
        assert_eq!(
            parse_pip_json(pip),
            Some(vec![Dependency {
                name: "numpy".to_string(),
                version: "2.1.0".to_string()
            }])
        );
        assert_eq!(parse_tab_separated("base\t4.3.1\nstats\t4.3.1\n").len(), 2);
        let python = Interpreter::Python("python3".to_string());
        assert!(describe_runtime(&python, Some("Python 3.12.1".to_string()))
            .starts_with("Python 3.12.1 ("));
        assert!(
            describe_runtime(&Interpreter::Matlab("matlab".to_string()), None)
                .starts_with("matlab (")
        );
    }

    /// A Project with `data/in.csv`, an empty `results/` and `job.py`, which reads the input.
    fn project() -> tempfile::TempDir {
        let project = tempfile::tempdir().unwrap();
        fs::create_dir_all(project.path().join("data")).unwrap();
        fs::create_dir_all(project.path().join("results")).unwrap();
        fs::write(project.path().join("data").join("in.csv"), "x\n1\n").unwrap();
        fs::write(
            project.path().join("job.py"),
            "open(\"data/in.csv\")\nopen('results/out.txt', 'w').write('result')\n",
        )
        .unwrap();
        project
    }

    fn source() -> RunSource {
        RunSource {
            tool_call_id: Some("call_1".to_string()),
            sessions: None,
            secrets: Arc::new(NoSecretValues),
        }
    }

    /// One Credential_Store entry, as the Kernel's source would supply it.
    struct OneSecret;

    impl SecretValues for OneSecret {
        fn secret_values(&self) -> Vec<SecretValue> {
            vec![SecretValue {
                reference: "${secret:deepseek_api_key}".to_string(),
                value: "sk-shell-secret-0123456789".to_string(),
            }]
        }
    }

    fn paths(files: &[FileHash]) -> Vec<&str> {
        files.iter().map(|file| file.path.as_str()).collect()
    }

    fn read_record(project: &Path, run_id: &str) -> RunRecord {
        let path = runs_dir(project).join(format!("{run_id}.json"));
        RunRecord::from_json(&fs::read_to_string(path).unwrap()).unwrap()
    }

    fn run_of(result: &CallToolResult) -> Value {
        result
            .meta
            .as_ref()
            .and_then(|meta| meta.0.get(RUN_META_KEY))
            .cloned()
            .expect("the result names its run")
    }

    #[tokio::test]
    async fn only_computation_commands_touch_the_project() {
        let project = project();
        assert!(matches!(
            prepare("ls -la", project.path(), None, source()).await,
            PreparedRun::Skip
        ));
        let PreparedRun::Unrecorded(reason) =
            prepare("python3 missing.py", project.path(), None, source()).await
        else {
            panic!("a missing code file is not recorded");
        };
        assert_eq!(reason, "missing.py is not a file inside the Project");
        assert!(!project.path().join(".modelforge").exists());
    }

    #[tokio::test]
    async fn the_report_carries_the_record_it_waited_for() {
        let project = project();
        let PreparedRun::Record(run) =
            prepare("python3 job.py", project.path(), None, source()).await
        else {
            panic!("expected a recorded run");
        };
        let run = *run;
        // What the code would have written.
        fs::write(project.path().join("results").join("out.txt"), "result").unwrap();
        let probes = Probes {
            started: Instant::now(),
            runtime: ProbeTask(tokio::spawn(async { Some("Python 3.99.0".to_string()) })),
            dependencies: ProbeTask(tokio::spawn(async {
                Some(vec![Dependency {
                    name: "numpy".to_string(),
                    version: "2.1.0".to_string(),
                }])
            })),
        };
        let report = run.finish(Some(RunOutcome::Exited(3)), probes).await;
        let mut result = CallToolResult::error(vec![ContentBlock::text("output")]);
        report.attach(&mut result);

        let run = run_of(&result);
        let run_id = run["runId"].as_str().expect("a run id").to_string();
        assert!(is_run_id(&run_id));
        assert_eq!(
            run,
            json!({
                "runId": run_id,
                "recordPath": format!(".modelforge/runs/{run_id}.json"),
                "exitCode": 3,
                "failure": "非零退出码",
                "outputs": ["results/out.txt"],
            })
        );

        let record = read_record(project.path(), &run_id);
        assert_eq!(record.command, "python3 job.py");
        assert_eq!(record.code.path, "job.py");
        assert_eq!(paths(&record.inputs), ["data/in.csv"]);
        assert_eq!(paths(&record.outputs), ["results/out.txt"]);
        assert_eq!(record.exit_code, Some(3));
        assert_eq!(record.failure, Some(RunFailure::NonZeroExit));
        assert_eq!(record.seed, SEED_UNSET);
        assert_eq!(record.config.provider, CONFIG_UNKNOWN);
        assert_eq!(record.config.model, CONFIG_UNKNOWN);
        assert!(record.config.runtime.starts_with("Python 3.99.0 ("));
        assert_eq!(record.dependencies.len(), 1);

        assert_eq!(result.content.len(), 2);
        let ContentBlock::Text(text) = &result.content[1] else {
            panic!("expected the report as text");
        };
        assert!(
            text.text.starts_with(&format!(
                "Run_Record: .modelforge/runs/{run_id}.json (run {run_id} failed with exit code 3"
            )),
            "{}",
            text.text
        );
    }

    #[tokio::test]
    async fn credential_values_in_the_command_are_replaced_in_the_record() {
        let project = project();
        let source = RunSource {
            secrets: Arc::new(OneSecret),
            ..source()
        };
        let PreparedRun::Record(run) = prepare(
            "python3 job.py --token sk-shell-secret-0123456789",
            project.path(),
            None,
            source,
        )
        .await
        else {
            panic!("expected a recorded run");
        };
        let run = *run;
        let probes = Probes {
            started: Instant::now(),
            runtime: ProbeTask(tokio::spawn(async { None })),
            dependencies: ProbeTask(tokio::spawn(async { Some(Vec::new()) })),
        };
        let report = run.finish(Some(RunOutcome::Exited(0)), probes).await;
        let mut result = CallToolResult::success(vec![ContentBlock::text("output")]);
        report.attach(&mut result);

        let run_id = run_of(&result)["runId"]
            .as_str()
            .expect("a run id")
            .to_string();
        let text =
            fs::read_to_string(runs_dir(project.path()).join(format!("{run_id}.json"))).unwrap();
        assert!(!text.contains("sk-shell-secret-0123456789"), "{text}");
        assert_eq!(
            read_record(project.path(), &run_id).command,
            "python3 job.py --token ${secret:deepseek_api_key}"
        );
    }

    /// A stand-in `python` inside the Project, so the tests run without one: it prints a version,
    /// writes `results/out.txt` and exits 3 for `job.py`, sleeps for `slow.py` and fails for
    /// anything else (such as the package probes).
    #[cfg(not(windows))]
    const FAKE_PYTHON: (&str, &str) = (
        "tools/python",
        "#!/bin/sh\n\
         case \"$1\" in\n\
         --version) echo 'Python 3.99.0'; exit 0 ;;\n\
         job.py) echo result > results/out.txt; exit 3 ;;\n\
         slow.py) sleep 5; exit 0 ;;\n\
         esac\n\
         exit 1\n",
    );
    #[cfg(windows)]
    const FAKE_PYTHON: (&str, &str) = (
        r"tools\python.cmd",
        "@echo off\r\n\
         if \"%~1\"==\"--version\" (echo Python 3.99.0& exit /b 0)\r\n\
         if \"%~1\"==\"job.py\" (echo result> results\\out.txt& exit /b 3)\r\n\
         if \"%~1\"==\"slow.py\" (ping -n 6 127.0.0.1 >nul& exit /b 0)\r\n\
         exit /b 1\r\n",
    );

    /// Installs [`FAKE_PYTHON`] and returns the program to put in front of a command.
    fn install_fake_python(project: &Path) -> &'static str {
        let (program, script) = FAKE_PYTHON;
        let path = project.join(program);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        program
    }

    fn client(sessions: &Path) -> DeveloperClient {
        DeveloperClient::new(PlatformExtensionContext {
            extension_manager: None,
            session_manager: Arc::new(SessionManager::new(sessions.to_path_buf())),
            scheduler: None,
            session: None,
            use_login_shell_path: false,
        })
        .unwrap()
    }

    #[tokio::test]
    async fn a_python_command_in_the_project_gets_a_run_record() {
        let project = project();
        let sessions = tempfile::tempdir().unwrap();
        let command = format!("{} job.py", install_fake_python(project.path()));
        let (sender, mut receiver) = tokio::sync::mpsc::channel(64);
        let ctx = ToolCallContext::new(
            "session".to_string(),
            Some(project.path().to_path_buf()),
            Some("call_1".to_string()),
        )
        .with_notification_emitter(ToolCallNotificationEmitter::new(sender));

        let result = client(sessions.path())
            .call_tool(
                &ctx,
                "shell",
                Some(object!({ "command": command.clone() })),
                CancellationToken::new(),
            )
            .await
            .unwrap();

        assert_eq!(result.is_error, Some(true));
        let run = run_of(&result);
        let run_id = run["runId"].as_str().expect("a run id").to_string();
        assert_eq!(
            run,
            json!({
                "runId": run_id,
                "recordPath": record_path(&run_id),
                "exitCode": 3,
                "failure": "非零退出码",
                "outputs": ["results/out.txt"],
            })
        );
        let record = read_record(project.path(), &run_id);
        assert_eq!(record.command, command);
        assert_eq!(record.code.path, "job.py");
        assert!(paths(&record.inputs).contains(&"data/in.csv"));
        assert_eq!(record.exit_code, Some(3));
        assert!(
            record.config.runtime.starts_with("Python 3.99.0"),
            "{}",
            record.config.runtime
        );

        let started: Vec<Value> = std::iter::from_fn(|| receiver.try_recv().ok())
            .filter_map(|notification| match notification {
                ServerNotification::CustomNotification(notification)
                    if notification.method == RUN_STARTED_NOTIFICATION =>
                {
                    notification.params
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            started,
            [json!({ "runId": run_id, "toolCallId": "call_1", "declaredOutputs": [] })]
        );
    }

    #[tokio::test]
    async fn a_cancelled_command_is_recorded_as_cancelled() {
        let project = project();
        fs::write(
            project.path().join("slow.py"),
            "import time\ntime.sleep(5)\n",
        )
        .unwrap();
        let sessions = tempfile::tempdir().unwrap();
        let command = format!("{} slow.py", install_fake_python(project.path()));
        let ctx = ToolCallContext::new(
            "session".to_string(),
            Some(project.path().to_path_buf()),
            None,
        );
        let token = CancellationToken::new();
        let canceller = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            canceller.cancel();
        });

        let started = std::time::Instant::now();
        let result = client(sessions.path())
            .call_tool(&ctx, "shell", Some(object!({ "command": command })), token)
            .await
            .unwrap();

        assert!(started.elapsed() < Duration::from_secs(10));
        let run = run_of(&result);
        assert_eq!(run["exitCode"], Value::Null);
        assert_eq!(run["failure"], json!("用户取消"));
        let record = read_record(project.path(), run["runId"].as_str().expect("a run id"));
        assert_eq!(record.exit_code, None);
        assert_eq!(record.failure, Some(RunFailure::Cancelled));
    }

    #[tokio::test]
    async fn other_shell_commands_are_left_alone() {
        let project = project();
        let sessions = tempfile::tempdir().unwrap();
        let program = install_fake_python(project.path());
        let ctx = ToolCallContext::new(
            "session".to_string(),
            Some(project.path().to_path_buf()),
            None,
        );
        let client = client(sessions.path());

        let plain = client
            .call_tool(
                &ctx,
                "shell",
                Some(object!({ "command": "echo hello" })),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(plain.is_error, Some(false));
        assert_eq!(plain.content.len(), 1);
        assert!(plain.meta.is_none());

        let inline = client
            .call_tool(
                &ctx,
                "shell",
                Some(object!({ "command": format!("{program} -c pass") })),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(inline.meta.is_none());
        let Some(ContentBlock::Text(note)) = inline.content.last() else {
            panic!("expected the note as text");
        };
        assert_eq!(
            note.text,
            format!("No Run_Record was written: {INLINE_CODE}.")
        );
        assert!(!project.path().join(".modelforge").exists());
    }
}
