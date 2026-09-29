//! `_goose/unstable/tasks/resume` (spec mathmodel-parity-and-beyond, task 25.4): continue an
//! interrupted long task from the step the desktop planned.
//!
//! The modeling extension's `create_task_plan` / `update_task_plan` tools write the plan,
//! `<project>/.modelforge/tasks/<taskId>.json`, with each step's run ids. After an interruption
//! the desktop checks the steps against their Run_Records (`utils/resumePlanner.ts`, the only
//! implementation of the skip rule) and sends the result here. The Kernel does not check the
//! steps again; it only makes sure the request still matches the plan file, then:
//!
//! 1. `resumeFrom` null: nothing is left to run, the plan becomes 已完成 (`completed`).
//! 2. Output files that `resumeFrom` and the steps after it wrote last time and that still exist
//!    are listed with size and modification time and confirmed through
//!    `_goose/unstable/tasks/confirm-overwrite`. Anything but an explicit confirm leaves every
//!    output file and Run_Record as it is and the plan 已暂停 (`paused`, requirement 22.6).
//! 3. Otherwise the plan becomes 执行中 and a new turn starts in the session: the model gets the
//!    skipped steps, the step to run from and why it failed the check, runs the remaining steps
//!    with `run_script` and records them with `update_task_plan`. The response (`resumed`) is sent
//!    once the turn has started; progress arrives as usual through `session/update`.
//!
//! Contract: `.kiro/specs/mathmodel-parity-and-beyond/layer-c-contract-acp.md`. The plan format
//! is `ui/desktop/src/types/taskPlan.ts`; goose does not depend on goose-run-record yet (task
//! 21.7 adds it), so the few checks needed here are repeated below.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use agent_client_protocol::schema::v1::{
    ContentBlock, ContentChunk, PromptRequest, SessionId, SessionNotification, SessionUpdate,
    StopReason, TextContent,
};
use goose_sdk_types::custom_requests::{
    ConfirmOverwriteAction, ConfirmOverwriteRequest, OverwriteFileInfo, ResumeTaskOutcome,
    ResumeTaskRequest, ResumeTaskResponse, RESUME_TASK_METHOD,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing::warn;

use super::modelforge_capabilities::{capability_not_declared, TASK_RESUME_REQUESTS};
use super::GooseAcpAgent;

/// Error `data.code` values of this method.
const INVALID_TASK_ID: &str = "INVALID_TASK_ID";
const TASK_NOT_FOUND: &str = "TASK_NOT_FOUND";
const INVALID_TASK_PLAN: &str = "INVALID_TASK_PLAN";
/// `skip` / `resumeFrom` do not fit the plan file any more; the desktop should plan again.
const STALE_RESUME_PLAN: &str = "STALE_RESUME_PLAN";
/// The session already runs a turn; resuming would interleave two of them.
const SESSION_BUSY: &str = "SESSION_BUSY";
const TASK_PLAN_WRITE_FAILED: &str = "TASK_PLAN_WRITE_FAILED";

const STATUS_RUNNING: &str = "执行中";
const STATUS_PAUSED: &str = "已暂停";
const STATUS_COMPLETED: &str = "已完成";
const TASK_PLAN_SCHEMA_VERSION: u32 = 1;
const MAX_TASK_ID_LEN: usize = 128;

/// The task plan file as `types/taskPlan.ts` defines it, fields in the order the desktop writes
/// them. Unknown fields are dropped on rewrite, as the desktop drops them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskPlanFile {
    schema_version: u32,
    task_id: String,
    title: String,
    status: String,
    #[serde(default)]
    dismissed: bool,
    created_at: String,
    steps: Vec<TaskStepFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskStepFile {
    id: String,
    title: String,
    run_ids: Vec<String>,
}

/// The part of a Run_Record the overwrite check needs.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordedOutputs {
    run_id: String,
    outputs: Vec<RecordedFile>,
}

#[derive(Debug, Deserialize)]
struct RecordedFile {
    path: String,
}

#[derive(Debug)]
enum PlanReadError {
    NotFound,
    Invalid(String),
}

