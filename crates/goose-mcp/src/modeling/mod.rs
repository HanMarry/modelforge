use indoc::formatdoc;
use once_cell::sync::Lazy;
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{
        CallToolResult, CancelledNotificationParam, ContentBlock, ErrorCode, ErrorData,
        Implementation, InitializeResult, MetaObject, RequestId, ServerCapabilities, ServerInfo,
        TextContent,
    },
    schemars::JsonSchema,
    service::{NotificationContext, RequestContext},
    tool, tool_handler, tool_router, RoleServer, ServerHandler,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, PoisonError, RwLock},
    time::Duration,
};

use crate::subprocess::SubprocessExt;

// The Run_Record type and the recorder live in goose-run-record so that goose's developer shell
// can record runs without depending on this crate; re-exported under their old paths.
pub use goose_run_record::{run_record, run_recorder};
mod compile_record;
pub mod run_script;
pub mod task_plan;

pub use run_script::RunIntegration;
use run_script::{RunContext, RunScriptParams, StopRequest};

/// Request `_meta` key goose uses for the session working directory, which is the Project.
const WORKING_DIR_META_KEY: &str = "agent-working-dir";

/// The run integration builtin modeling servers are created with; see
/// [`set_builtin_run_integration`].
static BUILTIN_RUN_INTEGRATION: Lazy<RwLock<RunIntegration>> =
    Lazy::new(|| RwLock::new(RunIntegration::default()));

/// Replaces the [`RunIntegration`] that builtin modeling servers are created with and returns the
/// one it replaces.
///
/// Builtin servers are the ones [`crate::BUILTIN_EXTENSIONS`] spawns inside the goose process,
/// one per session that loads the `modeling` extension. Each server takes the integration
/// installed when it is created and keeps it, so install the real one at process start, before
/// the first session loads its extensions (next to `register_builtin_extensions`). Until then the
/// integration supplies no credential values and tells nobody about runs.
///
/// Not affected: servers made with [`ModelingServer::new`] or
/// [`ModelingServer::with_run_integration`], and a modeling server in another process
/// (`goose mcp modeling`, which the Docker path uses).
pub fn set_builtin_run_integration(integration: RunIntegration) -> RunIntegration {
    let mut installed = BUILTIN_RUN_INTEGRATION
        .write()
        .unwrap_or_else(PoisonError::into_inner);
    std::mem::replace(&mut *installed, integration)
}

/// The integration a builtin modeling server created now would use.
pub fn builtin_run_integration() -> RunIntegration {
    BUILTIN_RUN_INTEGRATION
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

/// Parameters for the compile_latex tool
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct CompileLatexParams {
    /// Path to the .tex (or .typ) file to compile
    pub path: String,
    /// Engine to use: latexmk, pdflatex, xelatex, lualatex, tectonic, or typst
    pub engine: Option<String>,
    /// Output directory, relative to the document's directory unless absolute
    pub output_dir: Option<String>,
}

/// Parameters for the check_env tool
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct CheckEnvParams {
    /// Show installation instructions when uv is missing; never executes an installer
    #[serde(default)]
    pub install_uv: bool,
}

/// Modeling tools MCP server providing LaTeX compilation, toolchain detection and recorded
/// script runs.
#[derive(Clone)]
pub struct ModelingServer {
    tool_router: ToolRouter<Self>,
    instructions: String,
    run_integration: RunIntegration,
    active_runs: Arc<ActiveRuns>,
}

/// The `run_script` calls in flight and why each was cancelled, keyed by request id. rmcp cancels
/// a request's token without saying why; the reason arrives separately, in the
/// `notifications/cancelled` that [`ServerHandler::on_cancelled`] receives right after.
#[derive(Default)]
struct ActiveRuns {
    reasons: Mutex<HashMap<RequestId, Option<String>>>,
}

impl ActiveRuns {
    fn register(self: &Arc<Self>, id: RequestId) -> ActiveRun {
        self.reasons
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id.clone(), None);
        ActiveRun {
            runs: self.clone(),
            id,
        }
    }

    fn note_cancelled(&self, id: &RequestId, reason: Option<String>) {
        let mut reasons = self.reasons.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(slot) = reasons.get_mut(id) {
            *slot = Some(reason.unwrap_or_default());
        }
    }

    fn reason(&self, id: &RequestId) -> Option<String> {
        self.reasons
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            .cloned()
            .flatten()
    }
}

/// One registered call; unregisters itself when dropped.
struct ActiveRun {
    runs: Arc<ActiveRuns>,
    id: RequestId,
}

