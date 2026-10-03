//! Ends the turn when an error remains at the end of the conversation.

use anyhow::Result;
use async_trait::async_trait;

use crate::agents::state_machine::effects::GooseEffect;
use crate::agents::state_machine::{
    not_applicable, trailing_error, yielded, Emitter, Operation, OperationResult,
};
use crate::agents::AgentEvent;
use crate::conversation::message::MessageErrorKind;
use crate::conversation::Conversation;
use crate::session::Session;

pub struct ExitOnErrorOperation;

#[async_trait]
impl Operation<Session, GooseEffect> for ExitOnErrorOperation {
    fn name(&self) -> &'static str {
        "exit_on_error"
    }

    async fn run(
        &self,
        _session: &Session,
        conversation: &Conversation,
        emit: &Emitter,
    ) -> Result<OperationResult<GooseEffect>> {
        let Some(kind) = trailing_error(conversation) else {
            return not_applicable();
        };

        // Context-limit errors are recorded without being emitted so compaction can
        // recover silently; when it could not, show the error before ending the turn.
        if kind == MessageErrorKind::ContextLengthExceeded {
            if let Some(message) = conversation.last() {
                emit.emit(AgentEvent::Message(message.clone())).await;
            }
        }

        yielded()
    }
}
