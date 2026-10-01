//! The `run_script` tool (spec mathmodel-parity-and-beyond, task 21.6): runs computation code in
//! the Project and writes its Run_Record through [`RunRecorder`] before the tool returns, so a
//! step never counts as done without its record (requirement 22.4).
//!
//! The Project is the session working directory that goose sends in the request `_meta`
//! (`agent-working-dir`). The run ends in one of four ways: exit code 0, a non-zero exit code
//! (a signal death counts as 128 + signal), the time limit (超时) or a cancellation (用户取消).
//! While the code runs, the interpreter version and the installed packages are probed on the
//! side; a probe that is still busy shortly after the run ended is dropped rather than holding
//! the result back.
//!
//! Once the process has started, the call tells its client the run id with the MCP custom
//! notification [`RUN_STARTED_NOTIFICATION`]; goose turns it into the ACP notification
//! `_goose/unstable/runs/started`, so the desktop can mark the declared outputs as running
//! (layer-c-contract-acp.md, section 3.2).

use std::fmt;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use rmcp::model::{
    CallToolResult, ContentBlock, CustomNotification, ErrorCode, ErrorData, MetaObject,
    ServerNotification,
};
use rmcp::schemars::JsonSchema;
use rmcp::{Peer, RoleServer};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::run_record::{is_project_relative_path, Dependency, RunRecord};
use super::run_recorder::{
    FinishedRun, NoRunObserver, NoSecretValues, ProbedEnvironment, RunObserver, RunOutcome,
    RunRecorder, RunSpec, SecretValues, CONFIG_UNKNOWN,
};
use crate::subprocess::SubprocessExt;

pub const DEFAULT_TIMEOUT_SECS: u64 = 600;
pub const MAX_TIMEOUT_SECS: u64 = 86_400;

/// Request `_meta` keys the integration layer may set so the record names the model in use. goose
/// does not send them yet; without them the record says [`CONFIG_UNKNOWN`].
pub const PROVIDER_META_KEY: &str = "modelforge-provider";
pub const MODEL_META_KEY: &str = "modelforge-model";
/// Tool result `_meta` key carrying the run id, record path and outcome, for whoever forwards
/// `runs/finished` to the desktop.
pub const RUN_META_KEY: &str = "modelforge/run";
/// MCP custom notification sent once the process of a run has started. Params:
/// `{ "runId", "toolCallId"?, "declaredOutputs" }`. goose's MCP client forwards only
/// `modelforge/` notifications to the tool call, and the ACP server turns this one into
/// `_goose/unstable/runs/started` (`RUN_STARTED_TOOL_NOTIFICATION` in `goose::acp::server::runs`).
pub const RUN_STARTED_NOTIFICATION: &str = "modelforge/run_started";
/// Request `_meta` key goose uses for the id of the tool call. The start notice echoes it, so
/// goose can tell it apart from the notices of other calls to this server.
pub const TOOL_CALL_ID_META_KEY: &str = "agent-tool-call-request-id";

const RUNTIME_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const DEPENDENCY_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// A probe still running this long after the code ended is given up, which keeps the record
/// inside requirement 16.1's five seconds.
const PROBE_GRACE_AFTER_RUN: Duration = Duration::from_secs(3);
/// After the process exited, a grandchild may still hold its pipes open.
const PIPE_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
/// The start notice is best effort; a client that does not take it within this time is skipped.
const RUN_STARTED_SEND_TIMEOUT: Duration = Duration::from_secs(2);
const OUTPUT_TAIL_BYTES: usize = 64 * 1024;
const OUTPUT_TAIL_LINES: usize = 100;
const LISTED_PATHS: usize = 20;
const CODE_EXTENSIONS: &[&str] = &[
    "py", "ipynb", "r", "rmd", "qmd", "m", "jl", "js", "mjs", "cjs", "ts", "sh", "ps1", "bat",
    "cmd", "do", "sas", "lua", "rb", "pl",
];
const R_PACKAGES: &str = "ip <- installed.packages()[, c('Package', 'Version'), drop = FALSE]; \
    cat(paste(ip[, 1], ip[, 2], sep = '\\t'), sep = '\\n')";

/// Parameters for the run_script tool
#[derive(Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct RunScriptParams {
    /// Script file inside the Project, run with the interpreter for its extension: .py (the
    /// Project's .venv if present, else python), .R (Rscript), .m (matlab -batch), .jl (julia),
    /// .js (node), .sh (sh), .ps1 (PowerShell). Give either `script` or `command`.
    pub script: Option<String>,
    /// Arguments passed to `script`.
    #[serde(default)]
    pub args: Vec<String>,
    /// Command line run by the platform shell (cmd on Windows, sh elsewhere) in the Project
    /// directory, e.g. "uv run code/q1.py --alpha 0.5".
    pub command: Option<String>,
    /// Code file that `command` runs, when it is not named in the command line.
    pub code: Option<String>,
    /// Input files or directories. When omitted, existing Project files named in the command or
    /// the code are recorded.
    pub inputs: Option<Vec<String>>,
    /// Output files or directories. When omitted, files created or changed during the run are
    /// recorded (.modelforge/ excluded).
    pub outputs: Option<Vec<String>>,
    /// Random seed the code uses, recorded as given and exported as MODELFORGE_SEED.
    pub seed: Option<String>,
    /// Time limit in seconds, 1 to 86400. Defaults to 600.
    pub timeout_secs: Option<u64>,
}

/// What every run of this server uses: where credential values come from and who hears about
/// runs. Both default to nothing; the integration layer supplies real ones, for the builtin
/// servers through [`super::set_builtin_run_integration`].
#[derive(Clone)]
pub struct RunIntegration {
    pub secrets: Arc<dyn SecretValues>,
    pub observer: Arc<dyn RunObserver>,
}

impl Default for RunIntegration {
    fn default() -> Self {
        Self {
            secrets: Arc::new(NoSecretValues),
            observer: Arc::new(NoRunObserver),
        }
    }
}

/// Where and for whom one call runs.
#[derive(Clone)]
pub struct RunContext {
    pub project_root: PathBuf,
    pub provider: Option<String>,
    pub model: Option<String>,
    /// [`TOOL_CALL_ID_META_KEY`] of the request, echoed in the start notice.
    pub tool_call_id: Option<String>,
    /// Where the start notice goes, normally the client of the request; `None` sends none.
    pub notifier: Option<Arc<dyn CallNotifier>>,
}