impl ActiveRun {
    /// Called once the request token is cancelled: waits briefly for the reason to arrive.
    async fn stop_request(&self) -> StopRequest {
        for _ in 0..10 {
            if let Some(reason) = self.runs.reason(&self.id) {
                return StopRequest::from_reason(Some(&reason));
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        StopRequest::Cancelled
    }
}

impl Drop for ActiveRun {
    fn drop(&mut self) {
        self.runs
            .reasons
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.id);
    }
}

fn meta_string(meta: &MetaObject, key: &str) -> Option<String> {
    meta.0
        .get(key)
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Where a recorded call runs: the Project is the session working directory goose sends in the
/// request `_meta`, or the process working directory without one.
fn run_context(context: &RequestContext<RoleServer>) -> Result<RunContext, ErrorData> {
    let project_root = meta_string(&context.meta, WORKING_DIR_META_KEY)
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .ok_or_else(|| {
            ErrorData::new(
                ErrorCode::INVALID_PARAMS,
                "no Project directory: the request names no working directory and the \
                 current directory is unavailable"
                    .to_string(),
                None,
            )
        })?;
    Ok(RunContext {
        project_root,
        provider: meta_string(&context.meta, run_script::PROVIDER_META_KEY),
        model: meta_string(&context.meta, run_script::MODEL_META_KEY),
        tool_call_id: meta_string(&context.meta, run_script::TOOL_CALL_ID_META_KEY),
        notifier: Some(Arc::new(context.peer.clone())),
    })
}

impl Default for ModelingServer {
    fn default() -> Self {
        Self::new()
    }
}

#[tool_router(router = tool_router)]
impl ModelingServer {
    pub fn new() -> Self {
        Self::with_run_integration(RunIntegration::default())
    }

    /// A server with the integration installed by [`set_builtin_run_integration`] (by default
    /// none). [`crate::BUILTIN_EXTENSIONS`] creates its modeling servers this way.
    pub fn builtin() -> Self {
        Self::with_run_integration(builtin_run_integration())
    }

    /// A server whose `run_script` takes credential values from `run_integration.secrets` and
    /// reports runs to `run_integration.observer`.
    pub fn with_run_integration(run_integration: RunIntegration) -> Self {
        let instructions = formatdoc! {r#"
            Tools for the mathematical-modeling pipeline:
            - check_env: detect Python, uv, and LaTeX/Typst toolchains; provide installation instructions.
            - compile_latex: compile a LaTeX/Typst document and surface error lines. Inside the
              Project the compilation is recorded like a run_script run (the main file and the
              files it includes in, the PDF out).
            - run_script: run computation code (a script file or a command) in the Project and
              write its Run_Record to .modelforge/runs/<run_id>.json before returning.
            - create_task_plan / update_task_plan: declare a task of several computation steps
              in .modelforge/tasks/<task_id>.json and record the run_id of each step's runs, so
              an interrupted task can resume from its failure point.

            Run check_env before a modeling session so compilation failures are actionable,
            use run_script for every computation whose results go into the paper, so each
            number and figure can be traced to its code and data, then use compile_latex to
            build the paper. For a task of two or more computation steps, call
            create_task_plan before the first run_script, update_task_plan with each run_id
            as the steps finish, and set its status to 已完成 after the last step.
        "#};

        Self {
            tool_router: Self::tool_router() + Self::task_plan_router(),
            instructions,
            run_integration,
            active_runs: Arc::new(ActiveRuns::default()),
        }
    }

    /// Run computation code in the Project and record it (spec requirement 16).
    #[tool(
        name = "run_script",
        description = "Run computation code in the Project (the session working directory) and record it. Give a script file (`script`, with `args`; the interpreter follows the extension: .py, .R, .m, .jl, .js, .sh, .ps1) or a shell command line (`command`, with `code` when the command does not name its code file). Before returning, writes .modelforge/runs/<run_id>.json with the SHA-256 of the code, inputs and outputs, the command, dependencies, seed, exit code and start/end times. Inputs and outputs are detected unless declared. timeout_secs defaults to 600 (1 to 86400); a timed-out or cancelled run is killed and still recorded."
    )]
    pub async fn run_script(
        &self,
        params: Parameters<RunScriptParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let run_context = run_context(&context)?;
        let active = self.active_runs.register(context.id.clone());
        let cancelled = context.ct.clone();
        let stop = async {
            cancelled.cancelled().await;
            active.stop_request().await
        };
        run_script::execute(params.0, run_context, &self.run_integration, stop).await
    }

    async fn run_command_with_timeout(
        &self,
        program: &str,
        args: &[&str],
        cwd: Option<&std::path::Path>,
        timeout: Duration,
    ) -> (bool, String, String) {
        let mut cmd = tokio::process::Command::new(program);
        cmd.args(args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .set_no_window();
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        // Own process group on Unix so the timeout path below can kill the whole tree.
        #[cfg(unix)]
        cmd.process_group(0);

        let child = match cmd.spawn() {
            Ok(child) => child,
            Err(e) => return (false, String::new(), e.to_string()),
        };
        let pid = child.id();
        let mut running = Box::pin(child.wait_with_output());

        // Compilers such as latexmk spawn grandchildren (pdflatex, xelatex) that must not
        // outlive a timeout: on Windows they keep file locks on the output directory, and
        // everywhere they would keep burning CPU. A child-only kill (what dropping the
        // child does) leaves those grandchildren running, so the tree is killed explicitly
        // while the direct child is still alive and the parent/child links are intact.
        tokio::select! {
            result = &mut running => match result {
                Ok(output) => (
                    output.status.success(),
                    String::from_utf8_lossy(&output.stdout).into_owned(),
                    String::from_utf8_lossy(&output.stderr).into_owned(),
                ),
                Err(e) => (false, String::new(), e.to_string()),
            },
            _ = tokio::time::sleep(timeout) => {
                if let Some(pid) = pid {
                    kill_process_tree(pid).await;
                }
                (
                    false,
                    String::new(),
                    format!(
                        "Command timed out after {} seconds and was terminated",
                        timeout.as_secs()
                    ),
                )
            }
        }
    }

    async fn detect_version(&self, program: &str, version_arg: &str) -> Option<String> {
        let (ok, stdout, _) = self
            .run_command_with_timeout(program, &[version_arg], None, Duration::from_secs(8))
            .await;
        if ok {
            Some(
                stdout
                    .lines()
                    .next()
                    .unwrap_or("installed")
                    .trim()
                    .to_string(),
            )
        } else {
            None
        }
    }

    /// Resolve uv: bundled binary first, then PATH; the source is reported to the user.
    async fn detect_uv(&self) -> Option<(String, String, &'static str)> {
        if let Some(path) = resolve_bundled_uv() {
            let program = path.to_string_lossy().into_owned();
            if let Some(version) = self.detect_version(&program, "--version").await {
                return Some((program, version, "bundled"));
            }
        }
        let version = self.detect_version("uv", "--version").await?;
        Some(("uv".to_string(), version, "PATH"))
    }

    /// List uv-managed Python interpreters without triggering a download.
    async fn uv_managed_pythons(&self, uv: &str) -> Vec<String> {
        let (ok, stdout, _) = self
            .run_command_with_timeout(
                uv,
                &["python", "list", "--only-installed"],
                None,
                Duration::from_secs(8),
            )
            .await;
        if !ok {
            return Vec::new();
        }
        stdout.lines().filter_map(uv_python_path).collect()
    }

    /// Detect the Python, uv, and LaTeX/Typst toolchains and report versions.
    #[tool(
        name = "check_env",
        description = "Detect Python, uv, and LaTeX/Typst toolchains. Set install_uv to true to receive uv installation instructions when missing. This tool never downloads or executes installers."
    )]
    pub async fn check_env(
        &self,
        params: Parameters<CheckEnvParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let params = params.0;

        let mut report = String::from("Environment check\n=================\n\nPython\n------\n");

        let uv = self.detect_uv().await;

        let mut python: Option<String> = None;
        for candidate in ["python3", "python", "py"] {
            if let Some(version) = self.detect_version(candidate, "--version").await {
                report.push_str(&format!("{candidate}: {version}\n"));
                python = Some(candidate.to_string());
                break;
            }
        }
        if python.is_none() {
            if let Some((uv, _, _)) = &uv {
                for path in self.uv_managed_pythons(uv).await {
                    if let Some(version) = self.detect_version(&path, "--version").await {
                        report.push_str(&format!("{path}: {version} (uv-managed)\n"));
                        python = Some(path);
                        break;
                    }
                }
            }
        }
        if python.is_none() {
            report.push_str("not found\n");
        }

        report.push_str("\nuv\n--\n");
        match &uv {
            Some((_, version, source)) => {
                report.push_str(&format!("{version} ({source})\n"));
            }
            None => report.push_str("not found\n"),
        }

        if uv.is_none() && params.install_uv {
            report.push_str("\nuv is missing. No installer was executed. Obtain the user's approval before installing.\nOfficial installation instructions: https://docs.astral.sh/uv/getting-started/installation/\n");
        }

        report.push_str("\nLaTeX / Typst compilers\n----------------------\n");
        let compilers = [
            ("latexmk", "-version"),
            ("pdflatex", "--version"),
            ("xelatex", "--version"),
            ("lualatex", "--version"),
            ("tectonic", "--version"),
            ("typst", "--version"),
        ];
        let mut found = false;
        for (program, version_arg) in compilers {
            if let Some(version) = self.detect_version(program, version_arg).await {
                report.push_str(&format!("{program}: {version}\n"));
                found = true;
            }
        }
        if !found {
            report.push_str("none found\n");
        }

        Ok(CallToolResult::success(vec![ContentBlock::Text(
            TextContent::new(report),
        )]))
    }

