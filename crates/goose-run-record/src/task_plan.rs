//! Task plan (spec mathmodel-parity-and-beyond, requirement 22): the steps of a long task and the
//! Run_Records of each step, stored as `<project>/.modelforge/tasks/<task_id>.json`.
//!
//! The modeling extension writes the plan when a long task starts and records each step's runs as
//! they finish (task 25.4). The desktop reads it with `ui/desktop/src/utils/resumePlanner.ts`,
//! plans the resume there (the skip rule exists only on that side) and sets `dismissed` when the
//! user declines to resume. Both sides implement the same checks and write the same layout; they
//! are tested against `fixtures/task-plan-vectors.json`.

use std::fmt::Display;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, TimeZone};
use serde::{Deserialize, Serialize};

use crate::run_record::{format_timestamp, is_run_id, is_run_timestamp, new_run_id};

pub const TASK_PLAN_SCHEMA_VERSION: u32 = 1;
/// Longest task id the desktop accepts.
const MAX_TASK_ID_LEN: usize = 128;
/// Same budget as run ids: a collision needs the same millisecond and the same random suffix.
const MAX_TASK_ID_ATTEMPTS: usize = 16;

/// Task state shown on the desktop. `Running` is also what a task shows after the process ended in
/// the middle of it; `Paused` is a task stopped at its failure point, for example after the user
/// cancelled an overwrite (requirement 22.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskStatus {
    #[serde(rename = "执行中")]
    Running,
    #[serde(rename = "已暂停")]
    Paused,
    #[serde(rename = "已完成")]
    Completed,
}

impl TaskStatus {
    pub const ALL: [TaskStatus; 3] = [Self::Running, Self::Paused, Self::Completed];

    /// The name written to the plan file.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "执行中",
            Self::Paused => "已暂停",
            Self::Completed => "已完成",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|status| status.as_str() == value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStep {
    /// Non-empty and unique inside the plan.
    pub id: String,
    pub title: String,
    /// Run_Records of the step's latest attempt, in execution order. A retry replaces the list,
    /// so an earlier failed attempt does not keep the step from being skipped.
    pub run_ids: Vec<String>,
}

impl TaskStep {
    /// A step that has not run yet.
    pub fn new(id: impl Into<String>, title: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            run_ids: Vec::new(),
        }
    }
}

/// Field names and order match `ui/desktop/src/types/taskPlan.ts`; `to_json` produces the layout
/// of the desktop's `serializeTaskPlan`. Unknown fields are ignored when reading.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPlan {
    pub schema_version: u32,
    /// `[0-9A-Za-z][0-9A-Za-z_-]{0,127}`, the file name without `.json`; run ids qualify.
    pub task_id: String,
    pub title: String,
    pub status: TaskStatus,
    /// True after "放弃恢复". May be absent in JSON and then reads as false.
    #[serde(default)]
    pub dismissed: bool,
    /// ISO 8601 with milliseconds and offset, like Run_Record timestamps.
    pub created_at: String,
    /// In execution order.
    pub steps: Vec<TaskStep>,
}

impl TaskPlan {
    /// Parses and validates one task plan file.
    pub fn from_json(text: &str) -> Result<Self> {
        let plan: TaskPlan = serde_json::from_str(text).context("parsing the task plan")?;
        let problems = plan.problems();
        if !problems.is_empty() {
            bail!("invalid task plan fields: {}", problems.join(", "));
        }
        Ok(plan)
    }

    /// Pretty-printed JSON with a trailing newline.
    pub fn to_json(&self) -> Result<String> {
        let mut text = serde_json::to_string_pretty(self).context("serializing the task plan")?;
        text.push('\n');
        Ok(text)
    }

    /// Fields that break the contract, named like the desktop names them (`taskId`,
    /// `steps[1].id`, `steps[0].runIds[2]`). Type errors and missing fields are already rejected
    /// by serde. Empty for a valid plan.
    pub fn problems(&self) -> Vec<String> {
        let mut invalid = Vec::new();
        if self.schema_version != TASK_PLAN_SCHEMA_VERSION {
            invalid.push("schemaVersion".to_string());
        }
        if !is_task_id(&self.task_id) {
            invalid.push("taskId".to_string());
        }
        if !is_run_timestamp(&self.created_at) {
            invalid.push("createdAt".to_string());
        }
        let mut seen = std::collections::HashSet::new();
        for (index, step) in self.steps.iter().enumerate() {
            // A repeated id is reported on the later step, as the desktop does.
            if step.id.is_empty() || !seen.insert(step.id.as_str()) {
                invalid.push(format!("steps[{index}].id"));
            }
            for (run, run_id) in step.run_ids.iter().enumerate() {
                if !is_run_id(run_id) {
                    invalid.push(format!("steps[{index}].runIds[{run}]"));
                }
            }
        }
        invalid
    }

