use crate::custom_requests::CustomMethodSchema;
use agent_client_protocol::{JsonRpcMessage, JsonRpcNotification};
use schemars::{JsonSchema, SchemaGenerator};
use serde::{Deserialize, Serialize};

/// Goose-custom session update notification — a parallel to ACP's
/// `session/update` carrying goose-specific update variants.
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcNotification)]
#[notification(method = "_goose/unstable/session/update")]
#[serde(rename_all = "camelCase")]
pub struct GooseSessionNotification {
    pub session_id: String,
    pub update: GooseSessionUpdate,
}

/// Discriminated union of goose-specific session update payloads.
/// Variant tag matches ACP's convention (`sessionUpdate: "<snake_case>"`).
///
/// `discriminator.mapping` is what makes TS codegen (`@hey-api/openapi-ts`)
/// emit the correct snake_case tag value even when this enum has a single
/// variant. Add a mapping entry per variant.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "sessionUpdate", rename_all = "snake_case")]
#[schemars(extend("discriminator" = {
    "propertyName": "sessionUpdate",
    "mapping": {
        "usage_update": "#/$defs/SessionUsageUpdate",
        "status_message": "#/$defs/StatusMessageUpdate",
        "message_usage": "#/$defs/MessageUsageUpdate"
    }
}))]
pub enum GooseSessionUpdate {
    UsageUpdate(SessionUsageUpdate),
    StatusMessage(StatusMessageUpdate),
    MessageUsage(MessageUsageUpdate),
}

/// Dedicated provider notification for OAuth device-code flow.
/// Sent during provider authentication when the ACP client supports
/// `goose.customNotifications` — avoids a fake empty session ID.
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcNotification)]
#[notification(method = "_goose/unstable/providers/authentication/device-code")]
#[serde(rename_all = "camelCase")]
pub struct ProviderDeviceCodeNotification {
    pub provider_id: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
}

impl Default for GooseSessionUpdate {
    fn default() -> Self {
        GooseSessionUpdate::UsageUpdate(SessionUsageUpdate::default())
    }
}

/// Streaming context-window usage update for a session.
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsageUpdate {
    pub used: u64,
    pub context_limit: u64,
    pub accumulated_input_tokens: u64,
    pub accumulated_output_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accumulated_cost: Option<f64>,
}

/// Per-message token usage/cost/timing, keyed by the message id used for
/// chunk matching. Sent live after a turn's messages and on replay.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageUsageUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub usage: MessageUsageData,
}

/// Wire mirror of the conversation `MessageUsage` (this crate cannot depend on
/// goose-provider-types); field names and serde casing MUST stay in parity.
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageUsageData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_source: Option<CostSourceData>,
    /// Wall-clock generation time, used by the client for a tokens/sec readout.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_to_first_token_ms: Option<u64>,
    /// Usage from a compaction/summarization call rather than a normal turn.
    #[serde(default)]
    pub is_compaction: bool,
}

/// Wire mirror of the conversation `CostSource`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CostSourceData {
    /// Cost returned directly by the provider (e.g. OpenRouter `usage.cost`).
    ProviderReported,
    /// Cost computed from the canonical pricing table.
    Estimated,
}

/// Live UI/session status. This is not conversation transcript content, and
/// should not be persisted or replayed as history.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StatusMessageUpdate {
    pub status: StatusMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StatusMessage {
    #[serde(rename_all = "camelCase")]
    Notice { message: String },
    #[serde(rename_all = "camelCase")]
    Progress { message: String },
}

// Run notifications (spec mathmodel-parity-and-beyond, tasks 21.6, 21.8 and 22.8), sent only to
// clients that declare `runNotifications` in `clientCapabilities._meta.goose`. Contract:
// `.kiro/specs/mathmodel-parity-and-beyond/layer-c-contract-acp.md`. Field comments stay plain
// comments so the generated schema and TS types carry no per-field text.