impl GooseAcpAgent {
    pub(super) async fn on_resume_task(
        &self,
        req: ResumeTaskRequest,
    ) -> Result<ResumeTaskResponse, agent_client_protocol::Error> {
        if !self.supports_task_resume_requests() {
            return Err(capability_not_declared(
                TASK_RESUME_REQUESTS,
                RESUME_TASK_METHOD,
            ));
        }
        if !is_task_id(&req.task_id) {
            return Err(resume_error(
                INVALID_TASK_ID,
                format!("{:?} is not a task id", req.task_id),
            ));
        }
        let project_root = self.task_project_root(&req.session_id).await?;
        let mut plan = read_plan(&project_root, &req.task_id).map_err(|error| match error {
            PlanReadError::NotFound => resume_error(
                TASK_NOT_FOUND,
                format!(
                    "no task plan .modelforge/tasks/{}.json in {}",
                    req.task_id,
                    project_root.display()
                ),
            ),
            PlanReadError::Invalid(message) => resume_error(INVALID_TASK_PLAN, message),
        })?;
        let resume_index = resume_step_index(&plan, &req.skip, req.resume_from.as_deref())
            .map_err(|message| resume_error(STALE_RESUME_PLAN, message))?;

        let Some(resume_index) = resume_index else {
            plan.status = STATUS_COMPLETED.to_string();
            write_plan(&project_root, &plan).map_err(plan_write_error)?;
            return Ok(ResumeTaskResponse {
                outcome: ResumeTaskOutcome::Completed,
            });
        };

        if self
            .active_prompt_runs
            .lock()
            .await
            .contains_key(&req.session_id)
        {
            return Err(resume_error(
                SESSION_BUSY,
                "the session is running a turn; resume the task when it has finished",
            ));
        }

        let files = existing_outputs(&project_root, &plan.steps[resume_index..]);
        if !files.is_empty() {
            let action = self
                .confirm_overwrite(ConfirmOverwriteRequest {
                    session_id: req.session_id.clone(),
                    task_id: req.task_id.clone(),
                    step_id: plan.steps[resume_index].id.clone(),
                    working_dir: project_root.to_string_lossy().into_owned(),
                    files: files.clone(),
                })
                .await;
            if action != ConfirmOverwriteAction::Confirm {
                // Only the plan changes; every output file and Run_Record stays as it is.
                plan.status = STATUS_PAUSED.to_string();
                write_plan(&project_root, &plan).map_err(plan_write_error)?;
                return Ok(ResumeTaskResponse {
                    outcome: ResumeTaskOutcome::Paused,
                });
            }
        }

        let Some(cx) = self.client_cx.get().cloned() else {
            return Err(agent_client_protocol::Error::internal_error()
                .data("no client connection to run the task in"));
        };
        let previous_status = std::mem::replace(&mut plan.status, STATUS_RUNNING.to_string());
        write_plan(&project_root, &plan).map_err(plan_write_error)?;

        let text = resume_prompt(&plan, &req, resume_index, &files);
        if let Err(error) = self.start_resume_turn(&cx, &req, project_root.clone(), text) {
            plan.status = previous_status;
            if let Err(write_error) = write_plan(&project_root, &plan) {
                warn!(
                    task_id = %req.task_id,
                    error = %write_error,
                    "could not restore the task status"
                );
            }
            return Err(error);
        }
        Ok(ResumeTaskResponse {
            outcome: ResumeTaskOutcome::Resumed,
        })
    }

    /// The session's working directory, which is the Project of its tasks.
    async fn task_project_root(
        &self,
        session_id: &str,
    ) -> Result<PathBuf, agent_client_protocol::Error> {
        let session = self
            .session_manager
            .get_session(session_id, false)
            .await
            .map_err(|_| {
                agent_client_protocol::Error::resource_not_found(Some(session_id.to_string()))
                    .data(format!("Session not found: {session_id}"))
            })?;
        Ok(session.working_dir)
    }

    /// Starts the resume turn in the background, the way `session/prompt` runs one, and returns
    /// once it is under way. A turn that fails or is cancelled leaves the task 已暂停 unless the
    /// model already marked it otherwise.
    fn start_resume_turn(
        &self,
        cx: &agent_client_protocol::ConnectionTo<agent_client_protocol::Client>,
        req: &ResumeTaskRequest,
        project_root: PathBuf,
        text: String,
    ) -> Result<(), agent_client_protocol::Error> {
        let session_id = SessionId::new(req.session_id.clone());
        // A client never gets its own prompt back; this one has no client prompt, so the
        // transcript shows the instruction the model received.
        if let Err(error) = cx.send_notification(SessionNotification::new(
            session_id.clone(),
            SessionUpdate::UserMessageChunk(ContentChunk::new(ContentBlock::Text(
                TextContent::new(text.clone()),
            ))),
        )) {
            warn!(
                session_id = %req.session_id,
                error = ?error,
                "could not show the resume instruction"
            );
        }

        let prompt =
            PromptRequest::new(session_id, vec![ContentBlock::Text(TextContent::new(text))]);
        let agent = Arc::new(self.shared_handle());
        let task_cx = cx.clone();
        let task_id = req.task_id.clone();
        let log_session_id = req.session_id.clone();
        cx.spawn(async move {
            let stopped = match agent.on_prompt(&task_cx, prompt).await {
                Ok(response) => response.stop_reason == StopReason::Cancelled,
                Err(error) => {
                    warn!(
                        session_id = %log_session_id,
                        task_id = %task_id,
                        error = ?error,
                        "the resumed task could not run"
                    );
                    true
                }
            };
            if stopped {
                pause_if_running(&project_root, &task_id);
            }
            // An error here would shut the connection down; the outcome is logged above.
            Ok(())
        })
    }