impl fmt::Debug for RunContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RunContext")
            .field("project_root", &self.project_root)
            .field("provider", &self.provider)
            .field("model", &self.model)
            .field("tool_call_id", &self.tool_call_id)
            .field("notifier", &self.notifier.is_some())
            .finish()
    }
}

/// What [`CallNotifier::notify`] returns.
pub type NotifyFuture<'a> = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;

/// Sends MCP notifications to the client of one call. rmcp's `Peer<RoleServer>` (the request
/// context's `peer`) is the real one; tests keep what would be sent.
pub trait CallNotifier: Send + Sync {
    fn notify(&self, notification: ServerNotification) -> NotifyFuture<'_>;
}

impl CallNotifier for Peer<RoleServer> {
    fn notify(&self, notification: ServerNotification) -> NotifyFuture<'_> {
        Box::pin(async move {
            self.send_notification(notification)
                .await
                .map_err(|error| error.to_string())
        })
    }
}

/// Why the caller stopped waiting for a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopRequest {
    Cancelled,
    /// The client's own request timeout ran out, which is a time limit too.
    TimedOut,
}

impl StopRequest {
    /// Reads the reason of `notifications/cancelled`. goose's MCP client sends "timed out" when
    /// its request timeout ends a call and "operation cancelled" when the user stops it.
    pub fn from_reason(reason: Option<&str>) -> Self {
        let reason = reason.unwrap_or_default().to_ascii_lowercase();
        if reason.contains("timed out") || reason.contains("timeout") {
            Self::TimedOut
        } else {
            Self::Cancelled
        }
    }
}

/// Runs the code described by `params` in `context.project_root` and writes its Run_Record.
/// `stop` resolves when the caller cancels.
pub async fn execute(
    params: RunScriptParams,
    context: RunContext,
    integration: &RunIntegration,
    stop: impl Future<Output = StopRequest>,
) -> Result<CallToolResult, ErrorData> {
    let timeout_secs = params.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS);
    if !(1..=MAX_TIMEOUT_SECS).contains(&timeout_secs) {
        return Err(invalid_params(format!(
            "timeout_secs must be between 1 and {MAX_TIMEOUT_SECS}, got {timeout_secs}"
        )));
    }
    let recorder = RunRecorder::new(&context.project_root, integration.secrets.clone())
        .map_err(|error| invalid_params(format!("{error:#}")))?;
    let plan = RunPlan::new(&recorder, &params).map_err(invalid_params)?;
    let root = recorder.project_root().to_path_buf();

    // Probed while the code runs; dropping a probe task kills its process.
    let probes_started = Instant::now();
    let runtime_probe = ProbeTask(tokio::spawn(probe_runtime(
        plan.interpreter.clone(),
        root.clone(),
    )));
    let dependency_probe = ProbeTask(tokio::spawn(probe_dependencies(
        plan.interpreter.clone(),
        root.clone(),
    )));

    let seed = params.seed.clone().filter(|seed| !seed.trim().is_empty());
    let spec = RunSpec {
        command: plan.display.clone(),
        code: plan.code.clone(),
        inputs: params
            .inputs
            .as_ref()
            .map(|paths| paths.iter().map(PathBuf::from).collect()),
        outputs: params
            .outputs
            .as_ref()
            .map(|paths| paths.iter().map(PathBuf::from).collect()),
        seed: seed.clone(),
        provider: context
            .provider
            .clone()
            .unwrap_or_else(|| CONFIG_UNKNOWN.to_string()),
        model: context
            .model
            .clone()
            .unwrap_or_else(|| CONFIG_UNKNOWN.to_string()),
    };
    let begin_recorder = recorder.clone();
    let declared = params.outputs.clone();
    let (handle, declared_outputs) = blocking(move || {
        // Named before the process starts, while most of them do not exist yet.
        let declared_outputs = declared
            .as_deref()
            .map(|paths| declared_output_paths(&begin_recorder, paths))
            .unwrap_or_default();
        begin_recorder
            .begin(spec)
            .map(|handle| (handle, declared_outputs))
    })
    .await
    .map_err(|error| internal_error(format!("{error:#}")))?;

    let child = match plan
        .command(&root, handle.run_id(), seed.as_deref())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "Could not start `{}`: {error}. Nothing ran, so no Run_Record was written.",
                plan.display
            ))]));
        }
    };
    let started = Instant::now();
    integration.observer.run_started(&root, &handle);
    if let Some(notifier) = &context.notifier {
        let notice = run_started_notice(
            handle.run_id(),
            context.tool_call_id.as_deref(),
            &declared_outputs,
        );
        send_run_started(notifier.as_ref(), notice).await;
    }
    let supervised = supervise(child, Duration::from_secs(timeout_secs), stop).await;
    let ended = Instant::now();
    let elapsed = ended - started;

    let runtime = runtime_probe
        .finish_by((probes_started + RUNTIME_PROBE_TIMEOUT).min(ended + PROBE_GRACE_AFTER_RUN))
        .await
        .flatten();
    let dependencies = dependency_probe
        .finish_by((probes_started + DEPENDENCY_PROBE_TIMEOUT).min(ended + PROBE_GRACE_AFTER_RUN))
        .await
        .flatten();
    // The recorder's own notes (paths it could not record) come back with the finished run.
    let mut notes: Vec<String> = supervised.note.iter().cloned().collect();
    if dependencies.is_none() {
        notes.push(format!(
            "the dependency summary of {} could not be read in time; the record lists none",
            plan.interpreter.family()
        ));
    }
    let environment = ProbedEnvironment {
        runtime: describe_runtime(&plan.interpreter, runtime),
        dependencies: dependencies.unwrap_or_default(),
    };

    let run_id = handle.run_id().to_string();
    let outcome = supervised.outcome;
    let finish_recorder = recorder.clone();
    match blocking(move || finish_recorder.finish(handle, outcome, environment)).await {
        Ok(run) => {
            integration.observer.run_finished(&root, &run);
            notes.extend(run.notes.iter().cloned());
            Ok(report(&run, elapsed, timeout_secs, &supervised, &notes))
        }
        Err(error) => {
            let mut text = format!(
                "Run {run_id} {} but its Run_Record could not be written: {error:#}\n",
                describe_outcome(outcome, timeout_secs)
            );
            push_output(&mut text, &supervised);
            Ok(CallToolResult::error(vec![ContentBlock::text(text)]))
        }
    }
}

