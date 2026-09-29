//! Task plan tools of the modeling extension (spec mathmodel-parity-and-beyond, task 25.4).
//!
//! A long task is declared before its first computation step (`create_task_plan`), and the run
//! ids that `run_script` reports are recorded per step as the steps finish (`update_task_plan`).
//! Both write `<project>/.modelforge/tasks/<task_id>.json` through
//! [`goose_run_record::task_plan`], whose format is the desktop's `types/taskPlan.ts`. After an
//! interruption the desktop checks the steps against their Run_Records (`planResume`, the only
//! implementation of the skip rule) and asks the Kernel to continue from the first step that
//! fails (`_goose/unstable/tasks/resume`).

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use chrono::{DateTime, TimeZone};
use goose_run_record::run_record::{is_run_id, runs_dir};
use goose_run_record::task_plan::{
    create_task_plan, read_task_plan, write_task_plan, TaskPlan, TaskStatus, TaskStep,
};
use rmcp::{
    handler::server::wrapper::Parameters,
    model::{CallToolResult, ContentBlock, ErrorCode, ErrorData},
    schemars::JsonSchema,
    service::RequestContext,
    tool, tool_router, RoleServer,
};
use serde::{Deserialize, Serialize};

use super::{meta_string, ModelingServer, WORKING_DIR_META_KEY};

/// Serializes the read-modify-write of plan files inside this process, so parallel tool calls
/// (of one session, or of two sessions on the same Project) do not lose each other's run ids.
static PLAN_UPDATES: Mutex<()> = Mutex::new(());

/// One step of a new task plan.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TaskPlanStepParam {
    /// Short identifier, unique inside the plan, e.g. "clean" or "q1-fit"
    pub id: String,
    /// What the step does, shown to the user, e.g. "数据清洗"
    pub title: String,
}

/// Parameters for the create_task_plan tool
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CreateTaskPlanParams {
    /// Name of the task shown to the user, e.g. "问题一求解"
    pub title: String,
    /// The computation steps in execution order
    pub steps: Vec<TaskPlanStepParam>,
}

/// Parameters for the update_task_plan tool
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct UpdateTaskPlanParams {
    /// task_id returned by create_task_plan
    pub task_id: String,
    /// Step the run belongs to; give it together with run_id
    pub step_id: Option<String>,
    /// run_id that run_script reported for a run of this step
    pub run_id: Option<String>,
    /// True for the first run of a new attempt at the step (a retry): the step's earlier runs are
    /// dropped. Leave false for further runs of the same attempt
    #[serde(default)]
    pub new_attempt: bool,
    /// New task status: 执行中, 已暂停 or 已完成. Recording a run sets 执行中 unless a status is
    /// given; set 已完成 once the last step succeeded
    pub status: Option<String>,
}

#[tool_router(router = task_plan_router, vis = "pub(super)")]
impl ModelingServer {
    /// Declare a long task and its steps (spec requirement 22).
    #[tool(
        name = "create_task_plan",
        description = "Declare a task of several computation steps before running its first step, so it can resume from its failure point after an interruption. Writes .modelforge/tasks/<task_id>.json in the Project with the steps in execution order (status 执行中) and returns the task_id. After each run_script call that belongs to a step, record its run_id with update_task_plan."
    )]
    pub async fn create_task_plan(
        &self,
        params: Parameters<CreateTaskPlanParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let project_root = project_root(&context)?;
        let params = params.0;
        let plan =
            blocking(move || create_plan(&project_root, params, &chrono::Local::now())).await?;
        Ok(CallToolResult::success(vec![ContentBlock::text(
            describe_plan("Task plan written", &plan),
        )]))
    }

    /// Record a step's run or the task status (spec requirement 22).
    #[tool(
        name = "update_task_plan",
        description = "Update a task plan made by create_task_plan: record the run_id that run_script reported for a step (step_id with run_id; new_attempt true for the first run of a retry, which drops the step's earlier runs), and/or set the task status (执行中, 已暂停 or 已完成). Recording a run sets 执行中 unless a status is given. Set 已完成 once the last step succeeded."
    )]
    pub async fn update_task_plan(
        &self,
        params: Parameters<UpdateTaskPlanParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let project_root = project_root(&context)?;
        let params = params.0;
        let plan = blocking(move || update_plan(&project_root, params)).await?;
        Ok(CallToolResult::success(vec![ContentBlock::text(
            describe_plan("Task plan updated", &plan),
        )]))
    }
}