    pub fn step(&self, step_id: &str) -> Option<&TaskStep> {
        self.steps.iter().find(|step| step.id == step_id)
    }

    /// Adds `run_id` to the runs of `step_id`. `new_attempt` starts the step's list over, for the
    /// first run of a retry; otherwise the run is appended unless the step already lists it.
    pub fn record_run(&mut self, step_id: &str, run_id: &str, new_attempt: bool) -> Result<()> {
        if !is_run_id(run_id) {
            bail!("{run_id:?} is not a run id");
        }
        let step = self
            .steps
            .iter_mut()
            .find(|step| step.id == step_id)
            .ok_or_else(|| anyhow!("the task plan has no step {step_id:?}"))?;
        if new_attempt {
            step.run_ids = vec![run_id.to_string()];
        } else if !step.run_ids.iter().any(|known| known == run_id) {
            step.run_ids.push(run_id.to_string());
        }
        Ok(())
    }
}

/// Safe as a file name on every platform: no dot, separator or reserved character.
pub fn is_task_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_TASK_ID_LEN
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-')
}

/// `<project>/.modelforge/tasks`.
pub fn tasks_dir(project_root: &Path) -> PathBuf {
    project_root.join(".modelforge").join("tasks")
}

/// `<project>/.modelforge/tasks/<task_id>.json`; `task_id` must satisfy [`is_task_id`].
pub fn task_plan_path(project_root: &Path, task_id: &str) -> PathBuf {
    tasks_dir(project_root).join(format!("{task_id}.json"))
}

/// Reads and validates the plan of `task_id`. A plan that names another task than its file is
/// rejected, as the desktop rejects it.
pub fn read_task_plan(project_root: &Path, task_id: &str) -> Result<TaskPlan> {
    if !is_task_id(task_id) {
        bail!("{task_id:?} is not a task id");
    }
    let path = task_plan_path(project_root, task_id);
    let text = fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    let plan = TaskPlan::from_json(&text).with_context(|| format!("reading {}", path.display()))?;
    if plan.task_id != task_id {
        bail!(
            "{} names task {:?}, not {task_id:?}",
            path.display(),
            plan.task_id
        );
    }
    Ok(plan)
}

/// Writes the plan of a task that starts now: a new task id (run id format), status 执行中, not
/// dismissed, no runs yet. The file is written atomically and never replaces another plan; if the
/// id is taken, another one is drawn. Returns the plan as written and its path.
pub fn create_task_plan<Tz: TimeZone>(
    project_root: &Path,
    title: &str,
    steps: Vec<TaskStep>,
    now: &DateTime<Tz>,
) -> Result<(TaskPlan, PathBuf)>
where
    Tz::Offset: Display,
{
    let mut plan = TaskPlan {
        schema_version: TASK_PLAN_SCHEMA_VERSION,
        task_id: new_run_id(now),
        title: title.to_string(),
        status: TaskStatus::Running,
        dismissed: false,
        created_at: format_timestamp(now),
        steps,
    };
    let problems = plan.problems();
    if !problems.is_empty() {
        bail!(
            "refusing to write an invalid task plan ({})",
            problems.join(", ")
        );
    }
    let dir = tasks_dir(project_root);
    fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    for attempt in 0..MAX_TASK_ID_ATTEMPTS {
        if attempt > 0 {
            plan.task_id = new_run_id(now);
        }
        let target = task_plan_path(project_root, &plan.task_id);
        if fs::symlink_metadata(&target).is_ok() {
            continue;
        }
        let temp = write_temp(&dir, &plan)?;
        match temp.persist_noclobber(&target) {
            Ok(_) => return Ok((plan, target)),
            // Someone else took the name in between; the temporary file goes with `error`.
            Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(anyhow::Error::new(error.error)
                    .context(format!("moving the task plan to {}", target.display())))
            }
        }
    }
    bail!(
        "no free task id after {MAX_TASK_ID_ATTEMPTS} attempts in {}",
        dir.display()
    )
}

/// Replaces the plan file of `plan.task_id` atomically: readers see the old plan or the new one,
/// never a partial file. Invalid plans are refused.
pub fn write_task_plan(project_root: &Path, plan: &TaskPlan) -> Result<PathBuf> {
    let problems = plan.problems();
    if !problems.is_empty() {
        bail!(
            "refusing to write an invalid task plan ({})",
            problems.join(", ")
        );
    }
    let dir = tasks_dir(project_root);
    fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let target = task_plan_path(project_root, &plan.task_id);
    let temp = write_temp(&dir, plan)?;
    temp.persist(&target).map_err(|error| {
        anyhow::Error::new(error.error)
            .context(format!("moving the task plan to {}", target.display()))
    })?;
    Ok(target)
}