    /// Compile a LaTeX or Typst document and return the PDF path or parsed error lines.
    #[tool(
        name = "compile_latex",
        description = "Compile a LaTeX (.tex) or Typst (.typ) document and return the PDF path on success or parsed error lines on failure. A relative path is read from the Project (the session working directory). When the document and the PDF are inside the Project, the compilation is recorded in .modelforge/runs/<run_id>.json before returning: the main file as code, the files it includes as inputs, the PDF as output."
    )]
    pub async fn compile_latex(
        &self,
        params: Parameters<CompileLatexParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let run_context = run_context(&context)?;
        let active = self.active_runs.register(context.id.clone());
        let cancelled = context.ct.clone();
        let stop = async {
            cancelled.cancelled().await;
            active.stop_request().await
        };
        self.compile(params.0, run_context, stop).await
    }

    /// The work of [`Self::compile_latex`] for a call in `context`; `stop` resolves when the
    /// caller cancels.
    async fn compile(
        &self,
        params: CompileLatexParams,
        context: RunContext,
        stop: impl std::future::Future<Output = StopRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let command = CompileCommand::new(&params, Some(&context.project_root))
            .map_err(|error| ErrorData::new(ErrorCode::INVALID_PARAMS, error.to_string(), None))?;
        std::fs::create_dir_all(&command.output_dir)
            .map_err(|error| ErrorData::new(ErrorCode::INTERNAL_ERROR, error.to_string(), None))?;
        compile_record::execute(command, context, &self.run_integration, stop).await
    }
}

