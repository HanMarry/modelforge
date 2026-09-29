//! `_goose/unstable/tasks/confirm-overwrite` (spec mathmodel-parity-and-beyond, task 25.4): the
//! Kernel asks the desktop before a resumed step overwrites output files that already exist,
//! listing their paths, sizes and modification times. The resume flow (`task_resume.rs`) calls
//! `GooseAcpAgent::confirm_overwrite` before it starts `resumeFrom` and keeps the task paused on
//! anything but a confirm. Contract: `.kiro/specs/mathmodel-parity-and-beyond/
//! layer-c-contract-acp.md`.

use agent_client_protocol::{
    Client, ConnectionTo, JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, UntypedMessage,
};
use goose_sdk_types::custom_requests::{
    ConfirmOverwriteAction, ConfirmOverwriteRequest, ConfirmOverwriteResponse,
    CONFIRM_OVERWRITE_METHOD,
};
use tokio::sync::oneshot;
use tracing::warn;

use super::GooseAcpAgent;

impl GooseAcpAgent {
    /// Asks the client whether `request.files` may be overwritten. Only an explicit `confirm`
    /// returns [`ConfirmOverwriteAction::Confirm`]. A client that did not declare
    /// `overwriteConfirmRequests`, a connection that is gone, an error answer or a dropped request
    /// all return `Cancel`, and the caller then leaves the task paused with every file untouched
    /// (requirement 22.6). There is no time limit: the user decides.
    pub(super) async fn confirm_overwrite(
        &self,
        request: ConfirmOverwriteRequest,
    ) -> ConfirmOverwriteAction {
        if !self.supports_overwrite_confirm_requests() {
            return ConfirmOverwriteAction::Cancel;
        }
        let Some(cx) = self.client_cx.get() else {
            return ConfirmOverwriteAction::Cancel;
        };
        let session_id = request.session_id.clone();
        match send_confirm_overwrite(cx, request).await {
            Ok(action) => action,
            Err(error) => {
                warn!(
                    session_id = %session_id,
                    error = ?error,
                    "confirm-overwrite request failed; treating it as cancel"
                );
                ConfirmOverwriteAction::Cancel
            }
        }
    }
}

async fn send_confirm_overwrite(
    cx: &ConnectionTo<Client>,
    request: ConfirmOverwriteRequest,
) -> Result<ConfirmOverwriteAction, agent_client_protocol::Error> {
    let (tx, rx) = oneshot::channel();
    cx.send_request(ConfirmOverwriteMessage(request))
        .on_receiving_result(move |result| async move {
            let _ = tx.send(result.map(|response| response.0));
            Ok(())
        })?;
    match rx.await {
        Ok(response) => response.map(|response| response.action),
        Err(_) => Err(agent_client_protocol::Error::internal_error()
            .data("confirm-overwrite request was dropped")),
    }
}

#[derive(Debug, Clone)]
struct ConfirmOverwriteMessage(ConfirmOverwriteRequest);

impl JsonRpcMessage for ConfirmOverwriteMessage {
    fn matches_method(method: &str) -> bool {
        method == CONFIRM_OVERWRITE_METHOD
    }

    fn method(&self) -> &str {
        CONFIRM_OVERWRITE_METHOD
    }

    fn to_untyped_message(&self) -> Result<UntypedMessage, agent_client_protocol::Error> {
        UntypedMessage::new(CONFIRM_OVERWRITE_METHOD, &self.0)
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

impl JsonRpcRequest for ConfirmOverwriteMessage {
    type Response = ConfirmOverwriteResponseMessage;
}

#[derive(Debug, Clone)]
struct ConfirmOverwriteResponseMessage(ConfirmOverwriteResponse);

impl JsonRpcResponse for ConfirmOverwriteResponseMessage {
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

#[cfg(test)]
mod tests {
    use super::super::modelforge_capabilities::{test_agent, ModelForgeCapabilities};
    use super::*;
    use goose_sdk_types::custom_requests::OverwriteFileInfo;
    use serde_json::json;

    fn request() -> ConfirmOverwriteRequest {
        ConfirmOverwriteRequest {
            session_id: "s1".to_string(),
            task_id: "20260920T101530123-a1b2c3".to_string(),
            step_id: "fit".to_string(),
            working_dir: "/projects/q1".to_string(),
            files: vec![OverwriteFileInfo {
                path: "results/out.csv".to_string(),
                size: 2048,
                modified_at: "2026-09-20T10:15:30.123+08:00".to_string(),
            }],
        }
    }

    #[test]
    fn the_message_carries_the_confirm_overwrite_method() {
        let params = serde_json::to_value(request()).unwrap();
        let message =
            ConfirmOverwriteMessage::parse_message(CONFIRM_OVERWRITE_METHOD, &params).unwrap();

        assert_eq!(message.method(), CONFIRM_OVERWRITE_METHOD);
        assert_eq!(message.0, request());
        assert!(
            ConfirmOverwriteMessage::parse_message("_goose/unstable/tasks/resume", &params)
                .is_err()
        );
    }

    #[test]
    fn the_response_needs_a_known_action() {
        let confirmed = ConfirmOverwriteResponseMessage::from_value(
            CONFIRM_OVERWRITE_METHOD,
            json!({ "action": "confirm" }),
        )
        .unwrap();
        assert_eq!(confirmed.0.action, ConfirmOverwriteAction::Confirm);

        for value in [json!({ "action": "overwrite" }), json!({})] {
            assert!(
                ConfirmOverwriteResponseMessage::from_value(CONFIRM_OVERWRITE_METHOD, value)
                    .is_err()
            );
        }
    }

    #[tokio::test]
    async fn without_the_capability_nothing_is_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let agent = test_agent(root.path(), ModelForgeCapabilities::default()).await;

        assert_eq!(
            agent.confirm_overwrite(request()).await,
            ConfirmOverwriteAction::Cancel
        );
    }

    #[tokio::test]
    async fn without_a_client_connection_nothing_is_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let agent = test_agent(
            root.path(),
            ModelForgeCapabilities {
                overwrite_confirm_requests: true,
                ..Default::default()
            },
        )
        .await;

        assert_eq!(
            agent.confirm_overwrite(request()).await,
            ConfirmOverwriteAction::Cancel
        );
    }
}
