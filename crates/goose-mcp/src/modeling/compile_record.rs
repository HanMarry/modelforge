//! Run_Records of `compile_latex` (spec mathmodel-parity-and-beyond, requirements 13.1, 16.1,
//! 16.3, 16.6): a compilation inside the Project is recorded the way `run_script` records a run,
//! so the paper PDF it produces becomes 已生成 on the desktop and traces back to its sources.
//!
//! - The code is the main `.tex` or `.typ` file and the inputs are the files it pulls in
//!   ([`paper_sources`]). The only output is the PDF, declared, so the auxiliary files the
//!   compiler writes (`.aux`, `.log`, `.fdb_latexmk`, …) do not count.
//! - The run ends the way a `run_script` run does: exit code 0, a non-zero exit code
//!   (非零退出码), the time limit (超时) or a cancellation (用户取消). An invalid or partial PDF
//!   is removed before the record is written, so a compiler that exits 0 without a usable PDF
//!   leaves a record with exit code 0 and no output, and the tool reports the failure.
//! - The record is on disk before the tool returns. The start is announced with
//!   `modelforge/run_started`, the PDF as declared output, and the result carries
//!   `_meta["modelforge/run"]`; goose turns them into `runs/started` and `runs/finished`.
//! - A document outside the Project, or a PDF that would land outside it, is compiled as before
//!   without a record, and the result says why.

use std::collections::{HashSet, VecDeque};
use std::future::Future;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime};

use rmcp::model::{CallToolResult, ContentBlock, ErrorData, MetaObject};
use tokio::time::Instant;

use super::run_record::MAX_RECORDED_FILES;
use super::run_recorder::{
    FinishedRun, ProbedEnvironment, RunHandle, RunOutcome, RunRecorder, RunSpec, CONFIG_UNKNOWN,
};
use super::run_script::{
    self, declared_output_path, run_meta, run_started_notice, send_run_started, supervise,
    ProbeTask, RunContext, RunIntegration, StopRequest, Supervised, RUN_META_KEY,
};
use super::{extract_errors, tail, validate_pdf, CompileCommand};
use crate::subprocess::SubprocessExt;

/// A compilation still running after this long is stopped and recorded as 超时.
const COMPILE_TIMEOUT: Duration = Duration::from_secs(180);
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// A version probe still running this long after the compiler ended is given up.
const PROBE_GRACE_AFTER_RUN: Duration = Duration::from_secs(3);
const LOG_TAIL_LINES: usize = 40;
/// Extensions `\includegraphics` tries, in this order, for a name without one of them.
const GRAPHICS_EXTENSIONS: &[&str] = &[".pdf", ".png", ".jpg", ".jpeg", ".eps"];
/// Typst functions whose first argument, a string literal, names a file the document reads.
const TYPST_LOADERS: &[&str] = &[
    "image",
    "bibliography",
    "read",
    "csv",
    "json",
    "yaml",
    "toml",
    "xml",
    "cbor",
];
/// Source files searched for further references, for a document that includes itself in a loop
/// or pulls in a whole tree.
const MAX_SCANNED_SOURCES: usize = 256;
/// Only the start of a very large source is searched.
const MAX_SOURCE_BYTES: u64 = 4 * 1024 * 1024;

/// Compiles the document of `command` and, when it is inside the Project, records the
/// compilation before returning. `stop` resolves when the caller cancels.
pub(super) async fn execute(
    command: CompileCommand,
    context: RunContext,
    integration: &RunIntegration,
    stop: impl Future<Output = StopRequest>,
) -> Result<CallToolResult, ErrorData> {
    let program = command.program.clone();
    // A stale PDF from an earlier run must not pass as this run's product: drop it up front and
    // remember the start time, so validate_pdf can require a fresh file.
    let started_at = SystemTime::now();
    let _ = std::fs::remove_file(&command.pdf_path);

    let recording = begin_recording(&command, &context, integration).await;
    let probes_started = Instant::now();
    let version = recording.is_ok().then(|| {
        ProbeTask(tokio::spawn(probe_version(
            program.clone(),
            command.cwd.clone(),
        )))
    });

    let child = match compiler_process(&command).spawn() {
        Ok(child) => child,
        Err(error) => {
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "Could not start {program}: {error}. Nothing ran, so no Run_Record was written."
            ))]));
        }
    };
    if let Ok(recording) = &recording {
        integration
            .observer
            .run_started(recording.recorder.project_root(), &recording.handle);
        if let Some(notifier) = &context.notifier {
            let notice = run_started_notice(
                recording.handle.run_id(),
                context.tool_call_id.as_deref(),
                std::slice::from_ref(&recording.pdf),
            );
            send_run_started(notifier.as_ref(), notice).await;
        }
    }
    let supervised = supervise(child, COMPILE_TIMEOUT, stop).await;
    let ended = Instant::now();
    // Before the record hashes the output: an invalid PDF must not be recorded as the product.
    let (succeeded, mut text) = judge(&command, started_at, &supervised);

    let mut meta = None;
    match recording {
        Ok(recording) => {
            let runtime = match version {
                Some(probe) => probe
                    .finish_by(
                        (probes_started + VERSION_PROBE_TIMEOUT).min(ended + PROBE_GRACE_AFTER_RUN),
                    )
                    .await
                    .flatten(),
                None => None,
            };
            let environment = ProbedEnvironment {
                runtime: describe_runtime(&program, runtime),
                dependencies: Vec::new(),
            };
            let outcome = supervised.outcome;
            let Recording {
                recorder, handle, ..
            } = recording;
            let run_id = handle.run_id().to_string();
            let root = recorder.project_root().to_path_buf();
            let finished =
                tokio::task::spawn_blocking(move || recorder.finish(handle, outcome, environment))
                    .await;
            match finished {
                Ok(Ok(run)) => {
                    integration.observer.run_finished(&root, &run);
                    text.push_str("\n\n");
                    text.push_str(&describe_record(&run, outcome, supervised.note.as_deref()));
                    meta = Some(run_meta(&run.record));
                }
                Ok(Err(error)) => text.push_str(&format!(
                    "\n\nNo Run_Record was written: run {run_id} ended but its record could not \
                     be written: {error:#}."
                )),
                Err(error) => text.push_str(&format!(
                    "\n\nNo Run_Record was written: run {run_id} ended but the recorder task \
                     failed: {error}."
                )),
            }
        }
        Err(reason) => text.push_str(&format!("\n\nNo Run_Record was written: {reason}.")),
    }

    let content = vec![ContentBlock::text(text)];
    let result = if succeeded {
        CallToolResult::success(content)
    } else {
        CallToolResult::error(content)
    };
    Ok(match meta {
        Some(run) => {
            let mut object = MetaObject::new();
            object.0.insert(RUN_META_KEY.to_string(), run);
            result.with_meta(Some(object))
        }
        None => result,
    })
}

