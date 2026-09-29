//! `_goose/unstable/tasks/resume` (spec mathmodel-parity-and-beyond, task 25.4). Registered in
//! layer C0 with a placeholder; branch `mp/s2-c1-resume` implements the resume flow here: read
//! `.modelforge/tasks/<taskId>.json`, keep the steps in `skip`, ask before overwriting existing
//! outputs of `resumeFrom` (`GooseAcpAgent::confirm_overwrite`) and run the task from
//! `resumeFrom`. The skip rule lives only in the desktop's `planResume`; the Kernel does not check
//! the plan again. Contract: `.kiro/specs/mathmodel-parity-and-beyond/layer-c-contract-acp.md`.

use goose_sdk_types::custom_requests::{ResumeTaskRequest, ResumeTaskResponse, RESUME_TASK_METHOD};

use super::modelforge_capabilities::{
    capability_not_declared, not_implemented, TASK_RESUME_REQUESTS,
};
use super::GooseAcpAgent;

impl GooseAcpAgent {
    pub(super) async fn on_resume_task(
        &self,
        _req: ResumeTaskRequest,
    ) -> Result<ResumeTaskResponse, agent_client_protocol::Error> {
        if !self.supports_task_resume_requests() {
            return Err(capability_not_declared(
                TASK_RESUME_REQUESTS,
                RESUME_TASK_METHOD,
            ));
        }
        // Placeholder until task 25.4 (branch mp/s2-c1-resume).
        Err(not_implemented(RESUME_TASK_METHOD))
    }
}

#[cfg(test)]
mod tests {
    use super::super::modelforge_capabilities::{
        test_agent, ModelForgeCapabilities, CAPABILITY_NOT_DECLARED, NOT_IMPLEMENTED,
    };
    use super::*;

    fn request() -> ResumeTaskRequest {
        ResumeTaskRequest {
            session_id: "s1".to_string(),
            task_id: "20260920T101530123-a1b2c3".to_string(),
            skip: vec!["clean".to_string()],
            resume_from: Some("fit".to_string()),
            stale_reasons: Vec::new(),
        }
    }

    #[tokio::test]
    async fn resume_requires_the_declared_capability() {
        let root = tempfile::tempdir().unwrap();
        let agent = test_agent(root.path(), ModelForgeCapabilities::default()).await;

        let error = agent.on_resume_task(request()).await.unwrap_err();

        assert_eq!(error.code, agent_client_protocol::ErrorCode::InvalidRequest);
        let data = error.data.unwrap();
        assert_eq!(data["code"], CAPABILITY_NOT_DECLARED);
        assert_eq!(data["capability"], TASK_RESUME_REQUESTS);
    }

    // Replace with the real behaviour when task 25.4 lands.
    #[tokio::test]
    async fn resume_answers_not_implemented_until_task_25_4() {
        let root = tempfile::tempdir().unwrap();
        let agent = test_agent(
            root.path(),
            ModelForgeCapabilities {
                task_resume_requests: true,
                ..Default::default()
            },
        )
        .await;

        let error = agent.on_resume_task(request()).await.unwrap_err();

        assert_eq!(error.code, agent_client_protocol::ErrorCode::InternalError);
        assert_eq!(error.data.unwrap()["code"], NOT_IMPLEMENTED);
    }
}