fn invalid_params(message: impl Into<String>) -> ErrorData {
    ErrorData::new(ErrorCode::INVALID_PARAMS, message.into(), None)
}

fn internal_error(message: impl Into<String>) -> ErrorData {
    ErrorData::new(ErrorCode::INTERNAL_ERROR, message.into(), None)
}

/// The Project: the session working directory from the request `_meta`, like `run_script`.
fn project_root(context: &RequestContext<RoleServer>) -> Result<PathBuf, ErrorData> {
    let root = meta_string(&context.meta, WORKING_DIR_META_KEY)
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .ok_or_else(|| {
            invalid_params(
                "no Project directory: the request names no working directory and the current \
                 directory is unavailable",
            )
        })?;
    if !root.is_dir() {
        return Err(invalid_params(format!(
            "the Project directory {} does not exist",
            root.display()
        )));
    }
    Ok(root)
}

/// Runs the file system work off the async threads.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, ErrorData> + Send + 'static,
) -> Result<T, ErrorData> {
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => result,
        Err(error) => Err(internal_error(format!(
            "the task plan task failed: {error}"
        ))),
    }
}

/// Checks the parameters with messages the model can act on, then writes a new plan.
fn create_plan<Tz: TimeZone>(
    project_root: &Path,
    params: CreateTaskPlanParams,
    now: &DateTime<Tz>,
) -> Result<TaskPlan, ErrorData>
where
    Tz::Offset: std::fmt::Display,
{
    let title = params.title.trim();
    if title.is_empty() {
        return Err(invalid_params("title must not be empty"));
    }
    if params.steps.is_empty() {
        return Err(invalid_params("a task plan needs at least one step"));
    }
    let mut steps: Vec<TaskStep> = Vec::with_capacity(params.steps.len());
    for step in params.steps {
        let id = step.id.trim();
        if id.is_empty() {
            return Err(invalid_params("every step needs a non-empty id"));
        }
        if steps.iter().any(|known| known.id == id) {
            return Err(invalid_params(format!("step id {id:?} is used twice")));
        }
        steps.push(TaskStep::new(id, step.title.trim()));
    }
    let (plan, _) = create_task_plan(project_root, title, steps, now)
        .map_err(|error| internal_error(format!("{error:#}")))?;
    Ok(plan)
}

/// Applies one update under [`PLAN_UPDATES`] and writes the plan back.
fn update_plan(project_root: &Path, params: UpdateTaskPlanParams) -> Result<TaskPlan, ErrorData> {
    let status = params
        .status
        .as_deref()
        .map(str::trim)
        .map(|value| {
            TaskStatus::parse(value).ok_or_else(|| {
                invalid_params(format!(
                    "status must be 执行中, 已暂停 or 已完成, not {value:?}"
                ))
            })
        })
        .transpose()?;
    let run = match (params.step_id.as_deref(), params.run_id.as_deref()) {
        (None, None) => None,
        (Some(step_id), Some(run_id)) => Some((step_id.trim(), run_id.trim())),
        _ => return Err(invalid_params("give step_id and run_id together")),
    };
    if run.is_none() && status.is_none() {
        return Err(invalid_params(
            "nothing to update: give step_id with run_id, or status",
        ));
    }
    if let Some((_, run_id)) = run {
        if !is_run_id(run_id) {
            return Err(invalid_params(format!(
                "{run_id:?} is not a run id; use the run_id that run_script reported"
            )));
        }
        let record = runs_dir(project_root).join(format!("{run_id}.json"));
        if !record.is_file() {
            return Err(invalid_params(format!(
                "no Run_Record {run_id} in this Project (.modelforge/runs/{run_id}.json); record \
                 only runs made with run_script"
            )));
        }
    }

    let _guard = PLAN_UPDATES.lock().unwrap_or_else(PoisonError::into_inner);
    let mut plan = read_task_plan(project_root, params.task_id.trim())
        .map_err(|error| invalid_params(format!("{error:#}")))?;
    if let Some((step_id, run_id)) = run {
        plan.record_run(step_id, run_id, params.new_attempt)
            .map_err(|error| invalid_params(format!("{error:#}")))?;
    }
    plan.status = match (status, run) {
        (Some(status), _) => status,
        (None, Some(_)) => TaskStatus::Running,
        (None, None) => plan.status,
    };
    write_task_plan(project_root, &plan).map_err(|error| internal_error(format!("{error:#}")))?;
    Ok(plan)
}

