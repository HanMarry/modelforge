//! Client capabilities of ModelForge layer C (spec mathmodel-parity-and-beyond). Each one is off
//! unless the client declares it in `clientCapabilities._meta.goose` of `initialize`, the same way
//! as `checkpointRequests`, so other ACP clients and the CLI see no change:
//!
//! - `runNotifications`: the Kernel may send `_goose/unstable/runs/started` and
//!   `_goose/unstable/runs/finished`.
//! - `overwriteConfirmRequests`: the Kernel may send `_goose/unstable/tasks/confirm-overwrite`.
//! - `taskResumeRequests`: the Kernel accepts `_goose/unstable/tasks/resume`.
//! - `learningModeRequests`: the Kernel accepts `_goose/unstable/session/learning-mode/set`.
//!
//! The keys are read through `GooseClientCapabilities`. Contract:
//! `.kiro/specs/mathmodel-parity-and-beyond/layer-c-contract-acp.md`.

use super::{GooseAcpAgent, GooseClientCapabilities};

/// Capability key of `_goose/unstable/tasks/resume`, named in its rejection error.
pub(super) const TASK_RESUME_REQUESTS: &str = "taskResumeRequests";
/// Capability key of `_goose/unstable/session/learning-mode/set`, named in its rejection error.
pub(super) const LEARNING_MODE_REQUESTS: &str = "learningModeRequests";

/// Error `data.code` of a client → Kernel request whose capability was not declared.
pub(super) const CAPABILITY_NOT_DECLARED: &str = "CAPABILITY_NOT_DECLARED";
/// Error `data.code` of a registered method whose handler is still a placeholder.
pub(super) const NOT_IMPLEMENTED: &str = "NOT_IMPLEMENTED";

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(super) struct ModelForgeCapabilities {
    pub(super) run_notifications: bool,
    pub(super) overwrite_confirm_requests: bool,
    pub(super) task_resume_requests: bool,
    pub(super) learning_mode_requests: bool,
}

pub(super) fn extract_modelforge_capabilities(
    goose_client_capabilities: Option<&GooseClientCapabilities>,
) -> ModelForgeCapabilities {
    let Some(goose) = goose_client_capabilities else {
        return ModelForgeCapabilities::default();
    };
    ModelForgeCapabilities {
        run_notifications: goose.run_notifications.unwrap_or(false),
        overwrite_confirm_requests: goose.overwrite_confirm_requests.unwrap_or(false),
        task_resume_requests: goose.task_resume_requests.unwrap_or(false),
        learning_mode_requests: goose.learning_mode_requests.unwrap_or(false),
    }
}

impl GooseAcpAgent {
    fn modelforge_capabilities(&self) -> ModelForgeCapabilities {
        self.client_modelforge_capabilities
            .get()
            .copied()
            .unwrap_or_default()
    }

    pub(super) fn supports_run_notifications(&self) -> bool {
        self.modelforge_capabilities().run_notifications
    }

    pub(super) fn supports_overwrite_confirm_requests(&self) -> bool {
        self.modelforge_capabilities().overwrite_confirm_requests
    }

    pub(super) fn supports_task_resume_requests(&self) -> bool {
        self.modelforge_capabilities().task_resume_requests
    }

    pub(super) fn supports_learning_mode_requests(&self) -> bool {
        self.modelforge_capabilities().learning_mode_requests
    }
}

/// Rejects a client → Kernel request whose capability the client did not declare.
pub(super) fn capability_not_declared(
    capability: &str,
    method: &str,
) -> agent_client_protocol::Error {
    agent_client_protocol::Error::invalid_request().data(serde_json::json!({
        "code": CAPABILITY_NOT_DECLARED,
        "capability": capability,
        "method": method,
        "message": format!(
            "declare clientCapabilities._meta.goose.{capability} in initialize to use {method}"
        ),
    }))
}

/// Answers a registered method whose handler is still a placeholder (layer C0); the C1 branch
/// named in the contract replaces it.
pub(super) fn not_implemented(method: &str) -> agent_client_protocol::Error {
    agent_client_protocol::Error::new(-32603, format!("{method} is not implemented yet")).data(
        serde_json::json!({
            "code": NOT_IMPLEMENTED,
            "method": method,
        }),
    )
}

/// An agent on a temporary data directory that negotiated `capabilities`.
#[cfg(test)]
pub(super) async fn test_agent(
    root: &std::path::Path,
    capabilities: ModelForgeCapabilities,
) -> GooseAcpAgent {
    use super::{AcpBuiltinSelection, AcpProviderFactory, GooseAcpAgentOptions};
    use crate::agents::GoosePlatform;
    use std::sync::Arc;

    let provider_factory: AcpProviderFactory = Arc::new(
        |_provider_name, _extensions, _working_dir, _use_default_model| {
            Box::pin(async { Err(anyhow::anyhow!("unused provider factory")) })
        },
    );
    let agent = GooseAcpAgent::new(GooseAcpAgentOptions {
        provider_factory,
        builtin_selection: AcpBuiltinSelection::default(),
        data_dir: root.to_path_buf(),
        config_dir: root.to_path_buf(),
        disable_session_naming: true,
        goose_platform: GoosePlatform::GooseCli,
        additional_source_roots: Vec::new(),
        scheduler: None,
        session_cwd: None,
        active_prompt_runs: Default::default(),
    })
    .await
    .unwrap();
    agent
        .client_modelforge_capabilities
        .set(capabilities)
        .unwrap();
    agent
}

