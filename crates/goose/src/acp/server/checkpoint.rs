//! Write-before checkpoint guard injected into the agent when an ACP client
//! declares `checkpointRequests` support. The guard sends
//! `_goose/unstable/session/checkpoint/ensure` to the desktop before the first
//! write tool of each turn, caching the result so a turn creates at most one
//! checkpoint.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::{
    Client, ConnectionTo, JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, UntypedMessage,
};
use async_trait::async_trait;
use goose_sdk_types::custom_requests::{
    EnsureCheckpointRequest, EnsureCheckpointResponse, ENSURE_CHECKPOINT_METHOD,
};
use tokio::sync::{oneshot, Mutex};

use crate::agents::tool_execution::PreWriteGuard;

pub(super) const ENSURE_CHECKPOINT_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) struct CheckpointGuard {
    session_id: String,
    turn: u64,
    cx: ConnectionTo<Client>,
    ensure_state: Mutex<Option<Result<(), String>>>,
}

impl CheckpointGuard {
    pub(super) fn into_guard(
        session_id: String,
        turn: u64,
        cx: ConnectionTo<Client>,
    ) -> Arc<dyn PreWriteGuard> {
        Arc::new(Self {
            session_id,
            turn,
            cx,
            ensure_state: Mutex::new(None),
        })
    }

    async fn do_ensure(&self, working_dir: PathBuf) -> Result<(), String> {
        let request = EnsureCheckpointRequest {
            session_id: self.session_id.clone(),
            turn: self.turn,
            working_dir: working_dir.to_string_lossy().to_string(),
        };
        let (tx, rx) = oneshot::channel();
        self.cx
            .send_request(EnsureCheckpointMessage(request))
            .on_receiving_result(move |result| async move {
                let _ = tx.send(result.map(|response| response.0));
                Ok(())
            })
            .map_err(|error| format!("failed to send checkpoint request: {error}"))?;

        let response = tokio::time::timeout(ENSURE_CHECKPOINT_TIMEOUT, rx)
            .await
            .map_err(|_| "checkpoint request timed out".to_string())?
            .map_err(|_| "checkpoint request was dropped".to_string())?
            .map_err(|error| error.message)?;

        // A successful response means the client created (or already had) a
        // checkpoint for this turn; the checkpoint id is not used here.
        let _ = response;
        Ok(())
    }
}

#[async_trait]
impl PreWriteGuard for CheckpointGuard {
    async fn ensure(&self, working_dir: Option<PathBuf>) -> Result<(), String> {
        let Some(working_dir) = working_dir else {
            return Ok(());
        };

        let mut state = self.ensure_state.lock().await;
        if let Some(cached) = state.clone() {
            return cached;
        }

        let result = self.do_ensure(working_dir).await;
        *state = Some(result.clone());
        result
    }
}

#[derive(Debug, Clone)]
struct EnsureCheckpointMessage(EnsureCheckpointRequest);

impl JsonRpcMessage for EnsureCheckpointMessage {
    fn matches_method(method: &str) -> bool {
        method == ENSURE_CHECKPOINT_METHOD
    }

    fn method(&self) -> &str {
        ENSURE_CHECKPOINT_METHOD
    }

    fn to_untyped_message(&self) -> Result<UntypedMessage, agent_client_protocol::Error> {
        UntypedMessage::new(ENSURE_CHECKPOINT_METHOD, &self.0)
    }

    fn parse_message(
        method: &str,
        params: &impl serde::Serialize,
    ) -> Result<Self, agent_client_protocol::Error> {
        if !Self::matches_method(method) {
            return Err(agent_client_protocol::Error::method_not_found());
        }
        Ok(Self(agent_client_protocol::util::json_cast_params(params)?))
    }
}

impl JsonRpcRequest for EnsureCheckpointMessage {
    type Response = EnsureCheckpointResponseMessage;
}

#[derive(Debug, Clone)]
struct EnsureCheckpointResponseMessage(EnsureCheckpointResponse);

impl JsonRpcResponse for EnsureCheckpointResponseMessage {
    fn into_json(self, _method: &str) -> Result<serde_json::Value, agent_client_protocol::Error> {
        serde_json::to_value(self.0).map_err(agent_client_protocol::Error::into_internal_error)
    }

    fn from_value(
        _method: &str,
        value: serde_json::Value,
    ) -> Result<Self, agent_client_protocol::Error> {
        Ok(Self(agent_client_protocol::util::json_cast(&value)?))
    }
}