    /// An owned handle on this agent's state for the background turn. Custom requests only get
    /// `&self`, so the turn cannot borrow the agent; every field is shared (`Arc`s and copies of
    /// the negotiated client capabilities), so the turn behaves exactly like one started by
    /// `session/prompt` on this connection: same sessions, active-run registry and cancellation.
    fn shared_handle(&self) -> GooseAcpAgent {
        GooseAcpAgent {
            sessions: self.sessions.clone(),
            active_prompt_runs: self.active_prompt_runs.clone(),
            closed_session_ids: self.closed_session_ids.clone(),
            agent_manager: self.agent_manager.clone(),
            provider_factory: self.provider_factory.clone(),
            builtin_selection: self.builtin_selection.clone(),
            client_fs_capabilities: self.client_fs_capabilities.clone(),
            client_terminal: self.client_terminal.clone(),
            client_mcp_host_info: self.client_mcp_host_info.clone(),
            client_supports_acp_elicitation: self.client_supports_acp_elicitation.clone(),
            client_supports_goose_custom_notifications: self
                .client_supports_goose_custom_notifications
                .clone(),
            client_supports_recipe_param_requests: self
                .client_supports_recipe_param_requests
                .clone(),
            client_supports_checkpoint_requests: self.client_supports_checkpoint_requests.clone(),
            client_modelforge_capabilities: self.client_modelforge_capabilities.clone(),
            client_requests_tool_call_label_enrichment: self
                .client_requests_tool_call_label_enrichment
                .clone(),
            use_login_shell_path: self.use_login_shell_path.clone(),
            client_cx: self.client_cx.clone(),
            thinking_effort_update_tx: self.thinking_effort_update_tx.clone(),
            // The receiver belongs to the connection's forwarder, which this handle never runs.
            thinking_effort_update_rx: Mutex::new(None),
            config_dir: self.config_dir.clone(),
            session_manager: self.session_manager.clone(),
            permission_manager: self.permission_manager.clone(),
            disable_session_naming: self.disable_session_naming,
            provider_inventory: self.provider_inventory.clone(),
            additional_source_roots: self.additional_source_roots.clone(),
            session_cwd: self.session_cwd.clone(),
            recipe_path_cache: self.recipe_path_cache.clone(),
        }
    }
}

fn resume_error(code: &str, message: impl Into<String>) -> agent_client_protocol::Error {
    agent_client_protocol::Error::invalid_params().data(serde_json::json!({
        "code": code,
        "message": message.into(),
    }))
}

fn plan_write_error(error: anyhow::Error) -> agent_client_protocol::Error {
    agent_client_protocol::Error::internal_error().data(serde_json::json!({
        "code": TASK_PLAN_WRITE_FAILED,
        "message": format!("{error:#}"),
    }))
}

/// `[0-9A-Za-z][0-9A-Za-z_-]{0,127}`: safe as a file name everywhere.
fn is_task_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_TASK_ID_LEN
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-')
}

/// `YYYYMMDDTHHMMSSmmm-<6 of [0-9a-z]>`, as Run_Record run ids.
fn is_run_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 25
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 => *byte == b'T',
            18 => *byte == b'-',
            0..=17 => byte.is_ascii_digit(),
            _ => byte.is_ascii_digit() || byte.is_ascii_lowercase(),
        })
}

/// Not absolute, no drive letter, no NUL and no `..` segment, like Run_Record paths.
fn is_project_relative_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.contains(&0) || matches!(bytes.first(), Some(b'/' | b'\\')) {
        return false;
    }
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return false;
    }
    !value.split(['/', '\\']).any(|segment| segment == "..")
}

fn tasks_dir(project_root: &Path) -> PathBuf {
    project_root.join(".modelforge").join("tasks")
}

fn plan_path(project_root: &Path, task_id: &str) -> PathBuf {
    tasks_dir(project_root).join(format!("{task_id}.json"))
}

fn read_plan(project_root: &Path, task_id: &str) -> Result<TaskPlanFile, PlanReadError> {
    let path = plan_path(project_root, task_id);
    let text = match fs_err::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(PlanReadError::NotFound)
        }
        Err(error) => return Err(PlanReadError::Invalid(error.to_string())),
    };
    let plan: TaskPlanFile = serde_json::from_str(&text)
        .map_err(|error| PlanReadError::Invalid(format!("{}: {error}", path.display())))?;
    let problems = plan_problems(&plan, task_id);
    if !problems.is_empty() {
        return Err(PlanReadError::Invalid(format!(
            "{}: invalid fields {}",
            path.display(),
            problems.join(", ")
        )));
    }
    Ok(plan)
}

