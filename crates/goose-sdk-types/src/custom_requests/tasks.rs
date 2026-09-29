//! Task resume (spec mathmodel-parity-and-beyond, task 25.4): the desktop asks the Kernel to
//! continue an interrupted task, and the Kernel asks the desktop before a resumed step overwrites
//! output files that already exist. Contract: `.kiro/specs/mathmodel-parity-and-beyond/
//! layer-c-contract-acp.md`.

use agent_client_protocol::{JsonRpcRequest, JsonRpcResponse};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Client → Kernel: continue the task `taskId` from `resumeFrom`.
pub const RESUME_TASK_METHOD: &str = "_goose/unstable/tasks/resume";

/// Kernel → client request sent before a resumed step overwrites output files that already
/// exist. Only `confirm` lets the step run; `cancel`, an error or no answer leaves the task
/// paused (已暂停) with every file untouched (requirement 22.6).
pub const CONFIRM_OVERWRITE_METHOD: &str = "_goose/unstable/tasks/confirm-overwrite";

/// Resume an interrupted task from the step the desktop planned.
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(method = "_goose/unstable/tasks/resume", response = ResumeTaskResponse)]
#[serde(rename_all = "camelCase")]
pub struct ResumeTaskRequest {
    pub session_id: String,
    // Names `.modelforge/tasks/<taskId>.json` in the session working directory.
    pub task_id: String,
    // The fields below are the desktop's `ResumePlan` (`utils/resumePlanner.ts`) as is. The skip
    // rule exists only there; the Kernel does not check the plan again.
    pub skip: Vec<String>,
    // `None` when every step may be skipped and nothing is left to run.
    pub resume_from: Option<String>,
    // `StepStaleReason` values of `resumeFrom`, passed through as JSON.
    #[serde(default)]
    pub stale_reasons: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct ResumeTaskResponse {
    pub outcome: ResumeTaskOutcome,
}

// Variant comments stay plain comments: doc comments would turn the schema into `oneOf`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ResumeTaskOutcome {
    // The Kernel runs the task from `resumeFrom`.
    Resumed,
    // The user did not confirm an overwrite; the task is 已暂停 and no file changed.
    Paused,
    // `resumeFrom` was null: nothing was left to run and the task is 已完成.
    Completed,
}

/// Ask the client whether a resumed step may overwrite output files that already exist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmOverwriteRequest {
    pub session_id: String,
    pub task_id: String,
    // The step about to run.
    pub step_id: String,
    // The Project root the file paths are relative to.
    pub working_dir: String,
    pub files: Vec<OverwriteFileInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OverwriteFileInfo {
    // Project-relative, `/`-separated.
    pub path: String,
    // In bytes.
    pub size: u64,
    // ISO 8601 with milliseconds and offset, like Run_Record timestamps.
    pub modified_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmOverwriteResponse {
    pub action: ConfirmOverwriteAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ConfirmOverwriteAction {
    Confirm,
    Cancel,
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::JsonRpcMessage;
    use serde_json::json;

    #[test]
    fn resume_request_uses_the_declared_method() {
        assert_eq!(
            JsonRpcMessage::method(&ResumeTaskRequest::default()),
            RESUME_TASK_METHOD
        );
    }

    #[test]
    fn resume_request_accepts_a_resume_plan_as_is() {
        let request: ResumeTaskRequest = serde_json::from_value(json!({
            "sessionId": "s1",
            "taskId": "20260920T101530123-a1b2c3",
            "skip": ["clean"],
            "resumeFrom": "fit",
            "staleReasons": [{ "kind": "record-missing", "runId": null }]
        }))
        .unwrap();

        assert_eq!(request.skip, vec!["clean".to_string()]);
        assert_eq!(request.resume_from.as_deref(), Some("fit"));
        assert_eq!(
            request.stale_reasons,
            vec![json!({ "kind": "record-missing", "runId": null })]
        );

        let finished: ResumeTaskRequest = serde_json::from_value(json!({
            "sessionId": "s1",
            "taskId": "t1",
            "skip": ["clean", "fit"],
            "resumeFrom": null
        }))
        .unwrap();
        assert_eq!(finished.resume_from, None);
        assert!(finished.stale_reasons.is_empty());
    }

    #[test]
    fn resume_response_serializes_the_outcome_in_camel_case() {
        for (outcome, wire) in [
            (ResumeTaskOutcome::Resumed, "resumed"),
            (ResumeTaskOutcome::Paused, "paused"),
            (ResumeTaskOutcome::Completed, "completed"),
        ] {
            assert_eq!(
                serde_json::to_value(ResumeTaskResponse { outcome }).unwrap(),
                json!({ "outcome": wire })
            );
        }
    }

    #[test]
    fn confirm_overwrite_round_trips_the_wire_shape() {
        let request = ConfirmOverwriteRequest {
            session_id: "s1".to_string(),
            task_id: "t1".to_string(),
            step_id: "fit".to_string(),
            working_dir: "/projects/q1".to_string(),
            files: vec![OverwriteFileInfo {
                path: "results/out.csv".to_string(),
                size: 2048,
                modified_at: "2026-09-20T10:15:30.123+08:00".to_string(),
            }],
        };
        let value = serde_json::to_value(&request).unwrap();

        assert_eq!(
            value,
            json!({
                "sessionId": "s1",
                "taskId": "t1",
                "stepId": "fit",
                "workingDir": "/projects/q1",
                "files": [{
                    "path": "results/out.csv",
                    "size": 2048,
                    "modifiedAt": "2026-09-20T10:15:30.123+08:00"
                }]
            })
        );
        assert_eq!(
            serde_json::from_value::<ConfirmOverwriteRequest>(value).unwrap(),
            request
        );

        let response: ConfirmOverwriteResponse =
            serde_json::from_value(json!({ "action": "cancel" })).unwrap();
        assert_eq!(response.action, ConfirmOverwriteAction::Cancel);
        assert!(serde_json::from_value::<ConfirmOverwriteResponse>(json!({})).is_err());
    }
}