/// Absolute path to a uv binary bundled beside this executable (resources/bin), if present.
fn resolve_bundled_uv() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let name = if cfg!(windows) { "uv.exe" } else { "uv" };
    let candidate = dir.join(name);
    candidate.is_file().then_some(candidate)
}

/// Extract the interpreter path from one `uv python list --only-installed` line.
fn uv_python_path(line: &str) -> Option<String> {
    let (_, rest) = line.split_once(char::is_whitespace)?;
    let path = rest.trim();
    if path.is_empty() || path.starts_with('<') {
        return None;
    }
    let path = std::path::Path::new(path);
    path.is_file()
        .then_some(path.to_string_lossy().into_owned())
}

struct CompileCommand {
    program: String,
    args: Vec<String>,
    /// The main document, absolute.
    source: PathBuf,
    cwd: PathBuf,
    output_dir: PathBuf,
    pdf_path: PathBuf,
}

impl CompileCommand {
    /// A relative `params.path` is read from `project_root` when there is one, otherwise from
    /// the process working directory.
    fn new(
        params: &CompileLatexParams,
        project_root: Option<&std::path::Path>,
    ) -> anyhow::Result<Self> {
        let requested = std::path::Path::new(&params.path);
        let source = match project_root {
            Some(root) if requested.is_relative() => std::path::absolute(root.join(requested))?,
            _ => std::path::absolute(requested)?,
        };
        anyhow::ensure!(source.is_file(), "File not found: {}", source.display());
        let cwd = source
            .parent()
            .ok_or_else(|| anyhow::anyhow!("Source has no parent directory"))?
            .to_path_buf();
        let output_dir = match &params.output_dir {
            Some(dir) => std::path::absolute(cwd.join(dir))?,
            None => cwd.clone(),
        };
        let pdf_path = output_dir
            .join(source.file_name().unwrap())
            .with_extension("pdf");
        let input = source.to_string_lossy().into_owned();
        let output = output_dir.to_string_lossy().into_owned();
        let program = params.engine.as_deref().unwrap_or("latexmk");
        let args = match program {
            "typst" => vec![
                "compile".into(),
                input,
                pdf_path.to_string_lossy().into_owned(),
            ],
            "tectonic" => vec!["--outdir".into(), output, input],
            "pdflatex" | "xelatex" | "lualatex" => vec![
                "-interaction=nonstopmode".into(),
                "-halt-on-error".into(),
                format!("-output-directory={output}"),
                input,
            ],
            "latexmk" => vec![
                latexmk_flag(&source).into(),
                "-interaction=nonstopmode".into(),
                "-halt-on-error".into(),
                format!("-outdir={output}"),
                input,
            ],
            _ => anyhow::bail!("Unsupported compiler: {program}"),
        };
        Ok(Self {
            program: program.into(),
            args,
            source,
            cwd,
            output_dir,
            pdf_path,
        })
    }

    /// The command line as the Run_Record names it.
    fn command_line(&self) -> String {
        shell_words::join(
            std::iter::once(self.program.as_str()).chain(self.args.iter().map(String::as_str)),
        )
    }
}

/// Pick the `latexmk` PDF flag for `source`. pdflatex cannot typeset CJK, so a
/// Chinese paper (ctex / xeCJK / fontspec / CJK code points) must use `-xelatex`;
/// the templates' `%! TEX program = xelatex` magic comment is honored first.
fn latexmk_flag(source: &std::path::Path) -> &'static str {
    let Ok(text) = std::fs::read_to_string(source) else {
        return "-pdf";
    };

    for line in text.lines().take(10) {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("%! TEX program") {
            let program = rest.trim_start_matches(['=', ' ']).to_ascii_lowercase();
            return match program.as_str() {
                "xelatex" | "xetex" => "-xelatex",
                "lualatex" | "luatex" => "-lualatex",
                "pdflatex" | "pdftex" | "latex" => "-pdf",
                _ => continue,
            };
        }
    }

    let lowered = text.to_ascii_lowercase();
    let cjk_marker = ["ctex", "xecjk", "fontspec", "setcjk", "requirexetex"]
        .iter()
        .any(|marker| lowered.contains(marker))
        || text.chars().any(is_cjk);
    if cjk_marker {
        "-xelatex"
    } else {
        "-pdf"
    }
}

fn is_cjk(c: char) -> bool {
    matches!(
        c,
        '\u{3000}'..='\u{303F}' // CJK punctuation
            | '\u{3400}'..='\u{4DBF}' // Extension A
            | '\u{4E00}'..='\u{9FFF}' // Unified Ideographs
            | '\u{FF00}'..='\u{FFEF}' // fullwidth forms
    )
}

/// Kills a process together with its descendants. Call while the process is still alive:
/// once it exits, the tree relationship is gone and the descendants cannot be found.
async fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = tokio::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await;
    }
    #[cfg(unix)]
    {
        // The child leads its own process group (process_group(0) at spawn), so signalling the
        // negated pid reaches every process in the tree. This calls kill(2) itself and never the
        // kill(1) program: procps-ng's kill (/usr/bin/kill on Debian and Ubuntu) reads only the
        // first digit of a negative pid, so `kill -KILL -12345` sent SIGKILL to -1, i.e. to every
        // process of the user (on CI that took the whole runner down).
        if let Some(group) = process_group_target(pid) {
            // SAFETY: kill(2) takes no pointers. `group` names exactly one process group: it is
            // the negation of a pid greater than 1, so never 0 (our own group) or -1 (everyone).
            unsafe {
                libc::kill(group, libc::SIGKILL);
            }
        }
    }
}