fn invalid_params(message: impl Into<String>) -> ErrorData {
    ErrorData::new(ErrorCode::INVALID_PARAMS, message.into(), None)
}

fn internal_error(message: impl Into<String>) -> ErrorData {
    ErrorData::new(ErrorCode::INTERNAL_ERROR, message.into(), None)
}

/// Runs file system work (hashing, tree walks, the record write) off the async threads.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> anyhow::Result<T> {
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => result,
        Err(error) => Err(anyhow::anyhow!("the recorder task failed: {error}")),
    }
}

/// The declared outputs as Project-relative `/` paths for the start notice, in the order given,
/// at most [`super::run_record::MAX_RECORDED_FILES`]. A declared directory is left out (which of
/// its files the run writes is only known when it ends, and the record lists them then), and so
/// is anything outside the Project or under `.modelforge/`.
fn declared_output_paths(recorder: &RunRecorder, declared: &[String]) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for path in declared {
        if paths.len() == super::run_record::MAX_RECORDED_FILES {
            break;
        }
        if let Some(relative) = declared_output_path(recorder, Path::new(path)) {
            if !paths.contains(&relative) {
                paths.push(relative);
            }
        }
    }
    paths
}

/// One declared output that may not exist yet: its deepest existing ancestor must resolve inside
/// the Project, and the missing rest is appended as written.
pub(super) fn declared_output_path(recorder: &RunRecorder, path: &Path) -> Option<String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        recorder.project_root().join(path)
    };
    let mut missing: Vec<String> = Vec::new();
    let mut current = absolute.as_path();
    let base = loop {
        if current.exists() {
            if missing.is_empty() && current.is_dir() {
                return None;
            }
            break recorder.relative_path(current)?;
        }
        // `None` for a path ending in `..` or at the root: nothing to name.
        missing.push(current.file_name()?.to_str()?.to_string());
        current = current.parent()?;
    };
    missing.reverse();
    let relative = if base.is_empty() {
        missing.join("/")
    } else if missing.is_empty() {
        base
    } else {
        format!("{base}/{}", missing.join("/"))
    };
    (is_project_relative_path(&relative) && !relative.starts_with(".modelforge/"))
        .then_some(relative)
}

/// The [`RUN_STARTED_NOTIFICATION`] of the run `run_id`.
pub(super) fn run_started_notice(
    run_id: &str,
    tool_call_id: Option<&str>,
    declared_outputs: &[String],
) -> ServerNotification {
    let mut params = serde_json::Map::new();
    params.insert("runId".to_string(), json!(run_id));
    if let Some(tool_call_id) = tool_call_id {
        params.insert("toolCallId".to_string(), json!(tool_call_id));
    }
    params.insert("declaredOutputs".to_string(), json!(declared_outputs));
    ServerNotification::CustomNotification(CustomNotification::new(
        RUN_STARTED_NOTIFICATION,
        Some(serde_json::Value::Object(params)),
    ))
}

/// Best effort: the desktop also learns about the run from its result and from rescanning
/// `.modelforge/runs`. Awaited before the run is supervised, so the notice reaches the client
/// before the tool result does.
pub(super) async fn send_run_started(notifier: &dyn CallNotifier, notice: ServerNotification) {
    match tokio::time::timeout(RUN_STARTED_SEND_TIMEOUT, notifier.notify(notice)).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => tracing::debug!(%error, "the run start notice was not delivered"),
        Err(_) => tracing::debug!("the run start notice timed out"),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Launch {
    /// `program` with `args`, no shell.
    Direct { program: String, args: Vec<String> },
    /// A command line for the platform shell.
    Shell(String),
}

/// What runs the code, as far as probing it goes.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Interpreter {
    Python(String),
    R(String),
    Uv(String),
    /// `probe_version` says whether `--version` is known to be harmless.
    Other {
        program: String,
        probe_version: bool,
    },
}

impl Interpreter {
    fn for_program(program: &str) -> Self {
        let stem = program_stem(program);
        if stem == "py" || stem.starts_with("python") {
            Self::Python(program.to_string())
        } else if stem == "rscript" {
            Self::R(program.to_string())
        } else if stem == "uv" {
            Self::Uv(program.to_string())
        } else {
            Self::Other {
                program: program.to_string(),
                probe_version: matches!(stem.as_str(), "julia" | "node" | "octave" | "octave-cli"),
            }
        }
    }

    fn program(&self) -> &str {
        match self {
            Self::Python(program) | Self::R(program) | Self::Uv(program) => program,
            Self::Other { program, .. } => program,
        }
    }

    /// The name a version line is expected to contain.
    fn family(&self) -> String {
        match self {
            Self::Python(_) => "python".to_string(),
            Self::R(_) => "rscript".to_string(),
            Self::Uv(_) => "uv".to_string(),
            Self::Other { program, .. } => program_stem(program),
        }
    }

    fn probes_version(&self) -> bool {
        match self {
            Self::Python(_) | Self::R(_) | Self::Uv(_) => true,
            Self::Other { probe_version, .. } => *probe_version,
        }
    }
}

fn program_stem(program: &str) -> String {
    Path::new(program)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(program)
        .to_ascii_lowercase()
}

fn platform_shell() -> &'static str {
    if cfg!(windows) {
        "cmd"
    } else {
        "sh"
    }
}

#[derive(Debug, Clone)]
struct RunPlan {
    launch: Launch,
    /// The command line as recorded.
    display: String,
    /// Project-relative code file.
    code: PathBuf,
    interpreter: Interpreter,
}