/// A compilation between [`RunRecorder::begin`] and [`RunRecorder::finish`].
struct Recording {
    recorder: RunRecorder,
    handle: RunHandle,
    /// The PDF, Project-relative.
    pdf: String,
}

/// Hashes the document and its sources, or says why the compilation is not recorded.
async fn begin_recording(
    command: &CompileCommand,
    context: &RunContext,
    integration: &RunIntegration,
) -> Result<Recording, String> {
    let root = context.project_root.clone();
    let secrets = integration.secrets.clone();
    let source = command.source.clone();
    let pdf_path = command.pdf_path.clone();
    let line = command.command_line();
    let provider = context
        .provider
        .clone()
        .unwrap_or_else(|| CONFIG_UNKNOWN.to_string());
    let model = context
        .model
        .clone()
        .unwrap_or_else(|| CONFIG_UNKNOWN.to_string());
    let begun = tokio::task::spawn_blocking(move || -> Result<Recording, String> {
        let recorder = RunRecorder::new(&root, secrets).map_err(|error| format!("{error:#}"))?;
        let code = recorder.project_file(&source).ok_or_else(|| {
            format!(
                "{} is not a file inside the Project {}",
                source.display(),
                recorder.project_root().display()
            )
        })?;
        let pdf = declared_output_path(&recorder, &pdf_path).ok_or_else(|| {
            format!(
                "the PDF {} would be written outside the Project {}",
                pdf_path.display(),
                recorder.project_root().display()
            )
        })?;
        let pdf_file = PathBuf::from(&pdf);
        let mut inputs = paper_sources(&recorder, &source);
        inputs.retain(|input| *input != pdf_file);
        let handle = recorder
            .begin(RunSpec {
                command: line,
                code: PathBuf::from(code),
                inputs: Some(inputs),
                outputs: Some(vec![pdf_file]),
                seed: None,
                provider,
                model,
            })
            .map_err(|error| format!("{error:#}"))?;
        Ok(Recording {
            recorder,
            handle,
            pdf,
        })
    })
    .await;
    begun.unwrap_or_else(|error| Err(format!("the recorder task failed: {error}")))
}