/// The kill(2) target that signals the process group led by `pid`, or `None` when that is not
/// exactly one other group: 0 and 1 would turn into "our own group" and "every process we may
/// signal", and the pid has to fit in `pid_t`.
#[cfg(unix)]
fn process_group_target(pid: u32) -> Option<libc::pid_t> {
    let pid = libc::pid_t::try_from(pid).ok()?;
    (pid > 1).then_some(-pid)
}

fn validate_pdf(path: &std::path::Path, started_at: std::time::SystemTime) -> anyhow::Result<()> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path)?;
    let metadata = file.metadata()?;
    anyhow::ensure!(
        metadata.len() > 1024,
        "PDF is smaller than 1 KiB ({} bytes)",
        metadata.len()
    );

    // Filesystem timestamps can be coarser than SystemTime; allow a small tolerance, but a
    // file clearly older than this run means the compiler did not write a new product.
    let tolerance = std::time::Duration::from_secs(2);
    let earliest = started_at
        .checked_sub(tolerance)
        .unwrap_or(std::time::UNIX_EPOCH);
    anyhow::ensure!(
        metadata.modified()? >= earliest,
        "PDF predates this compilation run"
    );

    let mut signature = [0; 5];
    file.read_exact(&mut signature)?;
    anyhow::ensure!(&signature == b"%PDF-", "Output is not a PDF");

    // A truncated writer stops mid-file: require the EOF marker within the last KiB.
    let tail_start = metadata.len().saturating_sub(1024);
    file.seek(SeekFrom::Start(tail_start))?;
    let mut tail = Vec::with_capacity((metadata.len() - tail_start) as usize);
    file.read_to_end(&mut tail)?;
    anyhow::ensure!(
        tail.windows(5).any(|window| window == b"%%EOF"),
        "PDF is truncated (no %%EOF trailer)"
    );
    Ok(())
}

fn extract_errors(log: &str) -> Vec<String> {
    let mut errors = Vec::new();
    for line in log.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        // LaTeX error marker "!", source-line marker "l.<n>", or generic error lines
        if trimmed.starts_with('!') || trimmed.starts_with("l.") || lower.starts_with("error") {
            errors.push(trimmed.to_string());
        }
        if errors.len() >= 40 {
            break;
        }
    }
    errors
}

