//! `_goose/unstable/runs/*` notifications (spec mathmodel-parity-and-beyond, tasks 21.6, 21.8
//! and 22.8), sent only to clients that declared `runNotifications`.
//!
//! The modeling extension runs in-process as an MCP server over an in-memory duplex, so the Kernel
//! sees a `run_script` call like any MCP tool call: the tool request when the model asks for it,
//! MCP notifications while it runs, and the tool result after the Run_Record is on disk.
//! `run_script` puts the run id, record path and outcome in the result `_meta["modelforge/run"]`;
//! `GooseAcpAgent::notify_run_finished` forwards them as `runs/finished` once the tool response
//! reaches the ACP stream.
//!
//! The run id is allocated inside the extension, so the Kernel only learns it at the start if the
//! tool says so while it runs. `run_script` does that once its process has started, with the MCP
//! custom notification [`RUN_STARTED_TOOL_NOTIFICATION`] sent through the request's peer. goose's
//! MCP client forwards `modelforge/` custom notifications (and no others) to the running tool
//! calls, and the agent hands them to the ACP stream as
//! `AgentEvent::McpNotification((tool_call_id, notification))`;
//! `GooseAcpAgent::notify_run_started` turns it into `runs/started`. The developer shell sends the
//! same notification once task 21.7 lands (branch `mp/s2-c1-devshell`). Without a start notice no
//! `runs/started` goes out, and no run id is ever made up. Contract:
//! `.kiro/specs/mathmodel-parity-and-beyond/layer-c-contract-acp.md`.

use agent_client_protocol::{Client, ConnectionTo};
use goose_sdk_types::custom_notifications::{RunFinishedNotification, RunStartedNotification};
use rmcp::model::ServerNotification;
use serde_json::Value;
use tracing::warn;

use super::GooseAcpAgent;
use crate::conversation::message::{ToolRequest, ToolResponse};

/// Tool result `_meta` key of the modeling extension (`RUN_META_KEY` in
/// `goose_mcp::modeling::run_script`).
pub(super) const RUN_META_KEY: &str = "modelforge/run";
/// MCP custom notification a tool sends once the process of a run has started. Params:
/// `{ "runId", "toolCallId"?, "declaredOutputs"? }`, where `toolCallId` is the
/// `agent-tool-call-request-id` of the tool call `_meta` and `declaredOutputs` are
/// Project-relative, `/`-separated paths.
pub(super) const RUN_STARTED_TOOL_NOTIFICATION: &str = "modelforge/run_started";
/// The (extension, tool) pairs whose results may describe a run: `run_script` of the builtin
/// modeling extension, and the developer shell once task 21.7 makes it record runs (branch
/// `mp/s2-c1-devshell`, with the same `_meta` payload). Other tools cannot report runs.
const RUN_TOOLS: [(&str, &str); 2] = [("modeling", "run_script"), ("developer", "shell")];
/// Run_Record failure kinds (`RunFailure` in goose-mcp and in the desktop's `types/runRecord.ts`).
const RUN_FAILURES: [&str; 3] = ["非零退出码", "超时", "用户取消"];
const RUN_ID_SUFFIX_LEN: usize = 6;

/// What a finished `run_script` call reported, before the Project root is looked up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ReportedRun {
    pub(super) run_id: String,
    pub(super) exit_code: Option<i32>,
    pub(super) failure: Option<String>,
    pub(super) outputs: Vec<String>,
}

impl ReportedRun {
    /// Relative to the Project root; derived from the run id rather than taken from the payload.
    pub(super) fn record_path(&self) -> String {
        format!(".modelforge/runs/{}.json", self.run_id)
    }

    pub(super) fn into_notification(
        self,
        session_id: &str,
        tool_call_id: &str,
        working_dir: String,
    ) -> RunFinishedNotification {
        let record_path = self.record_path();
        RunFinishedNotification {
            session_id: session_id.to_string(),
            tool_call_id: tool_call_id.to_string(),
            run_id: self.run_id,
            working_dir,
            record_path,
            exit_code: self.exit_code,
            failure: self.failure,
            outputs: self.outputs,
        }
    }
}

/// The run a tool response reports. `Ok(None)` for every other tool response, including a run
/// tool call that ended before writing a record (its result carries no run); `Err` when the
/// result names a run but the payload is malformed.
pub(super) fn finished_run(
    tool_response: &ToolResponse,
    tool_request: Option<&ToolRequest>,
) -> Result<Option<ReportedRun>, String> {
    if !tool_request.is_some_and(is_run_tool) {
        return Ok(None);
    }
    let Ok(result) = &tool_response.tool_result else {
        return Ok(None);
    };
    let Some(run) = result
        .meta
        .as_ref()
        .and_then(|meta| meta.0.get(RUN_META_KEY))
    else {
        return Ok(None);
    };
    parse_run(run).map(Some)
}