fn compiler_process(command: &CompileCommand) -> tokio::process::Command {
    let mut process = tokio::process::Command::new(&command.program);
    process
        .args(&command.args)
        .current_dir(&command.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .set_no_window();
    // Own process group on Unix, so a timeout or cancellation also kills the engines latexmk
    // starts.
    #[cfg(unix)]
    process.process_group(0);
    process
}

/// Whether the compilation produced a valid PDF, and what the tool says about it. An invalid or
/// partial PDF is removed, so the record never lists it and no later run mistakes it for its
/// product.
fn judge(
    command: &CompileCommand,
    started_at: SystemTime,
    supervised: &Supervised,
) -> (bool, String) {
    let program = &command.program;
    let log = format!("{}\n{}", supervised.stdout, supervised.stderr);
    if supervised.outcome == RunOutcome::Exited(0) {
        return match validate_pdf(&command.pdf_path, started_at) {
            Ok(()) => (
                true,
                format!(
                    "Compiled successfully with {program}.\n\nOutput: {}",
                    command.pdf_path.display()
                ),
            ),
            Err(error) => {
                let _ = std::fs::remove_file(&command.pdf_path);
                (
                    false,
                    format!(
                        "{program} exited with code 0 but did not produce a valid PDF at {}: \
                         {error}\n\nLog tail:\n{}",
                        command.pdf_path.display(),
                        tail(&log, LOG_TAIL_LINES)
                    ),
                )
            }
        };
    }

    // Failed, timed out or cancelled: drop any partial product as well.
    let _ = std::fs::remove_file(&command.pdf_path);
    let mut message = match supervised.outcome {
        RunOutcome::TimedOut => format!(
            "Compilation with {program} was stopped by the time limit of {} seconds (超时).\n\n",
            COMPILE_TIMEOUT.as_secs()
        ),
        RunOutcome::Cancelled => {
            format!("Compilation with {program} was cancelled (用户取消).\n\n")
        }
        RunOutcome::Exited(_) => format!("Compilation failed with {program}.\n\n"),
    };
    let errors = extract_errors(&log);
    if errors.is_empty() {
        message.push_str("No parseable error lines found. Raw log tail:\n\n");
        message.push_str(&tail(&log, LOG_TAIL_LINES));
    } else {
        message.push_str("Errors:\n\n");
        for error in errors {
            message.push_str(&format!("{error}\n"));
        }
    }
    (false, message)
}

fn describe_outcome(outcome: RunOutcome) -> String {
    match outcome {
        RunOutcome::Exited(0) => "finished with exit code 0".to_string(),
        RunOutcome::Exited(code) => format!("failed with exit code {code} (非零退出码)"),
        RunOutcome::TimedOut => format!(
            "was stopped by the time limit of {} seconds (超时)",
            COMPILE_TIMEOUT.as_secs()
        ),
        RunOutcome::Cancelled => "was cancelled (用户取消)".to_string(),
    }
}

/// The part of the result that names the record, after the compiler's own report.
fn describe_record(run: &FinishedRun, outcome: RunOutcome, note: Option<&str>) -> String {
    let record = &run.record;
    let mut text = format!(
        "Run_Record: .modelforge/runs/{}.json (run {} {}; code {})\n",
        record.run_id,
        record.run_id,
        describe_outcome(outcome),
        record.code.path,
    );
    let inputs: Vec<&str> = record
        .inputs
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    let outputs: Vec<&str> = record
        .outputs
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    run_script::push_paths(&mut text, "Inputs", &inputs, record.inputs_truncated);
    run_script::push_paths(&mut text, "Outputs", &outputs, record.outputs_truncated);
    let notes: Vec<&str> = note
        .into_iter()
        .chain(run.notes.iter().map(String::as_str))
        .collect();
    if !notes.is_empty() {
        text.push_str("Notes:\n");
        for note in notes {
            text.push_str(&format!("  - {note}\n"));
        }
    }
    text.trim_end().to_string()
}

/// The first line `--version` (`-version` for latexmk) prints.
async fn probe_version(program: String, cwd: PathBuf) -> Option<String> {
    let flag = if program == "latexmk" {
        "-version"
    } else {
        "--version"
    };
    let (stdout, stderr) =
        run_script::probe(&program, &[flag], &cwd, VERSION_PROBE_TIMEOUT).await?;
    run_script::first_line(&stdout).or_else(|| run_script::first_line(&stderr))
}

/// The version line when there is one, the compiler name otherwise, plus the platform.
fn describe_runtime(program: &str, version: Option<String>) -> String {
    let base = match version {
        Some(line) if line.to_lowercase().contains(&program.to_lowercase()) => line,
        Some(line) => format!("{program} {line}"),
        None => program.to_string(),
    };
    format!(
        "{base} ({}-{})",
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

// --- the sources of a document -----------------------------------------------------------------

/// Files a compilation of `main` reads besides `main` itself, Project-relative, in the order
/// they are found, at most [`MAX_RECORDED_FILES`]. The rules follow the desktop's paper check
/// (`ui/desktop/src/utils/paperCheck/pdfFreshness.ts`):
///
/// - LaTeX, relative to the main file's directory, where the engine runs: `\input` (also
///   without braces), `\include`, `\subfile` and `\InputIfFileExists` with `.tex` tried first;
///   `\includegraphics` with `.pdf`, `.png`, `.jpg`, `.jpeg`, `.eps` tried first, in the main
///   file's directory and then in each `\graphicspath` entry; `\includesvg`; `\bibliography`
///   (`.bib`) and `\addbibresource`; local classes, packages and bibliography styles
///   (`\documentclass`, `\LoadClass`, `\usepackage`, `\RequirePackage`, `\bibliographystyle`).
///   Comments are ignored, and targets with `\` or `#` are macros and skipped. Included `.tex`,
///   `.cls` and `.sty` files are searched too.
/// - Typst, relative to the file that names them, or to the main file's directory (the Typst
///   root) for a path starting with `/`: `include` and `import` (packages such as
///   `@preview/…` are not files), and the first string argument of `image`, `bibliography`,
///   `read`, `csv`, `json`, `yaml`, `toml`, `xml` and `cbor`. Included `.typ` files are
///   searched too.
///
/// Only existing files inside the Project count; the rest is a TeX distribution package, a
/// file outside the Project or a typo, and the record cannot vouch for it.
pub(super) fn paper_sources(recorder: &RunRecorder, main: &Path) -> Vec<PathBuf> {
    let Some(main_dir) = main.parent() else {
        return Vec::new();
    };
    let typst = has_extension(main, &["typ"]);
    let mut sources = SourceSet::new(recorder, main);
    let mut pending = VecDeque::from([main.to_path_buf()]);
    let mut graphics_dirs = vec![main_dir.to_path_buf()];
    let mut figures: Vec<LatexReference> = Vec::new();
    let mut scanned = 0;
    while let Some(file) = pending.pop_front() {
        if scanned == MAX_SCANNED_SOURCES {
            break;
        }
        scanned += 1;
        let text = read_source(&file);
        if typst {
            let dir = file.parent().unwrap_or(main_dir);
            for reference in typst_references(&text) {
                let path = match reference.target.strip_prefix('/') {
                    Some(rooted) => main_dir.join(rooted),
                    None => dir.join(&reference.target),
                };
                if sources.visit(&path) == Some(true)
                    && reference.follow
                    && has_extension(&path, &["typ"])
                {
                    pending.push_back(path);
                }
            }
            continue;
        }
        for reference in latex_references(&text) {
            match reference.kind {
                LatexKind::GraphicsPath => {
                    let dir = main_dir.join(&reference.target);
                    if !graphics_dirs.contains(&dir) {
                        graphics_dirs.push(dir);
                    }
                }
                // Resolved once every `\graphicspath` is known.
                LatexKind::Graphics | LatexKind::Svg => figures.push(reference),
                kind => {
                    for name in latex_candidates(kind, &reference.target) {
                        let path = main_dir.join(&name);
                        if let Some(new) = sources.visit(&path) {
                            if new && has_extension(&path, &["tex", "cls", "sty"]) {
                                pending.push_back(path);
                            }
                            break;
                        }
                    }
                }
            }
        }
    }
    // Each candidate name in the main file's directory first, then in the `\graphicspath`
    // entries, as graphicx searches.
    'figures: for figure in &figures {
        for name in latex_candidates(figure.kind, &figure.target) {
            for dir in &graphics_dirs {
                if sources.visit(&dir.join(&name)).is_some() {
                    continue 'figures;
                }
            }
        }
    }
    sources.found
}

/// The sources found so far, each once.
struct SourceSet<'a> {
    recorder: &'a RunRecorder,
    seen: HashSet<String>,
    found: Vec<PathBuf>,
}

impl<'a> SourceSet<'a> {
    fn new(recorder: &'a RunRecorder, main: &Path) -> Self {
        let mut seen = HashSet::new();
        if let Some(relative) = recorder.project_file(main) {
            seen.insert(relative);
        }
        Self {
            recorder,
            seen,
            found: Vec::new(),
        }
    }

    /// `None` when `path` is not a file inside the Project; otherwise whether it is new, in
    /// which case it is added.
    fn visit(&mut self, path: &Path) -> Option<bool> {
        let relative = self.recorder.project_file(path)?;
        let new = self.seen.insert(relative.clone());
        if new && self.found.len() < MAX_RECORDED_FILES {
            self.found.push(PathBuf::from(relative));
        }
        Some(new)
    }
}

fn has_extension(path: &Path, extensions: &[&str]) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extensions
                .iter()
                .any(|candidate| extension.eq_ignore_ascii_case(candidate))
        })
}