fn tail(log: &str, lines: usize) -> String {
    let collected: Vec<&str> = log.lines().collect();
    let start = collected.len().saturating_sub(lines);
    collected[start..].join("\n")
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for ModelingServer {
    fn get_info(&self) -> ServerInfo {
        InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                "goose-modeling",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(self.instructions.clone())
    }

    async fn on_cancelled(
        &self,
        notification: CancelledNotificationParam,
        _context: NotificationContext<RoleServer>,
    ) {
        if let Some(id) = notification.request_id {
            self.active_runs.note_cancelled(&id, notification.reason);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_reasons_reach_the_run_they_belong_to() {
        let runs = Arc::new(ActiveRuns::default());
        let timed_out = runs.register(RequestId::Number(1));
        let cancelled = runs.register(RequestId::Number(2));
        runs.note_cancelled(&RequestId::Number(1), Some("timed out".to_string()));
        runs.note_cancelled(&RequestId::Number(2), None);
        // Unknown ids are ignored rather than remembered forever.
        runs.note_cancelled(&RequestId::Number(3), Some("timed out".to_string()));
        assert_eq!(timed_out.stop_request().await, StopRequest::TimedOut);
        assert_eq!(cancelled.stop_request().await, StopRequest::Cancelled);
        drop(timed_out);
        drop(cancelled);
        assert!(runs.reasons.lock().unwrap().is_empty());
    }

    #[test]
    fn run_script_is_listed() {
        let server = ModelingServer::new();
        assert!(server.get_tool("run_script").is_some());
        assert!(server.instructions.contains("run_script"));
    }

    /// Same allocations, not merely equal values: every default integration holds new `Arc`s.
    fn same_integration(a: &RunIntegration, b: &RunIntegration) -> bool {
        std::ptr::addr_eq(Arc::as_ptr(&a.secrets), Arc::as_ptr(&b.secrets))
            && std::ptr::addr_eq(Arc::as_ptr(&a.observer), Arc::as_ptr(&b.observer))
    }

    // The only test that touches the process-wide integration; it restores it at the end.
    #[test]
    fn builtin_servers_take_the_installed_run_integration() {
        // By default nothing is supplied.
        let installed = builtin_run_integration();
        assert!(run_recorder::SecretValues::secret_values(&*installed.secrets).is_empty());

        let first = RunIntegration::default();
        let previous = set_builtin_run_integration(first.clone());
        let early = ModelingServer::builtin();
        assert!(same_integration(&early.run_integration, &first));

        // A replacement reaches servers created afterwards; earlier ones keep theirs.
        let second = RunIntegration::default();
        let replaced = set_builtin_run_integration(second.clone());
        assert!(same_integration(&replaced, &first));
        assert!(same_integration(&early.run_integration, &first));
        assert!(same_integration(
            &ModelingServer::builtin().run_integration,
            &second
        ));
        assert!(same_integration(&builtin_run_integration(), &second));

        // Explicitly built servers ignore the installed integration.
        assert!(!same_integration(
            &ModelingServer::new().run_integration,
            &second
        ));

        set_builtin_run_integration(previous);
    }

    #[test]
    fn modeling_is_a_builtin_extension() {
        assert!(crate::BUILTIN_EXTENSIONS.contains_key("modeling"));
    }

    #[test]
    fn compilers_keep_source_directory_and_use_requested_output_directory() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source with spaces");
        std::fs::create_dir(&source).unwrap();
        let path = source.join("paper.tex");
        std::fs::write(&path, "document").unwrap();
        for engine in [
            "latexmk", "pdflatex", "xelatex", "lualatex", "tectonic", "typst",
        ] {
            let command = CompileCommand::new(
                &CompileLatexParams {
                    path: path.to_string_lossy().into_owned(),
                    engine: Some(engine.into()),
                    output_dir: Some("results".into()),
                },
                None,
            )
            .unwrap();
            assert_eq!(command.cwd, source);
            assert_eq!(command.pdf_path, source.join("results/paper.pdf"));
            assert!(command.args.contains(&path.to_string_lossy().into_owned()));
            assert!(command.args.iter().any(|arg| arg.contains("results")));
        }
    }

    #[test]
    fn absolute_output_directory_and_multi_dot_filenames_are_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("paper.tex.notes.tex");
        std::fs::write(&path, "document").unwrap();
        let output = dir.path().join("elsewhere");
        let command = CompileCommand::new(
            &CompileLatexParams {
                path: path.to_string_lossy().into_owned(),
                engine: Some("typst".into()),
                output_dir: Some(output.to_string_lossy().into_owned()),
            },
            None,
        )
        .unwrap();
        assert_eq!(command.pdf_path, output.join("paper.tex.notes.pdf"));
    }

    #[test]
    fn relative_documents_are_read_from_the_project() {
        let project = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(project.path().join("paper")).unwrap();
        std::fs::write(project.path().join("paper/main.tex"), "document").unwrap();
        let params = CompileLatexParams {
            path: "paper/main.tex".into(),
            engine: Some("xelatex".into()),
            output_dir: None,
        };
        let command = CompileCommand::new(&params, Some(project.path())).unwrap();
        let source = std::path::absolute(project.path().join("paper/main.tex")).unwrap();
        assert_eq!(command.source, source);
        assert_eq!(command.cwd, source.parent().unwrap());
        assert_eq!(command.pdf_path, source.with_extension("pdf"));
        // The recorded command line reads back as the program and its arguments.
        let mut expected = vec!["xelatex".to_string()];
        expected.extend(command.args.iter().cloned());
        assert_eq!(
            shell_words::split(&command.command_line()).unwrap(),
            expected
        );
    }

    fn latexmk_args_for(path: &std::path::Path) -> Vec<String> {
        CompileCommand::new(
            &CompileLatexParams {
                path: path.to_string_lossy().into_owned(),
                engine: None,
                output_dir: None,
            },
            None,
        )
        .unwrap()
        .args
    }

    #[test]
    fn latexmk_selects_xelatex_for_chinese_sources() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("paper.tex");
        std::fs::write(
            &path,
            "\\documentclass{ctexart}\n\\begin{document}\n中文正文\n\\end{document}",
        )
        .unwrap();
        let args = latexmk_args_for(&path);
        assert!(args.iter().any(|arg| arg == "-xelatex"), "got {args:?}");
        assert!(!args.iter().any(|arg| arg == "-pdf"));
    }

    #[test]
    fn latexmk_selects_pdf_for_plain_english_sources() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("paper.tex");
        std::fs::write(
            &path,
            "\\documentclass{article}\n\\begin{document}\nHello world\n\\end{document}",
        )
        .unwrap();
        let args = latexmk_args_for(&path);
        assert!(args.iter().any(|arg| arg == "-pdf"), "got {args:?}");
        assert!(!args.iter().any(|arg| arg == "-xelatex"));
    }

    #[test]
    fn latexmk_honors_magic_comment_over_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("paper.tex");
        std::fs::write(
            &path,
            "%! TEX program = xelatex\n\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}",
        )
        .unwrap();
        let args = latexmk_args_for(&path);
        assert!(args.iter().any(|arg| arg == "-xelatex"), "got {args:?}");
    }

    #[test]
    fn missing_empty_or_non_pdf_output_is_not_success() {
        let dir = tempfile::tempdir().unwrap();
        let pdf = dir.path().join("paper.pdf");
        let started_at = std::time::SystemTime::now();
        assert!(validate_pdf(&pdf, started_at).is_err());
        std::fs::write(&pdf, "").unwrap();
        assert!(validate_pdf(&pdf, started_at).is_err());
        std::fs::write(&pdf, "not a PDF").unwrap();
        assert!(validate_pdf(&pdf, started_at).is_err());

        // Header alone is not enough: a truncated writer stops before the EOF trailer.
        let mut truncated = b"%PDF-1.7\n".to_vec();
        truncated.resize(4096, b' ');
        std::fs::write(&pdf, &truncated).unwrap();
        assert!(validate_pdf(&pdf, started_at).is_err());

        // A complete shape passes: header, more than 1 KiB of body, EOF trailer.
        let mut valid = b"%PDF-1.7\n".to_vec();
        valid.resize(4096, b' ');
        valid.extend_from_slice(b"%%EOF\n");
        std::fs::write(&pdf, &valid).unwrap();
        assert!(validate_pdf(&pdf, started_at).is_ok());

        // A product older than the run means this run wrote nothing.
        let later_start = started_at + std::time::Duration::from_secs(60);
        assert!(validate_pdf(&pdf, later_start).is_err());
    }

    #[tokio::test]
    async fn commands_time_out_instead_of_hanging() {
        let server = ModelingServer::new();
        let (program, args) = if cfg!(windows) {
            (
                "powershell",
                vec!["-NoProfile", "-Command", "Start-Sleep -Seconds 30"],
            )
        } else {
            ("sleep", vec!["30"])
        };
        let start = std::time::Instant::now();
        let (ok, _, error) = server
            .run_command_with_timeout(program, &args, None, Duration::from_millis(100))
            .await;
        assert!(!ok);
        assert!(error.contains("timed out"));
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[test]
    fn a_process_group_kill_never_targets_our_own_group_or_every_process() {
        // kill(0, ..) signals the caller's own group, kill(-1, ..) every process it may signal.
        assert_eq!(process_group_target(0), None);
        assert_eq!(process_group_target(1), None);
        assert_eq!(process_group_target(2), Some(-2));
        // procps-ng's kill(1) turned "-12345" into -1: every digit has to reach kill(2).
        assert_eq!(process_group_target(12345), Some(-12345));
        assert_eq!(process_group_target(u32::MAX), None);
    }

    /// The whole tree goes and nothing else does. Through procps-ng's kill(1) the group kill
    /// missed the tree (a pid not starting with 1) or reached every process of the user (a pid
    /// starting with 1), this test binary and a CI runner included.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn killing_a_process_tree_takes_the_whole_tree_and_nothing_else() {
        use std::os::unix::process::ExitStatusExt;
        use tokio::io::AsyncBufReadExt;

        let mut tree = tokio::process::Command::new("sh")
            .args(["-c", "sleep 60 & echo $!; wait"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .process_group(0)
            .spawn()
            .unwrap();
        let mut line = String::new();
        tokio::io::BufReader::new(tree.stdout.take().unwrap())
            .read_line(&mut line)
            .await
            .unwrap();
        let grandchild: u32 = line.trim().parse().unwrap();
        let mut bystander = tokio::process::Command::new("sleep")
            .arg("60")
            .kill_on_drop(true)
            .process_group(0)
            .spawn()
            .unwrap();

        kill_process_tree(tree.id().unwrap()).await;

        let status = tokio::time::timeout(Duration::from_secs(10), tree.wait())
            .await
            .expect("the tree's leader should end")
            .unwrap();
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while process_is_running(grandchild) {
            assert!(
                std::time::Instant::now() < deadline,
                "grandchild {grandchild} survived the tree kill"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            bystander.try_wait().unwrap().is_none(),
            "a process outside the tree was killed"
        );
        bystander.kill().await.unwrap();
    }

    /// Whether `pid` is running: neither gone nor an exited process waiting to be reaped.
    #[cfg(target_os = "linux")]
    fn process_is_running(pid: u32) -> bool {
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            return false;
        };
        // The state follows the parenthesised command name, which may itself contain ") ".
        stat.rsplit_once(") ")
            .and_then(|(_, rest)| rest.chars().next())
            .is_some_and(|state| state != 'Z')
    }

    #[tokio::test]
    #[ignore = "starts real processes; run manually to verify tree termination"]
    async fn timeout_terminates_the_whole_process_tree() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("pids.txt");
        let pid_path = pid_file.to_string_lossy().into_owned();

        // The direct child records its own pid and spawns a grandchild (a minute of sleep)
        // whose pid it records too; a child-only kill would leave the grandchild running.
        let server = ModelingServer::new();
        let (ok, _, error) = if cfg!(windows) {
            let script = format!(
                "$g = Start-Process powershell -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru -WindowStyle Hidden; \
Set-Content -Path '{pid_path}' -Value \"$PID`n$($g.Id)\"; Start-Sleep -Seconds 60"
            );
            server
                .run_command_with_timeout(
                    "powershell",
                    &["-NoProfile", "-Command", &script],
                    None,
                    Duration::from_secs(2),
                )
                .await
        } else {
            let script =
                format!("echo $$ > '{pid_path}'; sleep 60 & echo $! >> '{pid_path}'; sleep 60");
            server
                .run_command_with_timeout("sh", &["-c", &script], None, Duration::from_secs(2))
                .await
        };
        assert!(!ok);
        assert!(error.contains("timed out"));

        let mut pids: Vec<String> = Vec::new();
        for _ in 0..40 {
            if let Ok(contents) = std::fs::read_to_string(&pid_file) {
                pids = contents
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .map(String::from)
                    .collect();
                if pids.len() >= 2 {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(
            pids.len() >= 2,
            "child/grandchild never recorded their pids: {pids:?}"
        );

        let pid_alive = |pid: &str| {
            let pid = pid.to_string();
            let server = ModelingServer::new();
            async move {
                if cfg!(windows) {
                    let filter = format!("PID eq {pid}");
                    let (_, stdout, _) = server
                        .run_command_with_timeout(
                            "tasklist",
                            &["/FI", &filter, "/NH"],
                            None,
                            Duration::from_secs(10),
                        )
                        .await;
                    stdout.contains(&pid)
                } else {
                    let (ok, _, _) = server
                        .run_command_with_timeout(
                            "kill",
                            &["-0", &pid],
                            None,
                            Duration::from_secs(10),
                        )
                        .await;
                    ok
                }
            }
        };

        // Give the kill a moment, then assert both the child and the grandchild are gone.
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let child_alive = pid_alive(&pids[0]).await;
        let grandchild_alive = pid_alive(&pids[1]).await;
        assert!(
            !child_alive && !grandchild_alive,
            "survivors after timeout kill: child={child_alive} ({}) grandchild={grandchild_alive} ({})",
            pids[0],
            pids[1]
        );
    }

    #[tokio::test]
    #[ignore = "requires a local latexmk and TeX installation"]
    async fn real_latex_compilation_resolves_inputs_and_writes_separate_output() {
        let dir = tempfile::Builder::new()
            .prefix("modelforge latex ")
            .tempdir()
            .unwrap();
        let source = dir.path().join("source files");
        std::fs::create_dir(&source).unwrap();
        let path = source.join("paper.tex");
        std::fs::write(source.join("section.tex"), "Verified relative input.").unwrap();
        std::fs::write(
            &path,
            r"\documentclass{article}
\begin{document}
\input{section.tex}
\end{document}",
        )
        .unwrap();
        let result = compile_in(
            dir.path(),
            CompileLatexParams {
                path: path.to_string_lossy().into_owned(),
                engine: Some("latexmk".into()),
                output_dir: Some("output files".into()),
            },
        )
        .await;
        assert_ne!(result.is_error, Some(true), "{result:?}");
        assert!(source.join("output files/paper.pdf").is_file());
        assert!(!source.join("paper.pdf").exists());
    }

    /// What `compile_latex` returns for a call whose working directory is `project`.
    async fn compile_in(project: &std::path::Path, params: CompileLatexParams) -> CallToolResult {
        let context = RunContext {
            project_root: project.to_path_buf(),
            provider: None,
            model: None,
            tool_call_id: None,
            notifier: None,
        };
        ModelingServer::new()
            .compile(params, context, std::future::pending())
            .await
            .unwrap()
    }

    #[tokio::test]
    #[ignore = "requires a local xelatex + ctex installation"]
    async fn real_chinese_compilation_selects_xelatex_and_writes_pdf() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("paper.tex");
        std::fs::write(
            &path,
            "\\documentclass{ctexart}\n\\begin{document}\n中文正文测试。\n\\end{document}",
        )
        .unwrap();
        let result = compile_in(
            dir.path(),
            CompileLatexParams {
                path: path.to_string_lossy().into_owned(),
                engine: None,
                output_dir: None,
            },
        )
        .await;
        assert_ne!(result.is_error, Some(true), "{result:?}");
        assert!(dir.path().join("paper.pdf").is_file());
    }

    #[tokio::test]
    #[ignore = "requires a local latexmk and TeX installation"]
    async fn failed_compilation_does_not_leave_a_stale_pdf_behind() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("paper.tex");
        std::fs::write(
            &path,
            r"\documentclass{article}
\begin{document}
First version.
\end{document}",
        )
        .unwrap();
        let compile = |path: std::path::PathBuf| {
            let root = dir.path().to_path_buf();
            async move {
                compile_in(
                    &root,
                    CompileLatexParams {
                        path: path.to_string_lossy().into_owned(),
                        engine: Some("latexmk".into()),
                        output_dir: None,
                    },
                )
                .await
            }
        };

        let first = compile(path.clone()).await;
        assert_ne!(first.is_error, Some(true), "{first:?}");
        let pdf = dir.path().join("paper.pdf");
        assert!(pdf.is_file());

        // Break the source: the rerun must fail and must not leave the previous PDF as a
        // product that a caller could mistake for this run's output.
        std::fs::write(
            &path,
            r"\documentclass{article}\begin{document}\undefinedcommand",
        )
        .unwrap();
        let second = compile(path.clone()).await;
        assert_eq!(second.is_error, Some(true), "{second:?}");
        assert!(!pdf.exists(), "stale PDF survived a failed recompilation");
    }

    #[tokio::test]
    async fn test_modeling_server_creation() {
        let server = ModelingServer::new();
        assert!(!server.instructions.is_empty());
    }

    #[tokio::test]
    async fn test_get_info() {
        let server = ModelingServer::new();
        let info = server.get_info();

        assert_eq!(info.server_info.name, "goose-modeling");
        assert!(info.instructions.is_some());
    }

    #[test]
    fn test_extract_errors() {
        let log =
            "This is fine\n! Undefined control sequence.\nl.42 \\badcmd\n\nAnother error line";
        let errors = extract_errors(log);
        assert!(errors.iter().any(|e| e.starts_with('!')));
        assert!(errors.iter().any(|e| e.starts_with("l.42")));
    }

    #[test]
    fn test_tail() {
        let log = "a\nb\nc\nd\ne";
        assert_eq!(tail(log, 2), "d\ne");
    }
}