fn is_run_tool(tool_request: &ToolRequest) -> bool {
    tool_request.tool_name_parts().is_some_and(|parts| {
        RUN_TOOLS.iter().any(|&(extension, tool)| {
            parts.extension_name == Some(extension) && parts.tool_name == tool
        })
    })
}

fn parse_run(run: &Value) -> Result<ReportedRun, String> {
    let run = run
        .as_object()
        .ok_or_else(|| format!("the run is not an object: {run}"))?;
    let finished = ReportedRun {
        run_id: parse_run_id(run.get("runId"))?,
        exit_code: parse_exit_code(run.get("exitCode"))?,
        failure: parse_failure(run.get("failure"))?,
        outputs: parse_paths(run.get("outputs"), "outputs")?,
    };
    if let Some(path) = run.get("recordPath") {
        if path.as_str() != Some(finished.record_path().as_str()) {
            return Err(format!(
                "recordPath {path} is not the record of {}",
                finished.run_id
            ));
        }
    }
    Ok(finished)
}

fn parse_exit_code(value: Option<&Value>) -> Result<Option<i32>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_i64()
            .and_then(|code| i32::try_from(code).ok())
            .map(Some)
            .ok_or_else(|| format!("invalid exitCode {value}")),
    }
}

fn parse_failure(value: Option<&Value>) -> Result<Option<String>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(failure)) if RUN_FAILURES.contains(&failure.as_str()) => {
            Ok(Some(failure.clone()))
        }
        Some(other) => Err(format!("invalid failure {other}")),
    }
}

fn parse_paths(value: Option<&Value>, field: &str) -> Result<Vec<String>, String> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(paths)) => paths
            .iter()
            .map(|path| {
                path.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| format!("invalid path {path} in {field}"))
            })
            .collect(),
        Some(other) => Err(format!("invalid {field} {other}")),
    }
}

fn parse_run_id(value: Option<&Value>) -> Result<String, String> {
    match value {
        Some(Value::String(run_id)) if is_run_id(run_id) => Ok(run_id.clone()),
        other => Err(format!("invalid runId {other:?}")),
    }
}

/// What a tool reported through [`RUN_STARTED_TOOL_NOTIFICATION`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct StartedRun {
    pub(super) run_id: String,
    pub(super) declared_outputs: Vec<String>,
}

impl StartedRun {
    pub(super) fn into_notification(
        self,
        session_id: &str,
        tool_call_id: &str,
        working_dir: String,
    ) -> RunStartedNotification {
        RunStartedNotification {
            session_id: session_id.to_string(),
            tool_call_id: tool_call_id.to_string(),
            run_id: self.run_id,
            working_dir,
            declared_outputs: self.declared_outputs,
        }
    }
}

/// The run a notification of the tool call `tool_call_id` reports as started. `Ok(None)` for
/// every other notification, and for a start that names another tool call: goose hands an
/// extension's notifications to every call of that extension that is running. `Err` when the
/// notification is a run start but its params are malformed.
pub(super) fn started_run(
    notification: &ServerNotification,
    tool_call_id: &str,
) -> Result<Option<StartedRun>, String> {
    let ServerNotification::CustomNotification(notification) = notification else {
        return Ok(None);
    };
    if notification.method != RUN_STARTED_TOOL_NOTIFICATION {
        return Ok(None);
    }
    let params = notification
        .params
        .as_ref()
        .and_then(Value::as_object)
        .ok_or_else(|| format!("the params are not an object: {:?}", notification.params))?;
    match params.get("toolCallId") {
        None | Some(Value::Null) => {}
        Some(Value::String(reported)) if reported == tool_call_id => {}
        Some(Value::String(_)) => return Ok(None),
        Some(other) => return Err(format!("invalid toolCallId {other}")),
    }
    Ok(Some(StartedRun {
        run_id: parse_run_id(params.get("runId"))?,
        declared_outputs: parse_paths(params.get("declaredOutputs"), "declaredOutputs")?,
    }))
}

/// `YYYYMMDDTHHMMSSmmm-` and six characters of `[0-9a-z]`: the rule of `run_record::is_run_id` in
/// goose-mcp, which this crate does not depend on. The desktop turns the id into a file name, so
/// nothing else passes.
fn is_run_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 8 + 1 + 9 + 1 + RUN_ID_SUFFIX_LEN
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 => *byte == b'T',
            18 => *byte == b'-',
            0..=17 => byte.is_ascii_digit(),
            _ => byte.is_ascii_digit() || byte.is_ascii_lowercase(),
        })
}