#[cfg(test)]
mod tests {
    use super::super::extract_client_capabilities_meta;
    use super::*;
    use agent_client_protocol::schema::v1::{ClientCapabilities, InitializeRequest};
    use agent_client_protocol::schema::ProtocolVersion;

    fn declared(keys: &[&str]) -> ModelForgeCapabilities {
        let mut goose_meta = serde_json::Map::new();
        for key in keys {
            goose_meta.insert(key.to_string(), serde_json::Value::Bool(true));
        }
        // A capability the client sets to false stays off.
        goose_meta.insert(
            "checkpointRequests".to_string(),
            serde_json::Value::Bool(false),
        );
        let mut meta = serde_json::Map::new();
        meta.insert("goose".to_string(), serde_json::Value::Object(goose_meta));
        let request = InitializeRequest::new(ProtocolVersion::V1)
            .client_capabilities(ClientCapabilities::new().meta(meta));
        let goose_client_capabilities =
            extract_client_capabilities_meta(&request).and_then(|meta| meta.goose);
        extract_modelforge_capabilities(goose_client_capabilities.as_ref())
    }

    #[test]
    fn capabilities_default_to_off() {
        let request = InitializeRequest::new(ProtocolVersion::V1);
        let goose_client_capabilities =
            extract_client_capabilities_meta(&request).and_then(|meta| meta.goose);

        assert_eq!(
            extract_modelforge_capabilities(goose_client_capabilities.as_ref()),
            ModelForgeCapabilities::default()
        );
        assert_eq!(declared(&[]), ModelForgeCapabilities::default());
    }

    // The keys are spelled out: they are the wire names the desktop declares in
    // `ui/desktop/src/acp/acpConnection.ts`.
    #[test]
    fn each_capability_is_read_from_its_own_key() {
        assert_eq!(
            declared(&["runNotifications"]),
            ModelForgeCapabilities {
                run_notifications: true,
                ..Default::default()
            }
        );
        assert_eq!(
            declared(&["overwriteConfirmRequests"]),
            ModelForgeCapabilities {
                overwrite_confirm_requests: true,
                ..Default::default()
            }
        );
        assert_eq!(
            declared(&["taskResumeRequests"]),
            ModelForgeCapabilities {
                task_resume_requests: true,
                ..Default::default()
            }
        );
        assert_eq!(
            declared(&["learningModeRequests"]),
            ModelForgeCapabilities {
                learning_mode_requests: true,
                ..Default::default()
            }
        );
        assert_eq!(
            declared(&[
                "runNotifications",
                "overwriteConfirmRequests",
                "taskResumeRequests",
                "learningModeRequests",
            ]),
            ModelForgeCapabilities {
                run_notifications: true,
                overwrite_confirm_requests: true,
                task_resume_requests: true,
                learning_mode_requests: true,
            }
        );
    }

    #[test]
    fn error_keys_match_the_wire_names() {
        assert_eq!(TASK_RESUME_REQUESTS, "taskResumeRequests");
        assert_eq!(LEARNING_MODE_REQUESTS, "learningModeRequests");
    }

    #[test]
    fn a_malformed_capability_does_not_turn_anything_on() {
        let mut goose_meta = serde_json::Map::new();
        goose_meta.insert(
            "runNotifications".to_string(),
            serde_json::Value::String("yes".to_string()),
        );
        let mut meta = serde_json::Map::new();
        meta.insert("goose".to_string(), serde_json::Value::Object(goose_meta));
        let request = InitializeRequest::new(ProtocolVersion::V1)
            .client_capabilities(ClientCapabilities::new().meta(meta));
        let goose_client_capabilities =
            extract_client_capabilities_meta(&request).and_then(|meta| meta.goose);

        assert_eq!(
            extract_modelforge_capabilities(goose_client_capabilities.as_ref()),
            ModelForgeCapabilities::default()
        );
    }

    #[tokio::test]
    async fn an_agent_reports_what_the_client_declared() {
        let root = tempfile::tempdir().unwrap();
        let agent = test_agent(
            root.path(),
            ModelForgeCapabilities {
                run_notifications: true,
                learning_mode_requests: true,
                ..Default::default()
            },
        )
        .await;

        assert!(agent.supports_run_notifications());
        assert!(!agent.supports_overwrite_confirm_requests());
        assert!(!agent.supports_task_resume_requests());
        assert!(agent.supports_learning_mode_requests());
    }

    #[test]
    fn errors_name_the_capability_and_the_method() {
        let error = capability_not_declared(TASK_RESUME_REQUESTS, "_goose/unstable/tasks/resume");
        assert_eq!(error.code, agent_client_protocol::ErrorCode::InvalidRequest);
        let data = error.data.unwrap();
        assert_eq!(data["code"], CAPABILITY_NOT_DECLARED);
        assert_eq!(data["capability"], TASK_RESUME_REQUESTS);
        assert_eq!(data["method"], "_goose/unstable/tasks/resume");

        let error = not_implemented("_goose/unstable/tasks/resume");
        assert_eq!(error.code, agent_client_protocol::ErrorCode::InternalError);
        assert_eq!(
            error.data,
            Some(serde_json::json!({
                "code": NOT_IMPLEMENTED,
                "method": "_goose/unstable/tasks/resume",
            }))
        );
    }
}