fn read_source(path: &Path) -> String {
    let mut bytes = Vec::new();
    if let Ok(file) = std::fs::File::open(path) {
        let _ = file.take(MAX_SOURCE_BYTES).read_to_end(&mut bytes);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LatexKind {
    /// `\input`, `\include`, `\subfile`, `\InputIfFileExists`.
    Source,
    /// `\includegraphics`.
    Graphics,
    /// `\includesvg`.
    Svg,
    /// `\bibliography{a,b}`.
    Bibliography,
    /// `\addbibresource{a.bib}`.
    Resource,
    /// `\documentclass`, `\LoadClass`.
    Class,
    /// `\usepackage{a,b}`, `\RequirePackage`.
    Package,
    /// `\bibliographystyle`.
    Style,
    /// One `\graphicspath` entry.
    GraphicsPath,
}

fn latex_kind(command: &str) -> Option<LatexKind> {
    Some(match command {
        "input" | "include" | "subfile" | "InputIfFileExists" => LatexKind::Source,
        "includegraphics" => LatexKind::Graphics,
        "includesvg" => LatexKind::Svg,
        "bibliography" => LatexKind::Bibliography,
        "addbibresource" => LatexKind::Resource,
        "documentclass" | "LoadClass" | "LoadClassWithOptions" => LatexKind::Class,
        "usepackage" | "RequirePackage" | "RequirePackageWithOptions" => LatexKind::Package,
        "bibliographystyle" => LatexKind::Style,
        "graphicspath" => LatexKind::GraphicsPath,
        _ => return None,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LatexReference {
    kind: LatexKind,
    /// As written, without TeX quotes.
    target: String,
}

/// The file names LaTeX tries for a reference, in order, before a directory is applied.
fn latex_candidates(kind: LatexKind, target: &str) -> Vec<String> {
    let lower = target.to_ascii_lowercase();
    let added = |extension: &str| format!("{target}{extension}");
    match kind {
        LatexKind::Source if lower.ends_with(".tex") => vec![target.to_string()],
        LatexKind::Source => vec![added(".tex"), target.to_string()],
        LatexKind::Svg if lower.ends_with(".svg") => vec![target.to_string()],
        LatexKind::Svg => vec![added(".svg"), target.to_string()],
        LatexKind::Graphics
            if GRAPHICS_EXTENSIONS
                .iter()
                .any(|extension| lower.ends_with(extension)) =>
        {
            vec![target.to_string()]
        }
        LatexKind::Graphics => GRAPHICS_EXTENSIONS
            .iter()
            .map(|extension| format!("{target}{extension}"))
            .chain(std::iter::once(target.to_string()))
            .collect(),
        LatexKind::Bibliography if lower.ends_with(".bib") => vec![target.to_string()],
        LatexKind::Bibliography => vec![added(".bib")],
        LatexKind::Resource => vec![target.to_string()],
        LatexKind::Class => vec![added(".cls")],
        LatexKind::Package => vec![added(".sty")],
        LatexKind::Style if lower.ends_with(".bst") => vec![target.to_string()],
        LatexKind::Style => vec![added(".bst")],
        LatexKind::GraphicsPath => Vec::new(),
    }
}

/// The text without comments: from an unescaped `%` to the end of its line.
fn strip_latex_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let mut end = line.len();
        let mut escaped = false;
        for (index, ch) in line.char_indices() {
            if ch == '%' && !escaped {
                end = index;
                break;
            }
            escaped = ch == '\\' && !escaped;
        }
        out.push_str(line.get(..end).unwrap_or(line));
        out.push('\n');
    }
    out
}

/// The file references of LaTeX source, in order of appearance.
fn latex_references(text: &str) -> Vec<LatexReference> {
    let source = strip_latex_comments(text);
    let bytes = source.as_bytes();
    let mut references = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'\\' {
            index += 1;
            continue;
        }
        let name_start = index + 1;
        let mut name_end = name_start;
        while bytes
            .get(name_end)
            .is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'@')
        {
            name_end += 1;
        }
        if name_end == name_start {
            // `\\`, `\%`, `\{`: an escaped character, skipped together with its backslash.
            index = name_start + 1;
            continue;
        }
        index = name_end;
        let Some(kind) = source.get(name_start..name_end).and_then(latex_kind) else {
            continue;
        };
        let mut cursor = name_end;
        if bytes.get(cursor) == Some(&b'*') {
            cursor += 1;
        }
        cursor = skip_options(bytes, cursor);
        if let Some((start, end)) = read_group(bytes, cursor, b'{', b'}') {
            index = end + 1;
            if let Some(content) = source.get(start..end) {
                push_latex_targets(kind, content, &mut references);
            }
        } else if kind == LatexKind::Source {
            // `\input sec/intro`, the TeX primitive form without braces.
            let start = skip_whitespace(bytes, cursor);
            let mut end = start;
            while bytes.get(end).is_some_and(|byte| {
                !byte.is_ascii_whitespace() && !matches!(*byte, b'{' | b'}' | b'%' | b'\\')
            }) {
                end += 1;
            }
            if let Some(target) = source.get(start..end) {
                push_target(kind, target, &mut references);
            }
            index = index.max(end);
        }
    }
    references
}

fn push_latex_targets(kind: LatexKind, content: &str, references: &mut Vec<LatexReference>) {
    match kind {
        LatexKind::GraphicsPath => {
            // `\graphicspath{{figures/}{images/}}`
            let bytes = content.as_bytes();
            let mut cursor = skip_whitespace(bytes, 0);
            while let Some((start, end)) = read_group(bytes, cursor, b'{', b'}') {
                if let Some(entry) = content.get(start..end) {
                    push_target(kind, entry, references);
                }
                cursor = skip_whitespace(bytes, end + 1);
            }
        }
        LatexKind::Bibliography | LatexKind::Package => {
            for name in content.split(',') {
                push_target(kind, name, references);
            }
        }
        _ => push_target(kind, content, references),
    }
}

fn push_target(kind: LatexKind, raw: &str, references: &mut Vec<LatexReference>) {
    // Quotes keep names with spaces together: `\input{"my file"}`.
    let unquoted = raw.replace('"', "");
    let target = unquoted.trim();
    // Macros and macro parameters only name a file when the document is typeset.
    if target.is_empty() || target.contains(['\\', '#']) {
        return;
    }
    references.push(LatexReference {
        kind,
        target: target.to_string(),
    });
}

fn skip_whitespace(bytes: &[u8], mut index: usize) -> usize {
    while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
        index += 1;
    }
    index
}