/// The checks this module relies on; the desktop's `validateTaskPlan` is the full contract.
fn plan_problems(plan: &TaskPlanFile, task_id: &str) -> Vec<String> {
    let mut problems = Vec::new();
    if plan.schema_version != TASK_PLAN_SCHEMA_VERSION {
        problems.push("schemaVersion".to_string());
    }
    if plan.task_id != task_id {
        problems.push("taskId".to_string());
    }
    if ![STATUS_RUNNING, STATUS_PAUSED, STATUS_COMPLETED].contains(&plan.status.as_str()) {
        problems.push("status".to_string());
    }
    let mut seen = HashSet::new();
    for (index, step) in plan.steps.iter().enumerate() {
        if step.id.is_empty() || !seen.insert(step.id.as_str()) {
            problems.push(format!("steps[{index}].id"));
        }
        for (run, run_id) in step.run_ids.iter().enumerate() {
            if !is_run_id(run_id) {
                problems.push(format!("steps[{index}].runIds[{run}]"));
            }
        }
    }
    problems
}

/// Replaces the plan file atomically, in the layout of the desktop's `serializeTaskPlan`.
fn write_plan(project_root: &Path, plan: &TaskPlanFile) -> anyhow::Result<()> {
    let dir = tasks_dir(project_root);
    let mut text = serde_json::to_string_pretty(plan)?;
    text.push('\n');
    let mut temp = tempfile::Builder::new()
        .prefix(".task-")
        .suffix(".tmp")
        .tempfile_in(&dir)?;
    temp.write_all(text.as_bytes())?;
    temp.as_file().sync_all()?;
    temp.persist(plan_path(project_root, &plan.task_id))?;
    Ok(())
}

/// After a failed or cancelled resume turn: 执行中 becomes 已暂停, anything the model set stays.
fn pause_if_running(project_root: &Path, task_id: &str) {
    let Ok(mut plan) = read_plan(project_root, task_id) else {
        return;
    };
    if plan.status == STATUS_RUNNING {
        plan.status = STATUS_PAUSED.to_string();
        if let Err(error) = write_plan(project_root, &plan) {
            warn!(task_id = %task_id, error = %error, "could not mark the task paused");
        }
    }
}

/// Where the resume starts, if the request still fits the plan: `skip` must be the plan's first
/// steps in order and `resumeFrom` the step right after them, or null when `skip` covers every
/// step. The skip rule itself is not checked again.
fn resume_step_index(
    plan: &TaskPlanFile,
    skip: &[String],
    resume_from: Option<&str>,
) -> Result<Option<usize>, String> {
    if skip.len() > plan.steps.len() {
        return Err(format!(
            "skip lists {} steps but the plan has {}",
            skip.len(),
            plan.steps.len()
        ));
    }
    for (index, (skipped, step)) in skip.iter().zip(&plan.steps).enumerate() {
        if *skipped != step.id {
            return Err(format!(
                "skip[{index}] is {skipped:?}, but step {index} of the plan is {:?}",
                step.id
            ));
        }
    }
    match (resume_from, plan.steps.get(skip.len())) {
        (None, None) => Ok(None),
        (None, Some(step)) => Err(format!(
            "resumeFrom is null, but step {:?} has not been skipped",
            step.id
        )),
        (Some(step_id), Some(step)) if step.id == step_id => Ok(Some(skip.len())),
        (Some(step_id), _) => Err(format!(
            "resumeFrom {step_id:?} is not the step after the skipped ones"
        )),
    }
}

/// Output files that the latest runs of `steps` wrote and that still exist, each once, in step
/// and record order: running those steps again overwrites them (requirement 22.3). A step
/// without a readable Run_Record lists nothing.
fn existing_outputs(project_root: &Path, steps: &[TaskStepFile]) -> Vec<OverwriteFileInfo> {
    let runs_dir = project_root.join(".modelforge").join("runs");
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for run_id in steps.iter().flat_map(|step| &step.run_ids) {
        if !is_run_id(run_id) {
            continue;
        }
        let Ok(text) = fs_err::read_to_string(runs_dir.join(format!("{run_id}.json"))) else {
            continue;
        };
        let Ok(record) = serde_json::from_str::<RecordedOutputs>(&text) else {
            continue;
        };
        if record.run_id != *run_id {
            continue;
        }
        for output in record.outputs {
            if !is_project_relative_path(&output.path) || seen.contains(&output.path) {
                continue;
            }
            let Ok(metadata) = std::fs::metadata(project_root.join(&output.path)) else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            seen.insert(output.path.clone());
            files.push(OverwriteFileInfo {
                path: output.path,
                size: metadata.len(),
                modified_at: format_modified(metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH)),
            });
        }
    }
    files
}