/// What the model reads back: where the plan is, its status and each step's runs.
fn describe_plan(headline: &str, plan: &TaskPlan) -> String {
    let mut text = format!(
        "{headline}: .modelforge/tasks/{}.json\ntask_id: {}\nstatus: {}\nsteps:\n",
        plan.task_id,
        plan.task_id,
        plan.status.as_str()
    );
    for step in &plan.steps {
        let runs = if step.run_ids.is_empty() {
            "no run recorded".to_string()
        } else {
            step.run_ids.join(", ")
        };
        text.push_str(&format!("  - {} ({}): {runs}\n", step.id, step.title));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use goose_run_record::task_plan::task_plan_path;
    use rmcp::ServerHandler;
    use std::fs;

    fn now() -> DateTime<chrono::FixedOffset> {
        DateTime::parse_from_rfc3339("2026-09-20T10:15:30.123+08:00").unwrap()
    }

    fn params(steps: &[(&str, &str)]) -> CreateTaskPlanParams {
        CreateTaskPlanParams {
            title: "问题一求解".to_string(),
            steps: steps
                .iter()
                .map(|(id, title)| TaskPlanStepParam {
                    id: id.to_string(),
                    title: title.to_string(),
                })
                .collect(),
        }
    }

    /// A Project with one plan and a Run_Record file for each of `run_ids`.
    fn project_with_plan(run_ids: &[&str]) -> (tempfile::TempDir, TaskPlan) {
        let project = tempfile::tempdir().unwrap();
        let plan = create_plan(
            project.path(),
            params(&[("clean", "数据清洗"), ("fit", "模型求解")]),
            &now(),
        )
        .unwrap();
        let runs = runs_dir(project.path());
        fs::create_dir_all(&runs).unwrap();
        for run_id in run_ids {
            // Only the file's existence is checked here; the desktop validates its content.
            fs::write(runs.join(format!("{run_id}.json")), "{}").unwrap();
        }
        (project, plan)
    }

    fn update(task_id: &str) -> UpdateTaskPlanParams {
        UpdateTaskPlanParams {
            task_id: task_id.to_string(),
            ..Default::default()
        }
    }

    const RUN_A: &str = "20260920T101531000-aaaaaa";
    const RUN_B: &str = "20260920T101532000-bbbbbb";

    #[test]
    fn tools_are_listed() {
        let server = ModelingServer::new();
        assert!(server.get_tool("create_task_plan").is_some());
        assert!(server.get_tool("update_task_plan").is_some());
        assert!(server.get_tool("run_script").is_some());
    }

    #[test]
    fn a_new_plan_is_written_in_the_desktop_format() {
        let project = tempfile::tempdir().unwrap();
        let plan = create_plan(
            project.path(),
            params(&[(" clean ", "数据清洗"), ("fit", "模型求解")]),
            &now(),
        )
        .unwrap();

        assert_eq!(plan.status, TaskStatus::Running);
        assert_eq!(
            plan.steps,
            vec![
                TaskStep::new("clean", "数据清洗"),
                TaskStep::new("fit", "模型求解")
            ]
        );
        let text = fs::read_to_string(task_plan_path(project.path(), &plan.task_id)).unwrap();
        assert_eq!(text, plan.to_json().unwrap());
        assert!(text.contains("\"dismissed\": false"));
    }

    #[test]
    fn unusable_plans_are_refused() {
        let project = tempfile::tempdir().unwrap();
        let mut untitled = params(&[("a", "A")]);
        untitled.title = "  ".to_string();
        for bad in [
            untitled,
            params(&[]),
            params(&[("a", "A"), ("a", "B")]),
            params(&[("", "A")]),
        ] {
            let error = create_plan(project.path(), bad, &now()).unwrap_err();
            assert_eq!(error.code, ErrorCode::INVALID_PARAMS);
        }
        assert!(!project.path().join(".modelforge").exists());
    }

    #[test]
    fn runs_are_recorded_per_step_and_a_retry_starts_over() {
        let (project, plan) = project_with_plan(&[RUN_A, RUN_B]);

        let mut record = update(&plan.task_id);
        record.step_id = Some("clean".to_string());
        record.run_id = Some(RUN_A.to_string());
        update_plan(project.path(), record.clone()).unwrap();
        record.run_id = Some(RUN_B.to_string());
        let appended = update_plan(project.path(), record.clone()).unwrap();
        assert_eq!(appended.step("clean").unwrap().run_ids, vec![RUN_A, RUN_B]);

        record.new_attempt = true;
        let retried = update_plan(project.path(), record).unwrap();
        assert_eq!(retried.step("clean").unwrap().run_ids, vec![RUN_B]);
        assert_eq!(
            read_task_plan(project.path(), &plan.task_id).unwrap(),
            retried
        );
    }

    #[test]
    fn recording_a_run_resumes_the_task_unless_a_status_is_given() {
        let (project, plan) = project_with_plan(&[RUN_A]);

        let mut paused = update(&plan.task_id);
        paused.status = Some("已暂停".to_string());
        assert_eq!(
            update_plan(project.path(), paused).unwrap().status,
            TaskStatus::Paused
        );

        let mut record = update(&plan.task_id);
        record.step_id = Some("fit".to_string());
        record.run_id = Some(RUN_A.to_string());
        assert_eq!(
            update_plan(project.path(), record.clone()).unwrap().status,
            TaskStatus::Running
        );

        record.status = Some("已完成".to_string());
        assert_eq!(
            update_plan(project.path(), record).unwrap().status,
            TaskStatus::Completed
        );
    }

    #[test]
    fn bad_updates_leave_the_plan_as_it_was() {
        let (project, plan) = project_with_plan(&[RUN_A]);
        let path = task_plan_path(project.path(), &plan.task_id);
        let before = fs::read_to_string(&path).unwrap();

        let with = |step: Option<&str>, run: Option<&str>, status: Option<&str>| {
            let mut params = update(&plan.task_id);
            params.step_id = step.map(str::to_string);
            params.run_id = run.map(str::to_string);
            params.status = status.map(str::to_string);
            params
        };
        let bad = [
            with(None, None, None),
            with(Some("clean"), None, None),
            with(None, Some(RUN_A), None),
            with(Some("clean"), Some("run-1"), None),
            // A well-formed run id without a Run_Record in the Project.
            with(Some("clean"), Some(RUN_B), None),
            with(Some("plot"), Some(RUN_A), None),
            with(None, None, Some("进行中")),
        ];
        for params in bad {
            let error = update_plan(project.path(), params.clone()).unwrap_err();
            assert_eq!(error.code, ErrorCode::INVALID_PARAMS, "{params:?}");
        }
        let mut unknown = with(None, None, Some("已完成"));
        unknown.task_id = "no-such-task".to_string();
        assert!(update_plan(project.path(), unknown).is_err());

        assert_eq!(fs::read_to_string(&path).unwrap(), before);
    }

    #[test]
    fn the_summary_names_the_plan_and_every_step() {
        let (_project, mut plan) = project_with_plan(&[]);
        plan.record_run("clean", RUN_A, false).unwrap();

        let text = describe_plan("Task plan updated", &plan);

        assert!(text.contains(&format!(".modelforge/tasks/{}.json", plan.task_id)));
        assert!(text.contains("status: 执行中"));
        assert!(text.contains(&format!("clean (数据清洗): {RUN_A}")));
        assert!(text.contains("fit (模型求解): no run recorded"));
    }
}