impl RunPlan {
    fn new(recorder: &RunRecorder, params: &RunScriptParams) -> Result<Self, String> {
        match (params.script.as_deref(), params.command.as_deref()) {
            (Some(_), Some(_)) => Err("give either `script` or `command`, not both".to_string()),
            (None, None) => {
                Err("give `script` (a code file) or `command` (a command line)".to_string())
            }
            (Some(script), None) => {
                if params.code.is_some() {
                    return Err(
                        "`code` only applies to `command`; `script` is the code file".to_string(),
                    );
                }
                Self::for_script(recorder, script, &params.args)
            }
            (None, Some(command)) => {
                if !params.args.is_empty() {
                    return Err(
                        "`args` only apply to `script`; put them in the command line".to_string(),
                    );
                }
                Self::for_command(recorder, command, params.code.as_deref())
            }
        }
    }

    fn for_script(recorder: &RunRecorder, script: &str, args: &[String]) -> Result<Self, String> {
        let relative = recorder.project_file(Path::new(script)).ok_or_else(|| {
            format!(
                "script {script} is not a file inside the Project {}",
                recorder.project_root().display()
            )
        })?;
        let extension = Path::new(&relative)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        let (program, shown, mut launch_args) = match extension.as_str() {
            "py" => {
                let (program, shown) = python_program(recorder.project_root());
                (program, shown, vec![relative.clone()])
            }
            "r" => named("Rscript", vec![relative.clone()]),
            "m" => named(
                "matlab",
                vec![
                    "-batch".to_string(),
                    format!("run('{}')", relative.replace('\'', "''")),
                ],
            ),
            "jl" => named("julia", vec![relative.clone()]),
            "js" | "mjs" | "cjs" => named("node", vec![relative.clone()]),
            "sh" => named("sh", vec![relative.clone()]),
            "ps1" => named(
                if cfg!(windows) { "powershell" } else { "pwsh" },
                vec![
                    "-NoProfile".to_string(),
                    "-NonInteractive".to_string(),
                    "-ExecutionPolicy".to_string(),
                    "Bypass".to_string(),
                    "-File".to_string(),
                    relative.clone(),
                ],
            ),
            "" => return Err(format!("{script} has no extension; use `command` instead")),
            other => {
                return Err(format!(
                    "no interpreter is known for .{other} scripts; use `command` instead"
                ))
            }
        };
        launch_args.extend(args.iter().cloned());
        let display = shell_words::join(
            std::iter::once(shown.as_str()).chain(launch_args.iter().map(String::as_str)),
        );
        let interpreter = Interpreter::for_program(&program);
        Ok(Self {
            launch: Launch::Direct {
                program,
                args: launch_args,
            },
            display,
            code: PathBuf::from(relative),
            interpreter,
        })
    }

    fn for_command(
        recorder: &RunRecorder,
        command: &str,
        code: Option<&str>,
    ) -> Result<Self, String> {
        if command.trim().is_empty() {
            return Err("`command` is empty".to_string());
        }
        if cfg!(windows) && command.contains(['\n', '\r']) {
            return Err(
                "cmd.exe runs only the first line of a multi-line command; put the \
                        lines in a script file and pass it as `script`"
                    .to_string(),
            );
        }
        let tokens = split_command(command);
        let files: Vec<String> = tokens
            .iter()
            .filter_map(|token| recorder.project_file(Path::new(token)))
            .collect();
        let code = match code {
            Some(code) => recorder
                .project_file(Path::new(code))
                .ok_or_else(|| format!("code file {code} is not a file inside the Project"))?,
            None => files
                .iter()
                .find(|file| is_code_file(file))
                .or(files.first())
                .cloned()
                .ok_or_else(|| {
                    "could not tell which code file the command runs; pass its path as `code`"
                        .to_string()
                })?,
        };
        // A command that starts with the script itself is interpreted by the shell.
        let first = tokens.first().map(String::as_str).unwrap_or_default();
        let program = if recorder.project_file(Path::new(first)).as_deref() == Some(code.as_str()) {
            platform_shell()
        } else {
            first
        };
        Ok(Self {
            launch: Launch::Shell(command.to_string()),
            display: command.to_string(),
            code: PathBuf::from(code),
            interpreter: Interpreter::for_program(program),
        })
    }