impl GooseAcpAgent {
    /// Sends `runs/finished` for a `run_script` result. Best effort: the tool response has gone
    /// out already, and the desktop also rescans `.modelforge/runs` (task 22.8), so a missed
    /// notification is only a delay.
    pub(super) async fn notify_run_finished(
        &self,
        cx: &ConnectionTo<Client>,
        session_id: &str,
        tool_response: &ToolResponse,
        tool_request: Option<&ToolRequest>,
    ) {
        let run = match finished_run(tool_response, tool_request) {
            Ok(Some(run)) => run,
            Ok(None) => return,
            Err(reason) => {
                warn!(
                    session_id = %session_id,
                    tool_call_id = %tool_response.id,
                    %reason,
                    "ignoring a malformed run_script result"
                );
                return;
            }
        };
        let Some(working_dir) = self.run_working_dir(session_id).await else {
            return;
        };
        let notification = run.into_notification(session_id, &tool_response.id, working_dir);
        if let Err(error) = cx.send_notification(notification) {
            warn!(session_id = %session_id, error = ?error, "failed to send runs/finished");
        }
    }

    /// Sends `runs/started` for a [`RUN_STARTED_TOOL_NOTIFICATION`] of the tool call
    /// `tool_call_id`; every other notification is left alone. Best effort, like
    /// `notify_run_finished`.
    pub(super) async fn notify_run_started(
        &self,
        cx: &ConnectionTo<Client>,
        session_id: &str,
        tool_call_id: &str,
        notification: &ServerNotification,
    ) {
        let run = match started_run(notification, tool_call_id) {
            Ok(Some(run)) => run,
            Ok(None) => return,
            Err(reason) => {
                warn!(
                    session_id = %session_id,
                    tool_call_id = %tool_call_id,
                    %reason,
                    "ignoring a malformed run start"
                );
                return;
            }
        };
        let Some(working_dir) = self.run_working_dir(session_id).await else {
            return;
        };
        let notification = run.into_notification(session_id, tool_call_id, working_dir);
        if let Err(error) = cx.send_notification(notification) {
            warn!(session_id = %session_id, error = ?error, "failed to send runs/started");
        }
    }