/// ISO 8601 with milliseconds and the local offset, like Run_Record timestamps.
fn format_modified(time: SystemTime) -> String {
    chrono::DateTime::<chrono::Local>::from(time)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
}

fn describe_step(step: &TaskStepFile) -> String {
    if step.title.is_empty() {
        format!("「{}」", step.id)
    } else {
        format!("「{}」（id: {}）", step.title, step.id)
    }
}

fn describe_steps(steps: &[TaskStepFile]) -> String {
    if steps.is_empty() {
        return "无".to_string();
    }
    steps
        .iter()
        .map(describe_step)
        .collect::<Vec<_>>()
        .join("、")
}

/// The user message of the resume turn: what was checked, where to start, why, and how to keep
/// the plan up to date.
fn resume_prompt(
    plan: &TaskPlanFile,
    req: &ResumeTaskRequest,
    resume_index: usize,
    overwritten: &[OverwriteFileInfo],
) -> String {
    let resume_step = &plan.steps[resume_index];
    let reasons = if req.stale_reasons.is_empty() {
        "无".to_string()
    } else {
        serde_json::to_string(&req.stale_reasons).unwrap_or_else(|_| "无".to_string())
    };
    let mut text = format!(
        "继续执行中断的任务「{title}」（task_id: {task_id}，计划文件 .modelforge/tasks/{task_id}.json）。\n\n\
         桌面端已按各步骤的 Run_Record 核对过当前 Project 文件：\n\
         - 可以跳过的步骤（记录完整、退出码为 0，输入、代码与输出的哈希都与当前文件一致）：{skipped}。不要重新执行这些步骤，直接使用它们的输出。\n\
         - 从步骤{resume}开始执行，之后依次执行：{later}。\n\
         - 该步骤未通过核对的原因（JSON）：{reasons}\n",
        title = plan.title,
        task_id = plan.task_id,
        skipped = describe_steps(&plan.steps[..resume_index]),
        resume = describe_step(resume_step),
        later = describe_steps(&plan.steps[resume_index + 1..]),
    );
    if !overwritten.is_empty() {
        let paths: Vec<&str> = overwritten.iter().map(|file| file.path.as_str()).collect();
        text.push_str(&format!(
            "- 用户已确认可以覆盖这些已有的输出文件：{}\n",
            paths.join("、")
        ));
    }
    text.push_str(&format!(
        "\n要求：\n\
         1. 每个计算步骤都用 run_script 运行。\n\
         2. 每次运行后调用 update_task_plan 记录 run_id（task_id: {task_id}，step_id 为对应步骤）；重新执行一个步骤时，它的第一次运行传 new_attempt: true。\n\
         3. 全部步骤完成后调用 update_task_plan 把 status 设为 已完成；无法继续时设为 已暂停，并说明原因。\n",
        task_id = plan.task_id,
    ));
    text
}

#[cfg(test)]
mod tests {
    use super::super::modelforge_capabilities::{
        test_agent, ModelForgeCapabilities, CAPABILITY_NOT_DECLARED,
    };
    use super::*;
    use crate::agents::{Agent, AgentConfig, GoosePlatform};
    use crate::config::GooseMode;
    use crate::session::SessionType;
    use serde_json::json;

    const TASK_ID: &str = "20260920T101530123-a1b2c3";
    const RUN_CLEAN: &str = "20260920T101531000-aaaaaa";
    const RUN_FIT: &str = "20260920T101532000-bbbbbb";

    fn request(session_id: &str, skip: &[&str], resume_from: Option<&str>) -> ResumeTaskRequest {
        ResumeTaskRequest {
            session_id: session_id.to_string(),
            task_id: TASK_ID.to_string(),
            skip: skip.iter().map(|step| step.to_string()).collect(),
            resume_from: resume_from.map(str::to_string),
            stale_reasons: vec![json!({
                "kind": "hash-mismatch",
                "runId": RUN_FIT,
                "role": "input",
                "path": "data/in.csv",
                "expected": "0".repeat(64),
                "actual": "1".repeat(64),
            })],
        }
    }

