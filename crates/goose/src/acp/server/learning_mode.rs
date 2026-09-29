//! `_goose/unstable/session/learning-mode/set` (spec mathmodel-parity-and-beyond, task 27.5).
//! Registered in layer C0 with a placeholder; branch `mp/s2-c1-learning` implements it here: store
//! `learningMode { exerciseId, solutionUnlocked }` in the session `extension_data` (null removes
//! it) and, while it is set, add the learning-mode system prompt to the session's turns. Contract:
//! `.kiro/specs/mathmodel-parity-and-beyond/layer-c-contract-acp.md`.

use goose_sdk_types::custom_requests::{
    EmptyResponse, SetLearningModeRequest, SET_LEARNING_MODE_METHOD,
};

use super::modelforge_capabilities::{
    capability_not_declared, not_implemented, LEARNING_MODE_REQUESTS,
};
use super::GooseAcpAgent;

impl GooseAcpAgent {
    pub(super) async fn on_set_learning_mode(
        &self,
        _req: SetLearningModeRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        if !self.supports_learning_mode_requests() {
            return Err(capability_not_declared(
                LEARNING_MODE_REQUESTS,
                SET_LEARNING_MODE_METHOD,
            ));
        }
        // Placeholder until task 27.5 (branch mp/s2-c1-learning).
        Err(not_implemented(SET_LEARNING_MODE_METHOD))
    }
}

#[cfg(test)]
mod tests {
    use super::super::modelforge_capabilities::{
        test_agent, ModelForgeCapabilities, CAPABILITY_NOT_DECLARED, NOT_IMPLEMENTED,
    };
    use super::*;
    use goose_sdk_types::custom_requests::LearningModeDto;

    fn request() -> SetLearningModeRequest {
        SetLearningModeRequest {
            session_id: "s1".to_string(),
            learning_mode: Some(LearningModeDto {
                exercise_id: "regression-basics".to_string(),
                solution_unlocked: false,
            }),
        }
    }

    #[tokio::test]
    async fn learning_mode_requires_the_declared_capability() {
        let root = tempfile::tempdir().unwrap();
        let agent = test_agent(root.path(), ModelForgeCapabilities::default()).await;

        let error = agent.on_set_learning_mode(request()).await.unwrap_err();

        assert_eq!(error.code, agent_client_protocol::ErrorCode::InvalidRequest);
        let data = error.data.unwrap();
        assert_eq!(data["code"], CAPABILITY_NOT_DECLARED);
        assert_eq!(data["capability"], LEARNING_MODE_REQUESTS);
    }

    // Replace with the real behaviour when task 27.5 lands.
    #[tokio::test]
    async fn learning_mode_answers_not_implemented_until_task_27_5() {
        let root = tempfile::tempdir().unwrap();
        let agent = test_agent(
            root.path(),
            ModelForgeCapabilities {
                learning_mode_requests: true,
                ..Default::default()
            },
        )
        .await;

        let error = agent.on_set_learning_mode(request()).await.unwrap_err();

        assert_eq!(error.code, agent_client_protocol::ErrorCode::InternalError);
        assert_eq!(error.data.unwrap()["code"], NOT_IMPLEMENTED);
    }
}