    /// The Project root of a run: the session working directory, which goose also sends to the
    /// tool as `agent-working-dir`.
    async fn run_working_dir(&self, session_id: &str) -> Option<String> {
        match self.session_manager.get_session(session_id, false).await {
            Ok(session) => Some(session.working_dir.to_string_lossy().into_owned()),
            Err(error) => {
                warn!(
                    session_id = %session_id,
                    %error,
                    "run notifications need the session working directory"
                );
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use goose_mcp::modeling::run_record::{self, RunFailure};
    use rmcp::model::{
        CallToolRequestParams, CallToolResult, ContentBlock, CustomNotification, ErrorData,
        MetaObject, Notification, NumberOrString, ProgressNotificationParam, ProgressToken,
    };
    use serde_json::json;
    use std::sync::Arc;

    const RUN_ID: &str = "20260920T101530123-a1b2c3";

    fn request(name: &str, tool_meta: Option<Value>) -> ToolRequest {
        ToolRequest {
            id: "call_1".to_string(),
            tool_call: Ok(CallToolRequestParams::new(name.to_string())),
            metadata: None,
            tool_meta,
        }
    }

    fn run_script() -> ToolRequest {
        request("modeling__run_script", None)
    }

    fn response(run: Option<Value>, succeeded: bool) -> ToolResponse {
        let content = vec![ContentBlock::text("Run finished.")];
        let mut result = if succeeded {
            CallToolResult::success(content)
        } else {
            CallToolResult::error(content)
        };
        // Built the way run_script builds its result.
        result.meta = run.map(|run| {
            let mut meta = MetaObject::new();
            meta.0.insert(RUN_META_KEY.to_string(), run);
            meta
        });
        ToolResponse {
            id: "call_1".to_string(),
            tool_result: Ok(result),
            metadata: None,
        }
    }

    fn run_meta() -> Value {
        json!({
            "runId": RUN_ID,
            "recordPath": format!(".modelforge/runs/{RUN_ID}.json"),
            "exitCode": 0,
            "failure": null,
            "outputs": ["results/out.csv"]
        })
    }

    #[test]
    fn a_successful_run_becomes_a_runs_finished_notification() {
        let run = finished_run(&response(Some(run_meta()), true), Some(&run_script()))
            .unwrap()
            .unwrap();
        let notification = run.into_notification("s1", "call_1", "/projects/q1".to_string());

        assert_eq!(
            serde_json::to_value(notification).unwrap(),
            json!({
                "sessionId": "s1",
                "toolCallId": "call_1",
                "runId": RUN_ID,
                "workingDir": "/projects/q1",
                "recordPath": format!(".modelforge/runs/{RUN_ID}.json"),
                "exitCode": 0,
                "failure": null,
                "outputs": ["results/out.csv"]
            })
        );
    }

    #[test]
    fn a_failed_run_keeps_its_failure_kind() {
        let meta = json!({
            "runId": RUN_ID,
            "recordPath": format!(".modelforge/runs/{RUN_ID}.json"),
            "exitCode": null,
            "failure": "超时",
            "outputs": []
        });

        assert_eq!(
            finished_run(&response(Some(meta), false), Some(&run_script())),
            Ok(Some(ReportedRun {
                run_id: RUN_ID.to_string(),
                exit_code: None,
                failure: Some("超时".to_string()),
                outputs: Vec::new(),
            }))
        );
    }

    #[test]
    fn the_developer_shell_may_report_runs_too() {
        let shell = request("developer__shell", None);

        assert!(
            finished_run(&response(Some(run_meta()), true), Some(&shell))
                .unwrap()
                .is_some()
        );
        // A shell command that is not a recorded run carries no run.
        assert_eq!(finished_run(&response(None, true), Some(&shell)), Ok(None));
    }

    #[test]
    fn the_extension_may_come_from_tool_metadata() {
        let request = request("run_script", Some(json!({ "goose_extension": "modeling" })));

        assert!(
            finished_run(&response(Some(run_meta()), true), Some(&request))
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn other_tool_responses_carry_no_run() {
        let with_run = response(Some(run_meta()), true);
        assert_eq!(finished_run(&with_run, None), Ok(None));
        assert_eq!(
            finished_run(&with_run, Some(&request("developer__write", None))),
            Ok(None)
        );
        assert_eq!(
            finished_run(&with_run, Some(&request("modeling__render_chart", None))),
            Ok(None)
        );
        assert_eq!(
            finished_run(&with_run, Some(&request("other__run_script", None))),
            Ok(None)
        );

        // run_script without a record, e.g. the command could not start.
        assert_eq!(
            finished_run(&response(None, false), Some(&run_script())),
            Ok(None)
        );
        let failed_call = ToolResponse {
            id: "call_1".to_string(),
            tool_result: Err(ErrorData::invalid_params("timeout_secs out of range", None)),
            metadata: None,
        };
        assert_eq!(finished_run(&failed_call, Some(&run_script())), Ok(None));
    }

    #[test]
    fn malformed_runs_are_rejected() {
        let malformed = [
            json!("not an object"),
            json!({ "runId": "../../escape" }),
            json!({ "runId": "20260920T101530123-A1B2C3" }),
            json!({ "runId": RUN_ID, "recordPath": "../other.json" }),
            json!({ "runId": RUN_ID, "exitCode": "0" }),
            json!({ "runId": RUN_ID, "exitCode": 4_294_967_296_i64 }),
            json!({ "runId": RUN_ID, "failure": "crashed" }),
            json!({ "runId": RUN_ID, "outputs": "results/out.csv" }),
            json!({ "runId": RUN_ID, "outputs": [1] }),
        ];
        for meta in malformed {
            let result = finished_run(&response(Some(meta.clone()), true), Some(&run_script()));
            assert!(result.is_err(), "{meta} gave {result:?}");
        }
    }

    #[test]
    fn missing_optional_fields_default_to_nothing() {
        assert_eq!(
            finished_run(
                &response(Some(json!({ "runId": RUN_ID })), true),
                Some(&run_script())
            ),
            Ok(Some(ReportedRun {
                run_id: RUN_ID.to_string(),
                exit_code: None,
                failure: None,
                outputs: Vec::new(),
            }))
        );
    }

    fn run_start(params: Value) -> ServerNotification {
        ServerNotification::CustomNotification(CustomNotification::new(
            RUN_STARTED_TOOL_NOTIFICATION,
            Some(params),
        ))
    }

    #[test]
    fn a_run_start_becomes_a_runs_started_notification() {
        let notification = run_start(json!({
            "runId": RUN_ID,
            "toolCallId": "call_1",
            "declaredOutputs": ["results/out.csv"]
        }));
        let run = started_run(&notification, "call_1").unwrap().unwrap();

        assert_eq!(
            serde_json::to_value(run.into_notification("s1", "call_1", "/projects/q1".to_string()))
                .unwrap(),
            json!({
                "sessionId": "s1",
                "toolCallId": "call_1",
                "runId": RUN_ID,
                "workingDir": "/projects/q1",
                "declaredOutputs": ["results/out.csv"]
            })
        );
    }

    #[test]
    fn a_run_start_may_leave_out_the_tool_call_and_the_outputs() {
        assert_eq!(
            started_run(&run_start(json!({ "runId": RUN_ID })), "call_1"),
            Ok(Some(StartedRun {
                run_id: RUN_ID.to_string(),
                declared_outputs: Vec::new(),
            }))
        );
    }

    #[test]
    fn a_run_start_of_another_tool_call_is_not_forwarded() {
        let notification = run_start(json!({ "runId": RUN_ID, "toolCallId": "call_2" }));

        assert_eq!(started_run(&notification, "call_1"), Ok(None));
    }

    #[test]
    fn other_notifications_start_no_run() {
        let other_method = ServerNotification::CustomNotification(CustomNotification::new(
            "platform_event",
            Some(json!({ "runId": RUN_ID })),
        ));
        assert_eq!(started_run(&other_method, "call_1"), Ok(None));

        let progress = ServerNotification::ProgressNotification(Notification::new(
            ProgressNotificationParam::new(
                ProgressToken(NumberOrString::String(Arc::from("run"))),
                1.0,
            ),
        ));
        assert_eq!(started_run(&progress, "call_1"), Ok(None));
    }

    #[test]
    fn malformed_run_starts_are_rejected() {
        let no_params = ServerNotification::CustomNotification(CustomNotification::new(
            RUN_STARTED_TOOL_NOTIFICATION,
            None,
        ));
        assert!(started_run(&no_params, "call_1").is_err());

        for params in [
            json!("not an object"),
            json!({}),
            json!({ "runId": null }),
            json!({ "runId": "../../escape" }),
            json!({ "runId": RUN_ID, "toolCallId": 1 }),
            json!({ "runId": RUN_ID, "declaredOutputs": "results/out.csv" }),
            json!({ "runId": RUN_ID, "declaredOutputs": [1] }),
        ] {
            let result = started_run(&run_start(params.clone()), "call_1");
            assert!(result.is_err(), "{params} gave {result:?}");
        }
    }

    #[test]
    fn run_ids_follow_the_run_record_rule() {
        let samples = [
            RUN_ID,
            "20260920T101530123-000000",
            "20260920T101530123-a1b2c",
            "20260920T101530123_a1b2c3",
            "2026092aT101530123-a1b2c3",
            "20260920t101530123-a1b2c3",
            "20260920T101530123-a1b2c3.json",
            "20260920T101530123-A1B2C3",
            "",
        ];
        assert!(is_run_id(RUN_ID));
        assert!(!is_run_id("20260920T101530123-a1b2c3.json"));
        for sample in samples {
            assert_eq!(
                is_run_id(sample),
                run_record::is_run_id(sample),
                "{sample:?}"
            );
        }
    }

    // goose depends on goose-mcp only for tests, so the extension's names are checked here.
    #[test]
    fn names_match_the_modeling_extension() {
        assert_eq!(RUN_META_KEY, goose_mcp::modeling::run_script::RUN_META_KEY);
        assert_eq!(
            RUN_STARTED_TOOL_NOTIFICATION,
            goose_mcp::modeling::run_script::RUN_STARTED_NOTIFICATION
        );
        // The start notice echoes the tool call id goose puts in the request `_meta`.
        assert_eq!(
            crate::session_context::TOOL_CALL_REQUEST_ID_HEADER,
            goose_mcp::modeling::run_script::TOOL_CALL_ID_META_KEY
        );

        let failures = [
            RunFailure::NonZeroExit,
            RunFailure::Timeout,
            RunFailure::Cancelled,
        ]
        .map(|failure| serde_json::to_value(failure).unwrap());
        assert_eq!(failures, RUN_FAILURES.map(|failure| json!(failure)));

        let run = ReportedRun {
            run_id: RUN_ID.to_string(),
            exit_code: Some(0),
            failure: None,
            outputs: Vec::new(),
        };
        let record_path = run.record_path();
        assert_eq!(
            std::path::PathBuf::from(&record_path),
            run_record::runs_dir(std::path::Path::new("")).join(format!("{RUN_ID}.json"))
        );
    }
}