/// The plan in a flushed temporary file of `dir`, named `.task-*.tmp`.
fn write_temp(dir: &Path, plan: &TaskPlan) -> Result<tempfile::NamedTempFile> {
    let body = plan.to_json()?;
    let mut temp = tempfile::Builder::new()
        .prefix(".task-")
        .suffix(".tmp")
        .tempfile_in(dir)
        .with_context(|| format!("creating a temporary file in {}", dir.display()))?;
    temp.write_all(body.as_bytes())
        .with_context(|| format!("writing {}", temp.path().display()))?;
    temp.as_file()
        .sync_all()
        .with_context(|| format!("flushing {}", temp.path().display()))?;
    Ok(temp)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;
    use serde_json::{json, Value};

    fn repo_file(relative: &str) -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(relative);
        let raw = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("reading {}: {error}", path.display()));
        serde_json::from_str(&raw).unwrap_or_else(|error| panic!("{relative}: {error}"))
    }

    fn at(text: &str) -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339(text).unwrap()
    }

    fn sample_plan() -> TaskPlan {
        TaskPlan {
            schema_version: TASK_PLAN_SCHEMA_VERSION,
            task_id: "20260920T101530123-a1b2c3".to_string(),
            title: "问题一求解".to_string(),
            status: TaskStatus::Running,
            dismissed: false,
            created_at: "2026-09-20T10:15:30.123+08:00".to_string(),
            steps: vec![
                TaskStep::new("clean", "数据清洗"),
                TaskStep::new("fit", "模型求解"),
            ],
        }
    }

    // Cross-language half of the task plan format: the desktop reads and writes the same vectors.
    #[test]
    fn shared_vectors_round_trip_byte_for_byte() {
        let vectors = repo_file("fixtures/task-plan-vectors.json");
        let plans = vectors["plans"].as_array().unwrap();
        assert!(!plans.is_empty());
        for (index, value) in plans.iter().enumerate() {
            let canonical = format!("{}\n", serde_json::to_string_pretty(value).unwrap());
            let plan = TaskPlan::from_json(&canonical)
                .unwrap_or_else(|error| panic!("plan {index}: {error:#}"));
            assert_eq!(serde_json::to_value(&plan).unwrap(), *value, "plan {index}");
            assert_eq!(plan.to_json().unwrap(), canonical, "plan {index}");
        }
    }

    #[test]
    fn shared_invalid_vectors_are_rejected_with_the_desktop_field_names() {
        let vectors = repo_file("fixtures/task-plan-vectors.json");
        let cases = vectors["invalid"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let text = serde_json::to_string_pretty(&case["plan"]).unwrap();
            assert!(TaskPlan::from_json(&text).is_err(), "{name}");
            // Where serde accepts the shape, the remaining checks name the same fields.
            if let Ok(plan) = serde_json::from_value::<TaskPlan>(case["plan"].clone()) {
                let expected: Vec<String> =
                    serde_json::from_value(case["invalid"].clone()).unwrap();
                assert_eq!(plan.problems(), expected, "{name}");
                assert_eq!(case["missing"], json!([]), "{name}");
            }
        }
    }

    #[test]
    fn a_missing_dismissed_reads_as_false_and_unknown_fields_are_ignored() {
        let plan = TaskPlan::from_json(
            r#"{
                "schemaVersion": 1,
                "taskId": "t1",
                "title": "t",
                "status": "已暂停",
                "createdAt": "2026-09-20T10:15:30.123Z",
                "steps": [{ "id": "a", "title": "A", "runIds": [], "note": "kept by nobody" }],
                "future": { "field": true }
            }"#,
        )
        .unwrap();

        assert!(!plan.dismissed);
        assert_eq!(plan.status, TaskStatus::Paused);
        assert_eq!(plan.steps, vec![TaskStep::new("a", "A")]);
        assert!(!plan.to_json().unwrap().contains("future"));
    }

    #[test]
    fn task_ids_are_safe_file_names() {
        for valid in ["T", "20260920T101530123-a1b2c3", "q2_sensitivity-analysis"] {
            assert!(is_task_id(valid), "{valid}");
        }
        assert!(is_task_id(&"a".repeat(128)));
        for invalid in [
            "",
            "-leading-dash",
            "_leading",
            "task.1",
            "../escape",
            "a/b",
            "a\\b",
            "空格",
            "with space",
        ] {
            assert!(!is_task_id(invalid), "{invalid}");
        }
        assert!(!is_task_id(&"a".repeat(129)));
    }

    #[test]
    fn statuses_use_the_desktop_names() {
        for status in TaskStatus::ALL {
            assert_eq!(
                serde_json::to_value(status).unwrap(),
                json!(status.as_str())
            );
            assert_eq!(TaskStatus::parse(status.as_str()), Some(status));
        }
        assert_eq!(TaskStatus::parse("进行中"), None);
    }

    #[test]
    fn runs_are_appended_and_a_new_attempt_starts_over() {
        let mut plan = sample_plan();
        let first = "20260920T101531000-aaaaaa";
        let second = "20260920T101532000-bbbbbb";
        let retry = "20260920T101533000-cccccc";

        plan.record_run("clean", first, false).unwrap();
        plan.record_run("clean", second, false).unwrap();
        plan.record_run("clean", second, false).unwrap();
        assert_eq!(plan.step("clean").unwrap().run_ids, vec![first, second]);

        plan.record_run("clean", retry, true).unwrap();
        assert_eq!(plan.step("clean").unwrap().run_ids, vec![retry]);
        assert!(plan.step("fit").unwrap().run_ids.is_empty());

        assert!(plan.record_run("plot", first, false).is_err());
        assert!(plan.record_run("fit", "run-1", false).is_err());
        assert!(plan.step("fit").unwrap().run_ids.is_empty());
    }

    #[test]
    fn created_plans_can_be_read_back_and_never_replace_each_other() {
        let project = tempfile::tempdir().unwrap();
        let now = at("2026-09-20T10:15:30.123+08:00");
        let steps = vec![
            TaskStep::new("clean", "数据清洗"),
            TaskStep::new("fit", "模型求解"),
        ];

        let (first, first_path) =
            create_task_plan(project.path(), "问题一求解", steps.clone(), &now).unwrap();
        let (second, second_path) =
            create_task_plan(project.path(), "问题一求解", steps.clone(), &now).unwrap();

        assert_ne!(first.task_id, second.task_id);
        assert_ne!(first_path, second_path);
        assert!(first.task_id.starts_with("20260920T101530123-"));
        assert_eq!(first.status, TaskStatus::Running);
        assert!(!first.dismissed);
        assert_eq!(first.created_at, "2026-09-20T10:15:30.123+08:00");
        assert_eq!(first.steps, steps);
        assert_eq!(first_path, task_plan_path(project.path(), &first.task_id));
        assert_eq!(
            read_task_plan(project.path(), &first.task_id).unwrap(),
            first
        );
        assert_eq!(
            read_task_plan(project.path(), &second.task_id).unwrap(),
            second
        );
    }

    #[test]
    fn invalid_plans_are_not_written() {
        let project = tempfile::tempdir().unwrap();
        let now = at("2026-09-20T10:15:30.123+08:00");
        let repeated = vec![TaskStep::new("a", "A"), TaskStep::new("a", "B")];
        assert!(create_task_plan(project.path(), "t", repeated, &now).is_err());

        let mut plan = sample_plan();
        plan.task_id = "../escape".to_string();
        assert!(write_task_plan(project.path(), &plan).is_err());
        assert!(!tasks_dir(project.path()).join("../escape.json").exists());
    }

    #[test]
    fn a_rewrite_replaces_the_whole_plan_and_leaves_no_temporary_file() {
        let project = tempfile::tempdir().unwrap();
        let mut plan = sample_plan();
        write_task_plan(project.path(), &plan).unwrap();

        plan.status = TaskStatus::Paused;
        plan.record_run("clean", "20260920T101531000-aaaaaa", false)
            .unwrap();
        let path = write_task_plan(project.path(), &plan).unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), plan.to_json().unwrap());
        assert_eq!(read_task_plan(project.path(), &plan.task_id).unwrap(), plan);
        let names: Vec<String> = fs::read_dir(tasks_dir(project.path()))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![format!("{}.json", plan.task_id)]);
    }

    #[test]
    fn reading_checks_the_task_id_and_the_file_name() {
        let project = tempfile::tempdir().unwrap();
        let plan = sample_plan();
        write_task_plan(project.path(), &plan).unwrap();

        assert!(read_task_plan(project.path(), "../tasks/x").is_err());
        assert!(read_task_plan(project.path(), "unknown").is_err());

        // A plan copied under another name does not pass as that task.
        fs::copy(
            task_plan_path(project.path(), &plan.task_id),
            task_plan_path(project.path(), "copy"),
        )
        .unwrap();
        let error = read_task_plan(project.path(), "copy").unwrap_err();
        assert!(format!("{error:#}").contains("names task"), "{error:#}");
    }
}