/// Kernel → client: a run of Project code has started.
pub const RUN_STARTED_NOTIFICATION_METHOD: &str = "_goose/unstable/runs/started";

/// Kernel → client: a run of Project code has ended and its Run_Record is on disk.
pub const RUN_FINISHED_NOTIFICATION_METHOD: &str = "_goose/unstable/runs/finished";

/// A run of Project code has started.
#[derive(
    Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, JsonRpcNotification,
)]
#[notification(method = "_goose/unstable/runs/started")]
#[serde(rename_all = "camelCase")]
pub struct RunStartedNotification {
    pub session_id: String,
    // The ACP tool call that runs the code.
    pub tool_call_id: String,
    // The id the recorder allocated before the process started. Only sent when this real id is
    // known; nobody invents one (see the contract). The finished record usually carries the same
    // id, but a write collision can draw a new suffix.
    pub run_id: String,
    // The Project root.
    pub working_dir: String,
    // Declared output paths, Project-relative and `/`-separated as in the Run_Record; empty when
    // the outputs are detected when the run ends.
    pub declared_outputs: Vec<String>,
}

/// A run of Project code has ended and its Run_Record is on disk.
#[derive(
    Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, JsonRpcNotification,
)]
#[notification(method = "_goose/unstable/runs/finished")]
#[serde(rename_all = "camelCase")]
pub struct RunFinishedNotification {
    pub session_id: String,
    // The ACP tool call that ran the code.
    pub tool_call_id: String,
    pub run_id: String,
    // The Project root.
    pub working_dir: String,
    // `.modelforge/runs/<runId>.json`, relative to `workingDir`.
    pub record_path: String,
    // As in the Run_Record: null for a time-out (超时) or a cancellation (用户取消).
    pub exit_code: Option<i32>,
    // Null on success, otherwise the Run_Record failure kind: 非零退出码, 超时 or 用户取消.
    pub failure: Option<String>,
    // Project-relative output paths of the record (at most 1000).
    pub outputs: Vec<String>,
}

fn notification_schema<T>(generator: &mut SchemaGenerator) -> CustomMethodSchema
where
    T: Default + JsonRpcMessage + JsonSchema,
{
    let dummy = T::default();
    let type_name = std::any::type_name::<T>()
        .rsplit("::")
        .next()
        .unwrap_or(std::any::type_name::<T>())
        .to_string();
    CustomMethodSchema {
        method: dummy.method().to_string(),
        params_schema: Some(generator.subschema_for::<T>()),
        params_type_name: Some(type_name),
        response_schema: None,
        response_type_name: None,
    }
}

