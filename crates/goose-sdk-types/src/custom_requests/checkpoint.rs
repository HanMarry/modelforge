use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Kernel → client request asking the desktop to create a checkpoint for the
/// current (session, turn) before the first write of that turn. The client
/// answers with [`EnsureCheckpointResponse`], or an error when a checkpoint
/// could not be created (the pending write is then blocked).
pub const ENSURE_CHECKPOINT_METHOD: &str = "_goose/unstable/session/checkpoint/ensure";

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EnsureCheckpointRequest {
    pub session_id: String,
    pub turn: u64,
    pub working_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EnsureCheckpointResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_id: Option<String>,
}