    /// A plan file exactly as the desktop's `serializeTaskPlan` writes it.
    fn plan_json(status: &str) -> String {
        format!(
            r#"{{
  "schemaVersion": 1,
  "taskId": "{TASK_ID}",
  "title": "问题一求解",
  "status": "{status}",
  "dismissed": true,
  "createdAt": "2026-09-20T10:15:30.123+08:00",
  "steps": [
    {{
      "id": "clean",
      "title": "数据清洗",
      "runIds": [
        "{RUN_CLEAN}"
      ]
    }},
    {{
      "id": "fit",
      "title": "模型求解",
      "runIds": [
        "{RUN_FIT}"
      ]
    }},
    {{
      "id": "plot",
      "title": "",
      "runIds": []
    }}
  ]
}}
"#
        )
    }

    /// A Project with the plan, a Run_Record of `fit` naming its outputs, and the outputs listed
    /// in `existing`.
    fn project(status: &str, existing: &[(&str, &str)]) -> tempfile::TempDir {
        let project = tempfile::tempdir().unwrap();
        fs_err::create_dir_all(tasks_dir(project.path())).unwrap();
        fs_err::write(plan_path(project.path(), TASK_ID), plan_json(status)).unwrap();
        let runs = project.path().join(".modelforge/runs");
        fs_err::create_dir_all(&runs).unwrap();
        let record = json!({
            "runId": RUN_FIT,
            "outputs": [
                { "path": "results/out.csv", "sha256": "2".repeat(64) },
                { "path": "results/fig.png", "sha256": "3".repeat(64) },
                { "path": "../outside.txt", "sha256": "4".repeat(64) }
            ]
        });
        fs_err::write(
            runs.join(format!("{RUN_FIT}.json")),
            serde_json::to_string_pretty(&record).unwrap(),
        )
        .unwrap();
        for (path, content) in existing {
            let file = project.path().join(path);
            fs_err::create_dir_all(file.parent().unwrap()).unwrap();
            fs_err::write(file, content).unwrap();
        }
        project
    }

    async fn agent_with_session(
        root: &Path,
        project: &Path,
        capabilities: ModelForgeCapabilities,
    ) -> (GooseAcpAgent, String) {
        let agent = test_agent(root, capabilities).await;
        let session = agent
            .session_manager
            .create_session(
                project.to_path_buf(),
                "resume test".to_string(),
                SessionType::Acp,
                GooseMode::Auto,
            )
            .await
            .unwrap();
        (agent, session.id)
    }

    fn resumable() -> ModelForgeCapabilities {
        ModelForgeCapabilities {
            task_resume_requests: true,
            ..Default::default()
        }
    }

    fn error_code(error: &agent_client_protocol::Error) -> String {
        error.data.as_ref().unwrap()["code"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn status_of(project: &Path) -> String {
        let text = fs_err::read_to_string(plan_path(project, TASK_ID)).unwrap();
        serde_json::from_str::<serde_json::Value>(&text).unwrap()["status"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[tokio::test]
    async fn resume_requires_the_declared_capability() {
        let root = tempfile::tempdir().unwrap();
        let agent = test_agent(root.path(), ModelForgeCapabilities::default()).await;

        let error = agent
            .on_resume_task(request("s1", &["clean"], Some("fit")))
            .await
            .unwrap_err();

        assert_eq!(error.code, agent_client_protocol::ErrorCode::InvalidRequest);
        let data = error.data.unwrap();
        assert_eq!(data["code"], CAPABILITY_NOT_DECLARED);
        assert_eq!(data["capability"], TASK_RESUME_REQUESTS);
    }

    #[tokio::test]
    async fn requests_that_name_no_usable_task_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let (agent, session_id) =
            agent_with_session(root.path(), project.path(), resumable()).await;

        let mut bad_id = request(&session_id, &["clean"], Some("fit"));
        bad_id.task_id = "../tasks/x".to_string();
        let error = agent.on_resume_task(bad_id).await.unwrap_err();
        assert_eq!(error.code, agent_client_protocol::ErrorCode::InvalidParams);
        assert_eq!(error_code(&error), INVALID_TASK_ID);

        let error = agent
            .on_resume_task(request("no-such-session", &["clean"], Some("fit")))
            .await
            .unwrap_err();
        assert_eq!(
            error.code,
            agent_client_protocol::Error::resource_not_found(None).code
        );

        let error = agent
            .on_resume_task(request(&session_id, &["clean"], Some("fit")))
            .await
            .unwrap_err();
        assert_eq!(error_code(&error), TASK_NOT_FOUND);

        fs_err::create_dir_all(tasks_dir(project.path())).unwrap();
        fs_err::write(plan_path(project.path(), TASK_ID), "{ not json").unwrap();
        let error = agent
            .on_resume_task(request(&session_id, &["clean"], Some("fit")))
            .await
            .unwrap_err();
        assert_eq!(error_code(&error), INVALID_TASK_PLAN);
    }

    #[tokio::test]
    async fn a_plan_that_no_longer_fits_the_request_is_rejected_untouched() {
        let root = tempfile::tempdir().unwrap();
        let project = project(STATUS_RUNNING, &[]);
        let (agent, session_id) =
            agent_with_session(root.path(), project.path(), resumable()).await;
        let before = fs_err::read_to_string(plan_path(project.path(), TASK_ID)).unwrap();

        for (skip, resume_from) in [
            (&["fit"][..], Some("plot")),
            (&["clean"][..], Some("plot")),
            (&["clean"][..], None),
            (&["clean", "fit", "plot", "extra"][..], None),
        ] {
            let error = agent
                .on_resume_task(request(&session_id, skip, resume_from))
                .await
                .unwrap_err();
            assert_eq!(
                error_code(&error),
                STALE_RESUME_PLAN,
                "{skip:?} {resume_from:?}"
            );
        }
        assert_eq!(
            fs_err::read_to_string(plan_path(project.path(), TASK_ID)).unwrap(),
            before
        );
    }

    #[tokio::test]
    async fn nothing_left_to_run_completes_the_task() {
        let root = tempfile::tempdir().unwrap();
        let project = project(STATUS_RUNNING, &[("results/out.csv", "old")]);
        let (agent, session_id) =
            agent_with_session(root.path(), project.path(), resumable()).await;

        let response = agent
            .on_resume_task(request(&session_id, &["clean", "fit", "plot"], None))
            .await
            .unwrap();

        assert_eq!(response.outcome, ResumeTaskOutcome::Completed);
        let expected = plan_json(STATUS_COMPLETED);
        assert_eq!(
            fs_err::read_to_string(plan_path(project.path(), TASK_ID)).unwrap(),
            expected
        );
        assert_eq!(
            fs_err::read_to_string(project.path().join("results/out.csv")).unwrap(),
            "old"
        );
    }

    #[tokio::test]
    async fn an_unconfirmed_overwrite_leaves_the_task_paused_and_every_file_untouched() {
        let root = tempfile::tempdir().unwrap();
        let project = project(STATUS_RUNNING, &[("results/out.csv", "old result")]);
        let record_path = project
            .path()
            .join(format!(".modelforge/runs/{RUN_FIT}.json"));
        let record_before = fs_err::read_to_string(&record_path).unwrap();
        // The client did not declare overwriteConfirmRequests, so the answer is cancel.
        let (agent, session_id) =
            agent_with_session(root.path(), project.path(), resumable()).await;

        let response = agent
            .on_resume_task(request(&session_id, &["clean"], Some("fit")))
            .await
            .unwrap();

        assert_eq!(response.outcome, ResumeTaskOutcome::Paused);
        assert_eq!(status_of(project.path()), STATUS_PAUSED);
        assert_eq!(
            fs_err::read_to_string(project.path().join("results/out.csv")).unwrap(),
            "old result"
        );
        assert_eq!(fs_err::read_to_string(&record_path).unwrap(), record_before);
        assert!(!project.path().join("results/fig.png").exists());
    }

    #[tokio::test]
    async fn without_a_client_connection_nothing_starts_and_the_plan_stays() {
        let root = tempfile::tempdir().unwrap();
        // No output of `fit` exists any more, so there is nothing to confirm.
        let project = project(STATUS_PAUSED, &[]);
        let (agent, session_id) =
            agent_with_session(root.path(), project.path(), resumable()).await;

        let error = agent
            .on_resume_task(request(&session_id, &["clean"], Some("fit")))
            .await
            .unwrap_err();

        assert_eq!(error.code, agent_client_protocol::ErrorCode::InternalError);
        assert_eq!(status_of(project.path()), STATUS_PAUSED);
    }

    #[tokio::test]
    async fn a_session_with_a_running_turn_is_not_resumed() {
        let root = tempfile::tempdir().unwrap();
        let project = project(STATUS_PAUSED, &[]);
        let (agent, session_id) =
            agent_with_session(root.path(), project.path(), resumable()).await;
        let busy = Arc::new(Agent::with_config(AgentConfig::new(
            agent.session_manager.clone(),
            agent.permission_manager.clone(),
            None,
            GooseMode::Auto,
            true,
            GoosePlatform::GooseCli,
        )));
        agent
            .test_start_active_run(&session_id, "run_busy".to_string(), busy)
            .await
            .unwrap();

        let error = agent
            .on_resume_task(request(&session_id, &["clean"], Some("fit")))
            .await
            .unwrap_err();

        assert_eq!(error_code(&error), SESSION_BUSY);
        assert_eq!(status_of(project.path()), STATUS_PAUSED);
    }

    #[test]
    fn existing_outputs_of_the_remaining_steps_are_listed_once() {
        let project = project(
            STATUS_RUNNING,
            &[("results/out.csv", "12345"), ("outside.txt", "x")],
        );
        let plan = read_plan(project.path(), TASK_ID).unwrap();

        let files = existing_outputs(project.path(), &plan.steps[1..]);

        // fig.png does not exist and ../outside.txt leaves the Project.
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "results/out.csv");
        assert_eq!(files[0].size, 5);
        assert_eq!(files[0].modified_at.len(), 29, "{}", files[0].modified_at);
        assert_eq!(files[0].modified_at.as_bytes()[19], b'.');
        // A step without runs and a run without a readable record add nothing.
        assert!(existing_outputs(project.path(), &plan.steps[2..]).is_empty());
        assert!(existing_outputs(project.path(), &plan.steps[..1]).is_empty());

        let twice = [plan.steps[1].clone(), plan.steps[1].clone()];
        assert_eq!(existing_outputs(project.path(), &twice).len(), 1);
    }

    #[test]
    fn the_resume_step_follows_the_skipped_prefix() {
        let project = project(STATUS_RUNNING, &[]);
        let plan = read_plan(project.path(), TASK_ID).unwrap();
        let skip = |steps: &[&str]| {
            steps
                .iter()
                .map(|step| step.to_string())
                .collect::<Vec<_>>()
        };

        assert_eq!(
            resume_step_index(&plan, &skip(&[]), Some("clean")),
            Ok(Some(0))
        );
        assert_eq!(
            resume_step_index(&plan, &skip(&["clean", "fit"]), Some("plot")),
            Ok(Some(2))
        );
        assert_eq!(
            resume_step_index(&plan, &skip(&["clean", "fit", "plot"]), None),
            Ok(None)
        );
        assert!(resume_step_index(&plan, &skip(&[]), Some("fit")).is_err());
        assert!(resume_step_index(&plan, &skip(&["clean"]), Some("unknown")).is_err());
    }

    #[test]
    fn plans_with_unsafe_run_ids_or_another_task_id_are_invalid() {
        let project = project(STATUS_RUNNING, &[]);
        let mut plan = read_plan(project.path(), TASK_ID).unwrap();
        assert!(plan_problems(&plan, TASK_ID).is_empty());
        assert_eq!(plan_problems(&plan, "other"), vec!["taskId"]);

        plan.steps[0].run_ids.push("../../escape".to_string());
        plan.steps[2].id = "clean".to_string();
        plan.status = "进行中".to_string();
        assert_eq!(
            plan_problems(&plan, TASK_ID),
            vec!["status", "steps[0].runIds[1]", "steps[2].id"]
        );
    }

    #[test]
    fn the_resume_instruction_names_the_steps_the_reasons_and_the_tools() {
        let project = project(STATUS_RUNNING, &[]);
        let plan = read_plan(project.path(), TASK_ID).unwrap();
        let req = request("s1", &["clean"], Some("fit"));
        let files = [OverwriteFileInfo {
            path: "results/out.csv".to_string(),
            size: 5,
            modified_at: "2026-09-20T10:15:30.123+08:00".to_string(),
        }];

        let text = resume_prompt(&plan, &req, 1, &files);

        assert!(text.contains("问题一求解"));
        assert!(text.contains(&format!(".modelforge/tasks/{TASK_ID}.json")));
        assert!(text.contains("「数据清洗」（id: clean）"));
        assert!(text.contains("从步骤「模型求解」（id: fit）开始执行"));
        assert!(text.contains("「plot」"));
        assert!(text.contains("\"kind\":\"hash-mismatch\""));
        assert!(text.contains("results/out.csv"));
        assert!(text.contains("run_script"));
        assert!(text.contains("update_task_plan"));
        assert!(text.contains("new_attempt: true"));
    }

    #[test]
    fn the_rewritten_plan_keeps_the_desktop_layout() {
        let project = project(STATUS_RUNNING, &[]);
        let mut plan = read_plan(project.path(), TASK_ID).unwrap();
        plan.status = STATUS_PAUSED.to_string();

        write_plan(project.path(), &plan).unwrap();

        assert_eq!(
            fs_err::read_to_string(plan_path(project.path(), TASK_ID)).unwrap(),
            plan_json(STATUS_PAUSED)
        );
        let names: Vec<String> = fs_err::read_dir(tasks_dir(project.path()))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![format!("{TASK_ID}.json")]);
    }

    #[test]
    fn a_failed_turn_pauses_only_a_running_task() {
        let project = project(STATUS_RUNNING, &[]);
        pause_if_running(project.path(), TASK_ID);
        assert_eq!(status_of(project.path()), STATUS_PAUSED);

        let finished = self::project(STATUS_COMPLETED, &[]);
        pause_if_running(finished.path(), TASK_ID);
        assert_eq!(status_of(finished.path()), STATUS_COMPLETED);
    }
}