/// Schemas for every goose-custom outbound notification. To register a new
/// notification, define the struct above (with `JsonRpcNotification` +
/// `Default`) and add one line below.
pub fn custom_notification_schemas(generator: &mut SchemaGenerator) -> Vec<CustomMethodSchema> {
    vec![
        notification_schema::<GooseSessionNotification>(generator),
        notification_schema::<ProviderDeviceCodeNotification>(generator),
        notification_schema::<RunStartedNotification>(generator),
        notification_schema::<RunFinishedNotification>(generator),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn status_message_serializes_to_expected_wire_shape() {
        let notification = GooseSessionNotification {
            session_id: "s1".to_string(),
            update: GooseSessionUpdate::StatusMessage(StatusMessageUpdate {
                status: StatusMessage::Notice {
                    message: "Compaction complete".to_string(),
                },
            }),
        };

        let value = serde_json::to_value(notification).unwrap();

        assert_eq!(
            value,
            json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "status_message",
                    "status": {
                        "type": "notice",
                        "message": "Compaction complete"
                    }
                }
            })
        );
    }

    #[test]
    fn message_usage_serializes_to_expected_wire_shape() {
        let notification = GooseSessionNotification {
            session_id: "s1".to_string(),
            update: GooseSessionUpdate::MessageUsage(MessageUsageUpdate {
                message_id: Some("m1".to_string()),
                usage: MessageUsageData {
                    input_tokens: Some(1200),
                    output_tokens: Some(340),
                    total_tokens: Some(1540),
                    cache_read_tokens: Some(1000),
                    cache_write_tokens: None,
                    cost: Some(0.0123),
                    cost_source: Some(CostSourceData::Estimated),
                    elapsed_ms: Some(4200),
                    time_to_first_token_ms: Some(840),
                    is_compaction: false,
                },
            }),
        };

        let value = serde_json::to_value(notification).unwrap();

        assert_eq!(
            value,
            json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "message_usage",
                    "messageId": "m1",
                    "usage": {
                        "inputTokens": 1200,
                        "outputTokens": 340,
                        "totalTokens": 1540,
                        "cacheReadTokens": 1000,
                        "cost": 0.0123,
                        "costSource": "estimated",
                        "elapsedMs": 4200,
                        "timeToFirstTokenMs": 840,
                        "isCompaction": false
                    }
                }
            })
        );
    }

    #[test]
    fn run_notifications_use_the_declared_methods() {
        assert_eq!(
            RunStartedNotification::default().method(),
            RUN_STARTED_NOTIFICATION_METHOD
        );
        assert_eq!(
            RunFinishedNotification::default().method(),
            RUN_FINISHED_NOTIFICATION_METHOD
        );
    }

    #[test]
    fn run_started_serializes_to_expected_wire_shape() {
        let notification = RunStartedNotification {
            session_id: "s1".to_string(),
            tool_call_id: "call_1".to_string(),
            run_id: "20260920T101530123-a1b2c3".to_string(),
            working_dir: "/projects/q1".to_string(),
            declared_outputs: vec!["results/out.csv".to_string()],
        };
        let value = serde_json::to_value(&notification).unwrap();

        assert_eq!(
            value,
            json!({
                "sessionId": "s1",
                "toolCallId": "call_1",
                "runId": "20260920T101530123-a1b2c3",
                "workingDir": "/projects/q1",
                "declaredOutputs": ["results/out.csv"]
            })
        );
        assert_eq!(
            serde_json::from_value::<RunStartedNotification>(value).unwrap(),
            notification
        );
    }

    #[test]
    fn run_notifications_need_a_run_id() {
        for params in [
            json!({
                "sessionId": "s1",
                "toolCallId": "call_1",
                "workingDir": "/projects/q1",
                "declaredOutputs": []
            }),
            json!({
                "sessionId": "s1",
                "toolCallId": "call_1",
                "runId": null,
                "workingDir": "/projects/q1",
                "declaredOutputs": []
            }),
        ] {
            assert!(serde_json::from_value::<RunStartedNotification>(params).is_err());
        }
        assert!(serde_json::from_value::<RunFinishedNotification>(json!({
            "sessionId": "s1",
            "toolCallId": "call_1",
            "workingDir": "/projects/q1",
            "recordPath": ".modelforge/runs/x.json",
            "outputs": []
        }))
        .is_err());
    }

    #[test]
    fn run_finished_serializes_to_expected_wire_shape() {
        let notification = RunFinishedNotification {
            session_id: "s1".to_string(),
            tool_call_id: "call_1".to_string(),
            run_id: "20260920T101530123-a1b2c3".to_string(),
            working_dir: "/projects/q1".to_string(),
            record_path: ".modelforge/runs/20260920T101530123-a1b2c3.json".to_string(),
            exit_code: None,
            failure: Some("超时".to_string()),
            outputs: vec![],
        };
        let value = serde_json::to_value(&notification).unwrap();

        assert_eq!(
            value,
            json!({
                "sessionId": "s1",
                "toolCallId": "call_1",
                "runId": "20260920T101530123-a1b2c3",
                "workingDir": "/projects/q1",
                "recordPath": ".modelforge/runs/20260920T101530123-a1b2c3.json",
                "exitCode": null,
                "failure": "超时",
                "outputs": []
            })
        );
        assert_eq!(
            serde_json::from_value::<RunFinishedNotification>(value).unwrap(),
            notification
        );
    }
}
