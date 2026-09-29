//! Learning mode (spec mathmodel-parity-and-beyond, task 27.5). The Kernel keeps
//! `learningMode { exerciseId, solutionUnlocked }` in the session `extension_data` and, while it
//! is set, adds the learning-mode system prompt (hints and questions instead of full solution
//! code). Contract: `.kiro/specs/mathmodel-parity-and-beyond/layer-c-contract-acp.md`.

use agent_client_protocol::JsonRpcRequest;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::EmptyResponse;

/// Client → Kernel: set or clear the learning mode of a session.
pub const SET_LEARNING_MODE_METHOD: &str = "_goose/unstable/session/learning-mode/set";

/// Set or clear the learning mode of a session.
#[derive(
    Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, JsonRpcRequest,
)]
#[request(
    method = "_goose/unstable/session/learning-mode/set",
    response = EmptyResponse
)]
#[serde(rename_all = "camelCase")]
pub struct SetLearningModeRequest {
    pub session_id: String,
    // `None` (JSON null or absent) leaves learning mode.
    pub learning_mode: Option<LearningModeDto>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LearningModeDto {
    // The exercise id of `catalog/learning-path.json`.
    pub exercise_id: String,
    // True once the user confirmed "查看完整解答"; the Kernel may then give the full solution.
    pub solution_unlocked: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::JsonRpcMessage;
    use serde_json::json;

    #[test]
    fn set_learning_mode_uses_the_declared_method() {
        assert_eq!(
            JsonRpcMessage::method(&SetLearningModeRequest::default()),
            SET_LEARNING_MODE_METHOD
        );
    }

    #[test]
    fn set_learning_mode_round_trips_the_wire_shape() {
        let request = SetLearningModeRequest {
            session_id: "s1".to_string(),
            learning_mode: Some(LearningModeDto {
                exercise_id: "regression-basics".to_string(),
                solution_unlocked: false,
            }),
        };
        let value = serde_json::to_value(&request).unwrap();

        assert_eq!(
            value,
            json!({
                "sessionId": "s1",
                "learningMode": {
                    "exerciseId": "regression-basics",
                    "solutionUnlocked": false
                }
            })
        );
        assert_eq!(
            serde_json::from_value::<SetLearningModeRequest>(value).unwrap(),
            request
        );
    }

    #[test]
    fn null_or_absent_learning_mode_clears_it() {
        for value in [
            json!({ "sessionId": "s1", "learningMode": null }),
            json!({ "sessionId": "s1" }),
        ] {
            let request: SetLearningModeRequest = serde_json::from_value(value).unwrap();
            assert_eq!(request.learning_mode, None);
        }
    }
}