/// Skips whitespace and `[…]` option groups.
fn skip_options(bytes: &[u8], index: usize) -> usize {
    let mut cursor = skip_whitespace(bytes, index);
    while let Some((_, end)) = read_group(bytes, cursor, b'[', b']') {
        cursor = skip_whitespace(bytes, end + 1);
    }
    cursor
}

/// The balanced `open … close` group starting at `start`, as the byte range of its content (the
/// closing delimiter is at the end of the range). A backslash escapes the byte after it.
fn read_group(bytes: &[u8], start: usize, open: u8, close: u8) -> Option<(usize, usize)> {
    if bytes.get(start) != Some(&open) {
        return None;
    }
    let mut depth = 0usize;
    let mut index = start;
    while let Some(&byte) = bytes.get(index) {
        if byte == b'\\' {
            index += 2;
            continue;
        }
        if byte == open {
            depth += 1;
        } else if byte == close {
            depth -= 1;
            if depth == 0 {
                return Some((start + 1, index));
            }
        }
        index += 1;
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TypstReference {
    /// The string literal, escapes decoded.
    target: String,
    /// `include` and `import` name Typst sources whose own references count.
    follow: bool,
}

/// The text without `//` and `/* */` comments; string literals are kept whole, and a comment's
/// line breaks stay, so the line structure does not change.
fn strip_typst_comments(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    let mut in_string = false;
    while let Some(&ch) = chars.get(index) {
        let next = chars.get(index + 1).copied();
        if in_string {
            out.push(ch);
            index += 1;
            match ch {
                '\\' => {
                    if let Some(escaped) = next {
                        out.push(escaped);
                        index += 1;
                    }
                }
                // Typst strings do not span lines; a stray quote in markup ends at the line.
                '"' | '\n' => in_string = false,
                _ => {}
            }
            continue;
        }
        match (ch, next) {
            ('"', _) => {
                in_string = true;
                out.push(ch);
                index += 1;
            }
            ('/', Some('/')) => {
                while chars.get(index).is_some_and(|inner| *inner != '\n') {
                    index += 1;
                }
            }
            ('/', Some('*')) => {
                index += 2;
                while let Some(&inner) = chars.get(index) {
                    if inner == '*' && chars.get(index + 1) == Some(&'/') {
                        index += 2;
                        break;
                    }
                    if inner == '\n' {
                        out.push('\n');
                    }
                    index += 1;
                }
            }
            _ => {
                out.push(ch);
                index += 1;
            }
        }
    }
    out
}

fn is_typst_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

/// The file references of Typst source, in order of appearance.
fn typst_references(text: &str) -> Vec<TypstReference> {
    let source = strip_typst_comments(text);
    let bytes = source.as_bytes();
    let mut references = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        // A word starts after a byte that cannot continue one; `x.image(` is a method call.
        let continues_word = index
            .checked_sub(1)
            .and_then(|before| bytes.get(before))
            .is_some_and(|byte| is_typst_word_byte(*byte) || *byte == b'.');
        if !is_typst_word_byte(bytes[index]) || continues_word {
            index += 1;
            continue;
        }
        let start = index;
        while bytes
            .get(index)
            .is_some_and(|byte| is_typst_word_byte(*byte))
        {
            index += 1;
        }
        let word = source.get(start..index).unwrap_or_default();
        let (follow, literal) = if word == "include" || word == "import" {
            (true, skip_whitespace(bytes, index))
        } else if TYPST_LOADERS.contains(&word) {
            let open = skip_whitespace(bytes, index);
            if bytes.get(open) != Some(&b'(') {
                continue;
            }
            (false, skip_whitespace(bytes, open + 1))
        } else {
            continue;
        };
        if let Some((target, after)) = read_typst_string(&source, literal) {
            index = after;
            // Package imports such as `@preview/cetz:0.3.0` are not files.
            if !target.is_empty() && !target.starts_with('@') {
                references.push(TypstReference { target, follow });
            }
        }
    }
    references
}

/// The string literal starting at `at`, decoded, and the index after its closing quote.
fn read_typst_string(source: &str, at: usize) -> Option<(String, usize)> {
    let rest = source.get(at..)?;
    if !rest.starts_with('"') {
        return None;
    }
    let mut value = String::new();
    let mut escaped = false;
    for (offset, ch) in rest.char_indices().skip(1) {
        if escaped {
            value.push(ch);
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '"' => return Some((value, at + offset + 1)),
            '\n' => return None,
            _ => value.push(ch),
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modeling::run_record::{runs_dir, RunFailure, RunRecord, SEED_UNSET};
    use crate::modeling::run_recorder::NoSecretValues;
    use crate::modeling::run_script::{CallNotifier, NotifyFuture};
    use rmcp::model::ServerNotification;
    use serde_json::json;
    use std::fs;
    use std::sync::{Arc, Mutex, PoisonError};

    fn write(root: &Path, relative: &str, text: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn recorder(project: &Path) -> RunRecorder {
        RunRecorder::new(project, Arc::new(NoSecretValues)).unwrap()
    }

    fn strings(paths: &[PathBuf]) -> Vec<String> {
        paths
            .iter()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .collect()
    }

    fn reference(kind: LatexKind, target: &str) -> LatexReference {
        LatexReference {
            kind,
            target: target.to_string(),
        }
    }

    #[test]
    fn latex_references_follow_the_commands_and_skip_comments() {
        let found = latex_references(
            r#"\documentclass[12pt]{mythesis}
\usepackage{amsmath, mystyle}
\graphicspath{{images/}{figs/}}
\begin{document}
\input{sec/intro} \input sec/method
\include{chap}
% \input{commented}
50\% done \input{"after percent"}
\\input{not-a-command}
\includegraphics[width=0.5\textwidth]{plot}
\includegraphics*{fig/scheme.png}
\includesvg{diagram}
\input{\jobname-extra}
\bibliography{refs,more}
\addbibresource{lib.bib}
\bibliographystyle{gbt7714}
\end{document}"#,
        );
        assert_eq!(
            found,
            vec![
                reference(LatexKind::Class, "mythesis"),
                reference(LatexKind::Package, "amsmath"),
                reference(LatexKind::Package, "mystyle"),
                reference(LatexKind::GraphicsPath, "images/"),
                reference(LatexKind::GraphicsPath, "figs/"),
                reference(LatexKind::Source, "sec/intro"),
                reference(LatexKind::Source, "sec/method"),
                reference(LatexKind::Source, "chap"),
                reference(LatexKind::Source, "after percent"),
                reference(LatexKind::Graphics, "plot"),
                reference(LatexKind::Graphics, "fig/scheme.png"),
                reference(LatexKind::Svg, "diagram"),
                reference(LatexKind::Bibliography, "refs"),
                reference(LatexKind::Bibliography, "more"),
                reference(LatexKind::Resource, "lib.bib"),
                reference(LatexKind::Style, "gbt7714"),
            ]
        );
    }

    #[test]
    fn latex_sources_resolve_inside_the_project() {
        let workspace = tempfile::tempdir().unwrap();
        let project = workspace.path().join("project");
        write(
            &project,
            "paper/main.tex",
            "\\documentclass{mythesis}\n\\usepackage{mystyle}\n\\graphicspath{{images/}}\n\
             \\input{sec/intro}\n\\includegraphics{plot}\n\\includegraphics{logo}\n\
             \\bibliography{refs,missing}\n\\input{../../outside}\n",
        );
        write(
            &project,
            "paper/mythesis.cls",
            "\\LoadClass{article}\\RequirePackage{inner}",
        );
        write(&project, "paper/inner.sty", "");
        write(&project, "paper/mystyle.sty", "\\includegraphics{badge}");
        // Relative to the main file's directory, where LaTeX runs, not to sec/.
        write(&project, "paper/sec/intro.tex", "\\input{sec/deeper}");
        write(&project, "paper/sec/deeper.tex", "x");
        write(&project, "paper/plot.pdf", "pdf");
        write(&project, "paper/images/plot.png", "png");
        write(&project, "paper/images/logo.png", "png");
        write(&project, "paper/badge.png", "png");
        write(&project, "paper/refs.bib", "@misc{x}");
        write(workspace.path(), "outside.tex", "outside the Project");
        let recorder = recorder(&project);

        assert_eq!(
            strings(&paper_sources(&recorder, &project.join("paper/main.tex"))),
            vec![
                "paper/mythesis.cls",
                "paper/mystyle.sty",
                "paper/sec/intro.tex",
                "paper/refs.bib",
                "paper/inner.sty",
                "paper/sec/deeper.tex",
                "paper/plot.pdf",
                "paper/images/logo.png",
                "paper/badge.png",
            ]
        );
    }

    #[test]
    fn typst_sources_resolve_relative_to_the_file_that_names_them() {
        let project = tempfile::tempdir().unwrap();
        write(
            project.path(),
            "main.typ",
            "#import \"@preview/cetz:0.3.0\": canvas\n#import \"template.typ\": conf\n\
             // #include \"ignored.typ\"\n/* #image(\"figs/hidden.png\") */\n\
             #include \"chapters/one.typ\"\n#figure(image(\"/figs/a.svg\"))\n\
             #bibliography(\"refs.bib\")\n#let data = csv(\"data/x.csv\")\n",
        );
        write(project.path(), "template.typ", "");
        write(project.path(), "ignored.typ", "");
        write(
            project.path(),
            "chapters/one.typ",
            "#image(\"../figs/b.png\")",
        );
        write(project.path(), "figs/a.svg", "svg");
        write(project.path(), "figs/b.png", "png");
        write(project.path(), "figs/hidden.png", "png");
        write(project.path(), "refs.bib", "@misc{x}");
        write(project.path(), "data/x.csv", "x\n1\n");
        let recorder = recorder(project.path());

        assert_eq!(
            strings(&paper_sources(&recorder, &project.path().join("main.typ"))),
            vec![
                "template.typ",
                "chapters/one.typ",
                "figs/a.svg",
                "refs.bib",
                "data/x.csv",
                "figs/b.png",
            ]
        );
    }

    #[test]
    fn typst_strings_keep_comment_markers() {
        assert_eq!(
            typst_references("#image(\"a//b.png\") // #image(\"c.png\")"),
            vec![TypstReference {
                target: "a//b.png".to_string(),
                follow: false,
            }]
        );
    }

    /// A stand-in compiler: the platform shell running `line` in the document's directory.
    fn fake_compiler(source: &Path, line: &str) -> CompileCommand {
        let dir = source.parent().unwrap().to_path_buf();
        let (program, flag) = if cfg!(windows) {
            ("cmd", "/C")
        } else {
            ("sh", "-c")
        };
        CompileCommand {
            program: program.to_string(),
            args: vec![flag.to_string(), line.to_string()],
            source: source.to_path_buf(),
            cwd: dir.clone(),
            output_dir: dir,
            pdf_path: source.with_extension("pdf"),
        }
    }

    /// Keeps the notifications a call would send to its client.
    #[derive(Default)]
    struct Notices(Mutex<Vec<ServerNotification>>);

    impl CallNotifier for Notices {
        fn notify(&self, notification: ServerNotification) -> NotifyFuture<'_> {
            self.0
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(notification);
            Box::pin(async { Ok::<(), String>(()) })
        }
    }

    fn context(project: &Path, notices: Option<Arc<Notices>>) -> RunContext {
        RunContext {
            project_root: project.to_path_buf(),
            provider: None,
            model: None,
            tool_call_id: Some("call_9".to_string()),
            notifier: notices.map(|notices| notices as Arc<dyn CallNotifier>),
        }
    }

    fn text(result: &CallToolResult) -> String {
        result
            .content
            .iter()
            .filter_map(ContentBlock::as_text)
            .map(|content| content.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn only_record(project: &Path) -> RunRecord {
        let files: Vec<PathBuf> = fs::read_dir(runs_dir(project))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(files.len(), 1, "{files:?}");
        RunRecord::from_json(&fs::read_to_string(&files[0]).unwrap()).unwrap()
    }

    /// A paper whose main file pulls in a section, and a valid PDF next to it for the stand-in
    /// compiler to copy.
    fn paper_project() -> tempfile::TempDir {
        let project = tempfile::tempdir().unwrap();
        write(
            project.path(),
            "paper/main.tex",
            "\\documentclass{article}\n\\begin{document}\n\\input{sec/intro}\n\\end{document}\n",
        );
        write(project.path(), "paper/sec/intro.tex", "Hello.");
        let mut pdf = b"%PDF-1.7\n".to_vec();
        pdf.resize(4096, b' ');
        pdf.extend_from_slice(b"%%EOF\n");
        fs::write(project.path().join("paper/prepared.pdf"), pdf).unwrap();
        project
    }

    #[tokio::test]
    async fn a_compilation_in_the_project_is_recorded_with_its_sources_and_pdf() {
        let project = paper_project();
        let copy = if cfg!(windows) {
            "type prepared.pdf > main.pdf"
        } else {
            "cat prepared.pdf > main.pdf"
        };
        let command = fake_compiler(&project.path().join("paper/main.tex"), copy);
        let notices = Arc::new(Notices::default());

        let result = execute(
            command,
            context(project.path(), Some(notices.clone())),
            &RunIntegration::default(),
            std::future::pending(),
        )
        .await
        .unwrap();

        assert_ne!(result.is_error, Some(true), "{}", text(&result));
        let record = only_record(project.path());
        assert_eq!(record.code.path, "paper/main.tex");
        let inputs: Vec<&str> = record.inputs.iter().map(|f| f.path.as_str()).collect();
        let outputs: Vec<&str> = record.outputs.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(inputs, vec!["paper/sec/intro.tex"]);
        assert_eq!(outputs, vec!["paper/main.pdf"]);
        assert_eq!(record.exit_code, Some(0));
        assert_eq!(record.failure, None);
        assert_eq!(record.seed, SEED_UNSET);
        assert_eq!(record.config.provider, CONFIG_UNKNOWN);
        assert!(text(&result).contains(&format!(
            "Run_Record: .modelforge/runs/{}.json",
            record.run_id
        )));

        let meta = result.meta.as_ref().unwrap();
        assert_eq!(
            meta.0[RUN_META_KEY],
            json!({
                "runId": record.run_id,
                "recordPath": format!(".modelforge/runs/{}.json", record.run_id),
                "exitCode": 0,
                "failure": null,
                "outputs": ["paper/main.pdf"],
            })
        );

        let sent = notices.0.lock().unwrap_or_else(PoisonError::into_inner);
        assert_eq!(sent.len(), 1, "{sent:?}");
        let ServerNotification::CustomNotification(notice) = &sent[0] else {
            panic!("not a custom notification: {:?}", sent[0]);
        };
        assert_eq!(notice.method, run_script::RUN_STARTED_NOTIFICATION);
        assert_eq!(
            notice.params,
            Some(json!({
                "runId": record.run_id,
                "toolCallId": "call_9",
                "declaredOutputs": ["paper/main.pdf"],
            }))
        );
    }

    #[tokio::test]
    async fn a_failed_compilation_is_recorded_like_a_failed_run() {
        let project = paper_project();
        let fail = if cfg!(windows) {
            "echo ! Undefined control sequence.& exit /b 1"
        } else {
            "echo '! Undefined control sequence.'; exit 1"
        };
        let command = fake_compiler(&project.path().join("paper/main.tex"), fail);

        let result = execute(
            command,
            context(project.path(), None),
            &RunIntegration::default(),
            std::future::pending(),
        )
        .await
        .unwrap();

        assert_eq!(result.is_error, Some(true));
        assert!(
            text(&result).contains("! Undefined control sequence."),
            "{}",
            text(&result)
        );
        let record = only_record(project.path());
        assert_eq!(record.exit_code, Some(1));
        assert_eq!(record.failure, Some(RunFailure::NonZeroExit));
        assert!(record.outputs.is_empty());
        assert_eq!(
            result.meta.as_ref().unwrap().0[RUN_META_KEY]["failure"],
            "非零退出码"
        );
        assert!(!project.path().join("paper/main.pdf").exists());
    }

    #[tokio::test]
    async fn a_cancelled_compilation_is_recorded_as_cancelled() {
        let project = paper_project();
        let wait = if cfg!(windows) {
            "ping -n 30 127.0.0.1 > nul"
        } else {
            "sleep 30"
        };
        let command = fake_compiler(&project.path().join("paper/main.tex"), wait);
        let stop = async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            StopRequest::Cancelled
        };

        let started = std::time::Instant::now();
        let result = execute(
            command,
            context(project.path(), None),
            &RunIntegration::default(),
            stop,
        )
        .await
        .unwrap();

        assert!(started.elapsed() < Duration::from_secs(20));
        assert_eq!(result.is_error, Some(true));
        let record = only_record(project.path());
        assert_eq!(record.exit_code, None);
        assert_eq!(record.failure, Some(RunFailure::Cancelled));
    }

    #[tokio::test]
    async fn a_document_outside_the_project_compiles_without_a_record() {
        let project = tempfile::tempdir().unwrap();
        let elsewhere = paper_project();
        let copy = if cfg!(windows) {
            "type prepared.pdf > main.pdf"
        } else {
            "cat prepared.pdf > main.pdf"
        };
        let command = fake_compiler(&elsewhere.path().join("paper/main.tex"), copy);

        let result = execute(
            command,
            context(project.path(), None),
            &RunIntegration::default(),
            std::future::pending(),
        )
        .await
        .unwrap();

        assert_ne!(result.is_error, Some(true), "{}", text(&result));
        assert!(text(&result).contains("No Run_Record was written"));
        assert!(result.meta.is_none());
        assert!(!project.path().join(".modelforge").exists());
        assert!(!elsewhere.path().join(".modelforge").exists());
    }
}
