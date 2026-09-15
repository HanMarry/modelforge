use indoc::formatdoc;
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{
        CallToolResult, ContentBlock, ErrorCode, ErrorData, Implementation, InitializeResult,
        ServerCapabilities, ServerInfo, TextContent,
    },
    schemars::JsonSchema,
    tool, tool_handler, tool_router, ServerHandler,
};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, time::Duration};

use crate::subprocess::SubprocessExt;

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

/// Modeling tools MCP server providing LaTeX compilation and toolchain detection.
#[derive(Clone)]
pub struct ModelingServer {
    tool_router: ToolRouter<Self>,
    instructions: String,
}

impl Default for ModelingServer {
    fn default() -> Self {
        Self::new()
    }
}

#[tool_router(router = tool_router)]
impl ModelingServer {
    pub fn new() -> Self {
        let instructions = formatdoc! {r#"
            Tools for the mathematical-modeling pipeline:
            - check_env: detect Python, uv, and LaTeX/Typst toolchains; provide installation instructions.
            - compile_latex: compile a LaTeX/Typst document and surface error lines.

            Run check_env before a modeling session so compilation failures are actionable,
            then use compile_latex to build the paper.
        "#};

        Self {
            tool_router: Self::tool_router(),
            instructions,
        }
    }

    async fn run_command(
        &self,
        program: &str,
        args: &[&str],
        cwd: Option<&std::path::Path>,
    ) -> (bool, String, String) {
        self.run_command_with_timeout(program, args, cwd, Duration::from_secs(180))
            .await
    }

    async fn run_command_with_timeout(
        &self,
        program: &str,
        args: &[&str],
        cwd: Option<&std::path::Path>,
        timeout: Duration,
    ) -> (bool, String, String) {
        let mut cmd = tokio::process::Command::new(program);
        cmd.args(args).kill_on_drop(true).set_no_window();
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        match tokio::time::timeout(timeout, cmd.output()).await {
            Ok(Ok(output)) => (
                output.status.success(),
                String::from_utf8_lossy(&output.stdout).into_owned(),
                String::from_utf8_lossy(&output.stderr).into_owned(),
            ),
            Ok(Err(e)) => (false, String::new(), e.to_string()),
            Err(_) => (
                false,
                String::new(),
                format!("Command timed out after {} seconds", timeout.as_secs()),
            ),
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

        let mut python = None;
        for candidate in ["python3", "python", "py"] {
            if let Some(version) = self.detect_version(candidate, "--version").await {
                report.push_str(&format!("{candidate}: {version}\n"));
                python = Some(candidate);
                break;
            }
        }
        if python.is_none() {
            report.push_str("not found\n");
        }

        report.push_str("\nuv\n--\n");
        let mut has_uv = false;
        match self.detect_version("uv", "--version").await {
            Some(version) => {
                report.push_str(&format!("{version}\n"));
                has_uv = true;
            }
            None => report.push_str("not found\n"),
        }

        if !has_uv && params.install_uv {
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
        description = "Compile a LaTeX (.tex) or Typst (.typ) document and return the PDF path on success or parsed error lines on failure."
    )]
    pub async fn compile_latex(
        &self,
        params: Parameters<CompileLatexParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let params = params.0;

        let command = CompileCommand::new(&params)
            .map_err(|error| ErrorData::new(ErrorCode::INVALID_PARAMS, error.to_string(), None))?;
        std::fs::create_dir_all(&command.output_dir)
            .map_err(|error| ErrorData::new(ErrorCode::INTERNAL_ERROR, error.to_string(), None))?;
        let args: Vec<&str> = command.args.iter().map(String::as_str).collect();
        let program = command.program.as_str();
        let (ok, stdout, stderr) = self.run_command(program, &args, Some(&command.cwd)).await;

        if ok {
            if let Err(error) = validate_pdf(&command.pdf_path) {
                return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                    "{program} exited successfully but did not produce a valid PDF at {}: {error}\n{}",
                    command.pdf_path.display(),
                    tail(&format!("{stdout}\n{stderr}"), 40)
                ))]));
            }
            let summary = format!(
                "Compiled successfully with {program}.\n\nOutput: {}",
                command.pdf_path.display()
            );
            return Ok(CallToolResult::success(vec![ContentBlock::Text(
                TextContent::new(summary),
            )]));
        }

        let log = format!("{stdout}\n{stderr}");
        let errors = extract_errors(&log);

        let mut message = format!("Compilation failed with {program}.\n\n");
        if errors.is_empty() {
            message.push_str("No parseable error lines found. Raw log tail:\n\n");
            message.push_str(&tail(&log, 40));
        } else {
            message.push_str("Errors:\n\n");
            for error in errors {
                message.push_str(&format!("{error}\n"));
            }
        }

        Ok(CallToolResult::error(vec![ContentBlock::Text(
            TextContent::new(message),
        )]))
    }
}

struct CompileCommand {
    program: String,
    args: Vec<String>,
    cwd: PathBuf,
    output_dir: PathBuf,
    pdf_path: PathBuf,
}

impl CompileCommand {
    fn new(params: &CompileLatexParams) -> anyhow::Result<Self> {
        let source = std::path::absolute(&params.path)?;
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
                "-pdf".into(),
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
            cwd,
            output_dir,
            pdf_path,
        })
    }
}

fn validate_pdf(path: &std::path::Path) -> anyhow::Result<()> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut signature = [0; 5];
    file.read_exact(&mut signature)?;
    anyhow::ensure!(&signature == b"%PDF-", "Output is not a PDF");
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
            let command = CompileCommand::new(&CompileLatexParams {
                path: path.to_string_lossy().into_owned(),
                engine: Some(engine.into()),
                output_dir: Some("results".into()),
            })
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
        let command = CompileCommand::new(&CompileLatexParams {
            path: path.to_string_lossy().into_owned(),
            engine: Some("typst".into()),
            output_dir: Some(output.to_string_lossy().into_owned()),
        })
        .unwrap();
        assert_eq!(command.pdf_path, output.join("paper.tex.notes.pdf"));
    }

    #[test]
    fn missing_empty_or_non_pdf_output_is_not_success() {
        let dir = tempfile::tempdir().unwrap();
        let pdf = dir.path().join("paper.pdf");
        assert!(validate_pdf(&pdf).is_err());
        std::fs::write(&pdf, "").unwrap();
        assert!(validate_pdf(&pdf).is_err());
        std::fs::write(&pdf, "not a PDF").unwrap();
        assert!(validate_pdf(&pdf).is_err());
        std::fs::write(&pdf, "%PDF-1.7\n").unwrap();
        assert!(validate_pdf(&pdf).is_ok());
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
        let result = ModelingServer::new()
            .compile_latex(Parameters(CompileLatexParams {
                path: path.to_string_lossy().into_owned(),
                engine: Some("latexmk".into()),
                output_dir: Some("output files".into()),
            }))
            .await
            .unwrap();
        assert_ne!(result.is_error, Some(true), "{result:?}");
        assert!(source.join("output files/paper.pdf").is_file());
        assert!(!source.join("paper.pdf").exists());
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