    fn command(&self, root: &Path, run_id: &str, seed: Option<&str>) -> Command {
        let mut command = match &self.launch {
            Launch::Direct { program, args } => {
                let mut command = Command::new(program);
                command.args(args);
                command
            }
            Launch::Shell(line) => shell_command(line),
        };
        command
            .current_dir(root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .set_no_window()
            .env("MODELFORGE_RUN_ID", run_id)
            .env("PYTHONIOENCODING", "utf-8");
        if let Some(seed) = seed {
            command.env("MODELFORGE_SEED", seed);
        }
        // Own process group on Unix, so a timeout or cancellation can kill the whole tree.
        #[cfg(unix)]
        command.process_group(0);
        command
    }
}

fn named(program: &str, args: Vec<String>) -> (String, String, Vec<String>) {
    (program.to_string(), program.to_string(), args)
}

/// The Project's virtual environment interpreter if there is one, else the usual name. Returns
/// the program to start and the name to record.
fn python_program(root: &Path) -> (String, String) {
    let venv: [&str; 3] = if cfg!(windows) {
        [".venv", "Scripts", "python.exe"]
    } else {
        [".venv", "bin", "python"]
    };
    let path = venv
        .iter()
        .fold(root.to_path_buf(), |path, part| path.join(part));
    if path.is_file() {
        (path.to_string_lossy().into_owned(), venv.join("/"))
    } else {
        let name = if cfg!(windows) { "python" } else { "python3" };
        (name.to_string(), name.to_string())
    }
}

fn shell_command(line: &str) -> Command {
    #[cfg(windows)]
    let command = {
        let mut command = Command::new("cmd");
        // cmd.exe has its own quoting rules; hand it the line untouched.
        command.arg("/C").raw_arg(line);
        command
    };
    #[cfg(not(windows))]
    let command = {
        let mut command = Command::new("sh");
        command.arg("-c").arg(line);
        command
    };
    command
}

/// Whitespace-separated words; single or double quotes group words and are removed.
fn split_command(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    for c in command.chars() {
        match quote {
            Some(open) if c == open => quote = None,
            Some(_) => current.push(c),
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            None => current.push(c),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn is_code_file(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| CODE_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
}

/// How a supervised process ended, with the tails of its output.
pub(super) struct Supervised {
    pub(super) outcome: RunOutcome,
    pub(super) stdout: String,
    pub(super) stderr: String,
    pub(super) note: Option<String>,
}

/// Waits for the process, the time limit or `stop`, whichever comes first. On the last two the
/// whole process tree is killed.
pub(super) async fn supervise(
    mut child: Child,
    timeout: Duration,
    stop: impl Future<Output = StopRequest>,
) -> Supervised {
    enum Ended {
        Exited(io::Result<ExitStatus>),
        TimedOut,
        Stopped(StopRequest),
    }

    let pid = child.id();
    let stdout = TailReader::spawn(child.stdout.take());
    let stderr = TailReader::spawn(child.stderr.take());
    let ended = tokio::select! {
        status = child.wait() => Ended::Exited(status),
        _ = tokio::time::sleep(timeout) => Ended::TimedOut,
        request = stop => Ended::Stopped(request),
    };
    if !matches!(&ended, Ended::Exited(Ok(_))) {
        // Kill the tree while the direct child is alive, so its descendants can still be found.
        if let Some(pid) = pid {
            super::kill_process_tree(pid).await;
        }
        let _ = child.kill().await;
    }
    let (outcome, note) = match ended {
        Ended::Exited(Ok(status)) => (RunOutcome::Exited(exit_code_of(status)), None),
        Ended::Exited(Err(error)) => (
            RunOutcome::Exited(-1),
            Some(format!(
                "waiting for the process failed ({error}); recorded exit code -1"
            )),
        ),
        Ended::TimedOut | Ended::Stopped(StopRequest::TimedOut) => (RunOutcome::TimedOut, None),
        Ended::Stopped(StopRequest::Cancelled) => (RunOutcome::Cancelled, None),
    };
    Supervised {
        outcome,
        stdout: stdout.finish().await,
        stderr: stderr.finish().await,
        note,
    }
}

/// The exit code, or 128 + the signal number for a process a signal killed (the shell
/// convention); either way a killed process never reads as a success.
fn exit_code_of(status: ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    1
}

/// Reads a pipe to its end, keeping only the last [`OUTPUT_TAIL_BYTES`].
struct TailReader {
    kept: Arc<Mutex<Vec<u8>>>,
    task: JoinHandle<()>,
}

impl TailReader {
    fn spawn<R: AsyncRead + Unpin + Send + 'static>(reader: Option<R>) -> Self {
        let kept = Arc::new(Mutex::new(Vec::new()));
        let sink = kept.clone();
        let task = tokio::spawn(async move {
            let Some(mut reader) = reader else {
                return;
            };
            let mut chunk = [0u8; 8192];
            loop {
                match reader.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => keep_tail(&sink, &chunk[..read]),
                }
            }
        });
        Self { kept, task }
    }

    async fn finish(mut self) -> String {
        if tokio::time::timeout(PIPE_DRAIN_TIMEOUT, &mut self.task)
            .await
            .is_err()
        {
            self.task.abort();
        }
        let kept = self.kept.lock().unwrap_or_else(PoisonError::into_inner);
        let start = kept.len().saturating_sub(OUTPUT_TAIL_BYTES);
        String::from_utf8_lossy(&kept[start..]).into_owned()
    }
}

fn keep_tail(sink: &Mutex<Vec<u8>>, bytes: &[u8]) {
    let mut kept = sink.lock().unwrap_or_else(PoisonError::into_inner);
    kept.extend_from_slice(bytes);
    if kept.len() > 2 * OUTPUT_TAIL_BYTES {
        let excess = kept.len() - OUTPUT_TAIL_BYTES;
        kept.drain(..excess);
    }
}

/// A probe running beside the code. Dropping it aborts the task, which kills its process.
pub(super) struct ProbeTask<T>(pub(super) JoinHandle<T>);

impl<T> ProbeTask<T> {
    pub(super) async fn finish_by(mut self, deadline: Instant) -> Option<T> {
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

/// Stdout and stderr of a successful short command, or `None`.
pub(super) async fn probe(
    program: &str,
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
) -> Option<(String, String)> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .set_no_window();
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

pub(super) fn first_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

async fn probe_runtime(interpreter: Interpreter, cwd: PathBuf) -> Option<String> {
    if !interpreter.probes_version() {
        return None;
    }
    let (stdout, stderr) = probe(
        interpreter.program(),
        &["--version"],
        &cwd,
        RUNTIME_PROBE_TIMEOUT,
    )
    .await?;
    first_line(&stdout).or_else(|| first_line(&stderr))
}

/// The installed packages, `Some(empty)` when there is nothing to ask, `None` when asking failed.
async fn probe_dependencies(interpreter: Interpreter, cwd: PathBuf) -> Option<Vec<Dependency>> {
    match interpreter {
        Interpreter::Python(python) => {
            // uv answers in milliseconds and also covers environments without pip.
            let uv = super::resolve_bundled_uv()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|| "uv".to_string());
            let uv_args = [
                "pip",
                "list",
                "--format",
                "json",
                "--python",
                python.as_str(),
            ];
            if let Some((stdout, _)) = probe(&uv, &uv_args, &cwd, DEPENDENCY_PROBE_TIMEOUT).await {
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
            let (stdout, _) = probe(&python, &pip_args, &cwd, DEPENDENCY_PROBE_TIMEOUT).await?;
            parse_pip_json(&stdout)
        }
        Interpreter::Uv(uv) => {
            let args = ["pip", "list", "--format", "json"];
            let (stdout, _) = probe(&uv, &args, &cwd, DEPENDENCY_PROBE_TIMEOUT).await?;
            parse_pip_json(&stdout)
        }
        Interpreter::R(rscript) => {
            let (stdout, _) = probe(
                &rscript,
                &["-e", R_PACKAGES],
                &cwd,
                DEPENDENCY_PROBE_TIMEOUT,
            )
            .await?;
            Some(parse_tab_separated(&stdout))
        }
        Interpreter::Other { .. } => Some(Vec::new()),
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
        Some(line) if line.to_ascii_lowercase().contains(&family) => line,
        Some(line) => format!("{family} {line}"),
        None => family,
    };
    format!(
        "{base} ({}-{})",
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

fn describe_outcome(outcome: RunOutcome, timeout_secs: u64) -> String {
    match outcome {
        RunOutcome::Exited(0) => "finished with exit code 0".to_string(),
        RunOutcome::Exited(code) => format!("failed with exit code {code} (非零退出码)"),
        RunOutcome::TimedOut => {
            format!("was stopped by a time limit (超时; timeout_secs was {timeout_secs})")
        }
        RunOutcome::Cancelled => "was cancelled (用户取消)".to_string(),
    }
}

pub(super) fn push_paths(text: &mut String, label: &str, paths: &[&str], truncated: bool) {
    let more = if truncated { ", more not recorded" } else { "" };
    text.push_str(&format!("{label} ({}{more}):", paths.len()));
    if paths.is_empty() {
        text.push_str(" none\n");
        return;
    }
    text.push('\n');
    for path in paths.iter().take(LISTED_PATHS) {
        text.push_str(&format!("  {path}\n"));
    }
    if paths.len() > LISTED_PATHS {
        text.push_str(&format!("  … and {} more\n", paths.len() - LISTED_PATHS));
    }
}

fn push_output(text: &mut String, supervised: &Supervised) {
    for (name, output) in [
        ("stdout", &supervised.stdout),
        ("stderr", &supervised.stderr),
    ] {
        if output.trim().is_empty() {
            continue;
        }
        text.push_str(&format!(
            "\n{name} (last {OUTPUT_TAIL_LINES} lines):\n{}\n",
            super::tail(output, OUTPUT_TAIL_LINES)
        ));
    }
}

/// `_meta["modelforge/run"]` of a recorded run, which goose forwards as `runs/finished`.
pub(super) fn run_meta(record: &RunRecord) -> serde_json::Value {
    let outputs: Vec<&str> = record
        .outputs
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    json!({
        "runId": record.run_id,
        "recordPath": format!(".modelforge/runs/{}.json", record.run_id),
        "exitCode": record.exit_code,
        "failure": record.failure,
        "outputs": outputs,
    })
}

fn report(
    run: &FinishedRun,
    elapsed: Duration,
    timeout_secs: u64,
    supervised: &Supervised,
    notes: &[String],
) -> CallToolResult {
    let record = &run.record;
    let outcome = supervised.outcome;
    let record_path = format!(".modelforge/runs/{}.json", record.run_id);
    let mut text = format!(
        "Run {} {} after {:.2} s.\nRun_Record: {record_path}\nCommand: {}\nCode: {}\n",
        record.run_id,
        describe_outcome(outcome, timeout_secs),
        elapsed.as_secs_f64(),
        record.command,
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
    push_paths(&mut text, "Inputs", &inputs, record.inputs_truncated);
    push_paths(&mut text, "Outputs", &outputs, record.outputs_truncated);
    if !notes.is_empty() {
        text.push_str("Notes:\n");
        for note in notes {
            text.push_str(&format!("  - {note}\n"));
        }
    }
    push_output(&mut text, supervised);

    let mut meta = MetaObject::new();
    meta.0.insert(RUN_META_KEY.to_string(), run_meta(record));
    let content = vec![ContentBlock::text(text)];
    let result = if outcome.succeeded() {
        CallToolResult::success(content)
    } else {
        CallToolResult::error(content)
    };
    result.with_meta(Some(meta))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modeling::run_record::{runs_dir, RunFailure, RunRecord, SEED_UNSET};
    use std::fs;

    struct Job {
        project: tempfile::TempDir,
        command: String,
        code: &'static str,
    }

    /// A Project with `data/in.csv`, an empty `results/` and a job script for the platform shell.
    fn job(unix: &str, windows: &str) -> Job {
        let project = tempfile::tempdir().unwrap();
        for sub in ["code", "data", "results"] {
            fs::create_dir_all(project.path().join(sub)).unwrap();
        }
        fs::write(project.path().join("data/in.csv"), "x,y\n1,2\n").unwrap();
        let (code, body, command) = if cfg!(windows) {
            (
                "code/job.cmd",
                format!("@echo off\r\n{}\r\n", windows.replace('\n', "\r\n")),
                "code\\job.cmd",
            )
        } else {
            ("code/job.sh", format!("{unix}\n"), "sh code/job.sh")
        };
        fs::write(project.path().join(code), body).unwrap();
        Job {
            project,
            command: command.to_string(),
            code,
        }
    }

    fn params(job: &Job, timeout_secs: Option<u64>) -> RunScriptParams {
        RunScriptParams {
            command: Some(job.command.clone()),
            timeout_secs,
            ..RunScriptParams::default()
        }
    }

    fn context(job: &Job) -> RunContext {
        RunContext {
            project_root: job.project.path().to_path_buf(),
            provider: None,
            model: None,
            tool_call_id: None,
            notifier: None,
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

    /// A client that never takes the notice.
    struct Unresponsive;

    impl CallNotifier for Unresponsive {
        fn notify(&self, _notification: ServerNotification) -> NotifyFuture<'_> {
            Box::pin(std::future::pending::<Result<(), String>>())
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

    /// Runs the job and returns the tool result with the one record it wrote.
    async fn run(
        job: &Job,
        params: RunScriptParams,
        stop: impl Future<Output = StopRequest>,
    ) -> (CallToolResult, RunRecord) {
        let result = execute(params, context(job), &RunIntegration::default(), stop)
            .await
            .unwrap();
        let files: Vec<PathBuf> = fs::read_dir(runs_dir(job.project.path()))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(files.len(), 1, "{files:?}\n{}", text(&result));
        let record = RunRecord::from_json(&fs::read_to_string(&files[0]).unwrap()).unwrap();
        assert_eq!(
            files[0].file_name().unwrap().to_string_lossy(),
            format!("{}.json", record.run_id)
        );
        (result, record)
    }

    #[tokio::test]
    async fn a_successful_run_records_code_inputs_and_outputs() {
        let job = job(
            "cat data/in.csv > results/out.csv\necho done",
            "type data\\in.csv > results\\out.csv\necho done",
        );
        let mut params = params(&job, None);
        params.seed = Some("7".to_string());
        let (result, record) = run(&job, params, std::future::pending()).await;
        assert_ne!(result.is_error, Some(true), "{}", text(&result));
        assert!(text(&result).contains("done"), "{}", text(&result));
        assert_eq!(record.exit_code, Some(0));
        assert_eq!(record.failure, None);
        assert_eq!(record.code.path, job.code);
        assert_eq!(record.command, job.command);
        let inputs: Vec<&str> = record.inputs.iter().map(|f| f.path.as_str()).collect();
        let outputs: Vec<&str> = record.outputs.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(inputs, vec!["data/in.csv"]);
        assert_eq!(outputs, vec!["results/out.csv"]);
        assert_eq!(record.seed, "7");
        assert_eq!(record.config.provider, CONFIG_UNKNOWN);
        assert_eq!(record.config.model, CONFIG_UNKNOWN);
        assert!(record.config.runtime.contains(std::env::consts::OS));

        let meta = result.meta.as_ref().unwrap();
        assert_eq!(meta.0[RUN_META_KEY]["runId"], record.run_id.as_str());
        assert_eq!(meta.0[RUN_META_KEY]["exitCode"], 0);
    }

    #[tokio::test]
    async fn a_non_zero_exit_is_recorded_as_such() {
        let job = job("exit 3", "exit /b 3");
        let (result, record) = run(&job, params(&job, None), std::future::pending()).await;
        assert_eq!(result.is_error, Some(true));
        assert_eq!(record.exit_code, Some(3));
        assert_eq!(record.failure, Some(RunFailure::NonZeroExit));
        assert_eq!(record.seed, SEED_UNSET);
    }

    #[tokio::test]
    async fn the_time_limit_stops_the_run_and_is_recorded() {
        let job = job("sleep 30", "ping -n 30 127.0.0.1 > nul");
        let started = std::time::Instant::now();
        let (result, record) = run(&job, params(&job, Some(1)), std::future::pending()).await;
        assert!(started.elapsed() < Duration::from_secs(20));
        assert_eq!(result.is_error, Some(true));
        assert_eq!(record.exit_code, None);
        assert_eq!(record.failure, Some(RunFailure::Timeout));
    }

    #[tokio::test]
    async fn cancellation_stops_the_run_and_is_recorded() {
        let job = job("sleep 30", "ping -n 30 127.0.0.1 > nul");
        let stop = async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            StopRequest::Cancelled
        };
        let started = std::time::Instant::now();
        let (result, record) = run(&job, params(&job, None), stop).await;
        assert!(started.elapsed() < Duration::from_secs(20));
        assert_eq!(result.is_error, Some(true));
        assert_eq!(record.exit_code, None);
        assert_eq!(record.failure, Some(RunFailure::Cancelled));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_signal_death_is_recorded_as_128_plus_the_signal() {
        let job = job("kill -9 $$", "");
        let (_, record) = run(&job, params(&job, None), std::future::pending()).await;
        assert_eq!(record.exit_code, Some(128 + 9));
        assert_eq!(record.failure, Some(RunFailure::NonZeroExit));
    }

    #[tokio::test]
    async fn invalid_parameters_run_nothing() {
        let job = job("echo hi", "echo hi");
        let integration = RunIntegration::default();
        for params in [
            params(&job, Some(0)),
            params(&job, Some(MAX_TIMEOUT_SECS + 1)),
            RunScriptParams::default(),
            RunScriptParams {
                script: Some(job.code.to_string()),
                command: Some(job.command.clone()),
                ..RunScriptParams::default()
            },
            RunScriptParams {
                command: Some("echo no code file here".to_string()),
                ..RunScriptParams::default()
            },
            RunScriptParams {
                script: Some("code/missing.py".to_string()),
                ..RunScriptParams::default()
            },
        ] {
            let error = execute(params, context(&job), &integration, std::future::pending())
                .await
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::INVALID_PARAMS, "{}", error.message);
        }
        assert!(!job.project.path().join(".modelforge").exists());
    }

    #[tokio::test]
    async fn a_started_run_is_announced_to_the_client() {
        let job = job(
            "cat data/in.csv > results/out.csv",
            "type data\\in.csv > results\\out.csv",
        );
        let notices = Arc::new(Notices::default());
        let notifier: Arc<dyn CallNotifier> = notices.clone();
        let mut context = context(&job);
        context.tool_call_id = Some("call_7".to_string());
        context.notifier = Some(notifier);
        let mut params = params(&job, None);
        params.outputs = Some(vec![
            "results/out.csv".to_string(),
            "results".to_string(),
            "../outside.csv".to_string(),
        ]);

        let result = execute(
            params,
            context,
            &RunIntegration::default(),
            std::future::pending(),
        )
        .await
        .unwrap();
        assert_ne!(result.is_error, Some(true), "{}", text(&result));
        let run_id = result.meta.as_ref().unwrap().0[RUN_META_KEY]["runId"].clone();

        let sent = notices.0.lock().unwrap_or_else(PoisonError::into_inner);
        assert_eq!(sent.len(), 1, "{sent:?}");
        let ServerNotification::CustomNotification(notice) = &sent[0] else {
            panic!("not a custom notification: {:?}", sent[0]);
        };
        assert_eq!(notice.method, RUN_STARTED_NOTIFICATION);
        assert_eq!(
            notice.params,
            Some(json!({
                "runId": run_id,
                "toolCallId": "call_7",
                "declaredOutputs": ["results/out.csv"]
            }))
        );
    }

    #[tokio::test]
    async fn a_client_that_does_not_take_the_notice_does_not_stop_the_run() {
        let job = job("echo hi", "echo hi");
        let notifier: Arc<dyn CallNotifier> = Arc::new(Unresponsive);
        let mut context = context(&job);
        context.notifier = Some(notifier);

        let result = execute(
            params(&job, None),
            context,
            &RunIntegration::default(),
            std::future::pending(),
        )
        .await
        .unwrap();
        assert_ne!(result.is_error, Some(true), "{}", text(&result));
        assert!(text(&result).contains("hi"), "{}", text(&result));
        let files: Vec<PathBuf> = fs::read_dir(runs_dir(job.project.path()))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(files.len(), 1, "{files:?}");
        let record = RunRecord::from_json(&fs::read_to_string(&files[0]).unwrap()).unwrap();
        assert_eq!(record.exit_code, Some(0));
    }

    #[test]
    fn declared_outputs_are_named_relative_to_the_project() {
        let project = tempfile::tempdir().unwrap();
        fs::create_dir_all(project.path().join("results")).unwrap();
        fs::write(project.path().join("results/old.csv"), "a\n").unwrap();
        let recorder = RunRecorder::new(project.path(), Arc::new(NoSecretValues)).unwrap();
        let mut declared: Vec<String> = [
            "results/old.csv",
            "results/new/deep.csv",
            "./figures/f1.png",
            "results",
            "results/old.csv",
            "../escape.csv",
            "results/../../escape.csv",
            ".modelforge/runs/x.json",
        ]
        .iter()
        .map(|path| path.to_string())
        .collect();
        declared.push(
            project
                .path()
                .join("results")
                .join("absolute.csv")
                .to_string_lossy()
                .into_owned(),
        );

        assert_eq!(
            declared_output_paths(&recorder, &declared),
            vec![
                "results/old.csv",
                "results/new/deep.csv",
                "figures/f1.png",
                "results/absolute.csv"
            ]
        );
    }

    #[test]
    fn the_start_notice_leaves_out_an_unknown_tool_call() {
        let ServerNotification::CustomNotification(notice) =
            run_started_notice("20260920T101530123-a1b2c3", None, &[])
        else {
            panic!("not a custom notification");
        };
        assert_eq!(notice.method, RUN_STARTED_NOTIFICATION);
        assert_eq!(
            notice.params,
            Some(json!({ "runId": "20260920T101530123-a1b2c3", "declaredOutputs": [] }))
        );
    }

    #[test]
    fn scripts_get_the_interpreter_for_their_extension() {
        let project = tempfile::tempdir().unwrap();
        fs::create_dir_all(project.path().join("code")).unwrap();
        for name in ["q1.py", "q2.R", "q3.m", "问题 四.jl", "notes.txt"] {
            fs::write(project.path().join("code").join(name), "").unwrap();
        }
        let recorder = RunRecorder::new(project.path(), Arc::new(NoSecretValues)).unwrap();
        let plan = |script: &str, args: &[&str]| {
            RunPlan::for_script(
                &recorder,
                script,
                &args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>(),
            )
        };

        let python = plan("code/q1.py", &["--n", "3"]).unwrap();
        let expected = if cfg!(windows) { "python" } else { "python3" };
        assert_eq!(python.display, format!("{expected} code/q1.py --n 3"));
        assert_eq!(python.code, PathBuf::from("code/q1.py"));
        assert!(matches!(python.interpreter, Interpreter::Python(_)));

        assert_eq!(plan("code/q2.R", &[]).unwrap().display, "Rscript code/q2.R");
        assert_eq!(
            plan("code/q3.m", &[]).unwrap().display,
            "matlab -batch 'run('\\''code/q3.m'\\'')'"
        );
        assert_eq!(
            plan("code/问题 四.jl", &[]).unwrap().display,
            "julia 'code/问题 四.jl'"
        );
        assert!(plan("code/notes.txt", &[]).is_err());

        // A virtual environment in the Project wins.
        let venv = if cfg!(windows) {
            project.path().join(".venv/Scripts/python.exe")
        } else {
            project.path().join(".venv/bin/python")
        };
        fs::create_dir_all(venv.parent().unwrap()).unwrap();
        fs::write(&venv, "").unwrap();
        let python = plan("code/q1.py", &[]).unwrap();
        assert!(python.display.starts_with(".venv/"), "{}", python.display);
    }

    #[test]
    fn commands_are_split_and_their_code_file_found() {
        assert_eq!(
            split_command("uv run \"code/问题 一.py\" --alpha '0.5 1'"),
            vec!["uv", "run", "code/问题 一.py", "--alpha", "0.5 1"]
        );
        let project = tempfile::tempdir().unwrap();
        fs::create_dir_all(project.path().join("code")).unwrap();
        fs::create_dir_all(project.path().join("data")).unwrap();
        fs::write(project.path().join("code/问题 一.py"), "").unwrap();
        fs::write(project.path().join("data/x.csv"), "").unwrap();
        let recorder = RunRecorder::new(project.path(), Arc::new(NoSecretValues)).unwrap();
        let plan =
            RunPlan::for_command(&recorder, "uv run data/x.csv \"code/问题 一.py\"", None).unwrap();
        assert_eq!(plan.code, PathBuf::from("code/问题 一.py"));
        assert!(matches!(plan.interpreter, Interpreter::Uv(_)));
        let explicit = RunPlan::for_command(&recorder, "make all", Some("data/x.csv")).unwrap();
        assert_eq!(explicit.code, PathBuf::from("data/x.csv"));
        assert!(RunPlan::for_command(&recorder, "make all", None).is_err());
    }

    #[test]
    fn probe_output_is_parsed() {
        let pip = "WARNING: something\n[{\"name\": \"numpy\", \"version\": \"1.26.4\"}, {\"name\": \"pandas\", \"version\": \"2.2.0\", \"editable_project_location\": \"/x\"}]\n";
        let parsed = parse_pip_json(pip).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[1].name, "pandas");
        assert_eq!(parsed[1].version, "2.2.0");
        assert!(parse_pip_json("not json").is_none());

        let r = parse_tab_separated("base\t4.3.1\nggplot2\t3.5.0\n\n");
        assert_eq!(r.len(), 2);
        assert_eq!(r[1].name, "ggplot2");

        let python = Interpreter::for_program("python3");
        assert!(describe_runtime(&python, Some("Python 3.12.4".to_string()))
            .starts_with("Python 3.12.4 ("));
        let node = Interpreter::for_program("node");
        assert!(describe_runtime(&node, Some("v20.1.0".to_string())).starts_with("node v20.1.0 ("));
        let shell = Interpreter::for_program("sh");
        assert!(describe_runtime(&shell, None).starts_with("sh ("));
    }

    #[test]
    fn cancellation_reasons_are_told_apart() {
        assert_eq!(
            StopRequest::from_reason(Some("timed out")),
            StopRequest::TimedOut
        );
        assert_eq!(
            StopRequest::from_reason(Some("operation cancelled")),
            StopRequest::Cancelled
        );
        assert_eq!(StopRequest::from_reason(None), StopRequest::Cancelled);
    }
}
