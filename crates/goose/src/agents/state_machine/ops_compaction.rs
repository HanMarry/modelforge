//! Compacts conversation history when it is too large for the configured context window.

use std::sync::Arc;

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use tracing_futures::Instrument;

use crate::agents::state_machine::ops_llm::{chat_span, record_chat_usage};
use crate::agents::state_machine::{
    applied, last_effective_role, messages_since_kickoff, not_applicable, trailing_error, yielded,
    yielded_with, ConversationEffect, Emitter, GooseEffect, Operation, OperationResult,
    SlashCommand,
};
use crate::context_mgmt::compact_messages;
use crate::conversation::message::{Message, MessageErrorKind, SystemNotificationType};
use crate::conversation::{Conversation, EffectiveRole};
use crate::providers::base::Provider;
use crate::session::Session;
use goose_providers::model::ModelConfig;

const COMPACTION_PROGRESS_TEXT: &str = "goose is compacting the conversation...";
const COMPACTION_OPERATION_NAME: &str = "compaction";
const REACTIVE_COMPACTION_NOTE: &str = "reactive";

pub(super) const MAX_CONTEXT_ERROR_COMPACTIONS: usize = 2;

fn compaction_part(
    total_tokens: Option<i32>,
    context_limit: usize,
    threshold: f64,
) -> Option<String> {
    let total_tokens = total_tokens?;
    if total_tokens <= 0 || context_limit == 0 || threshold <= 0.0 || threshold >= 1.0 {
        return None;
    }

    let compaction_at = (context_limit as f64 * threshold) as i32;
    if compaction_at <= 0 || (total_tokens as f64 / compaction_at as f64) < 0.5 {
        return None;
    }

    Some(format!(
        "<compaction>~{}k tokens remaining</compaction>",
        compaction_at.saturating_sub(total_tokens) / 1000
    ))
}

pub struct CompactionOperation {
    provider: Arc<dyn Provider>,
    model_config: ModelConfig,
    context_limit: usize,
    threshold: f64,
    manages_own_context: bool,
}

impl CompactionOperation {
    pub fn new(
        provider: Arc<dyn Provider>,
        model_config: ModelConfig,
        context_limit: usize,
        threshold: f64,
    ) -> Self {
        let manages_own_context = provider.manages_own_context();
        Self {
            provider,
            model_config,
            context_limit,
            threshold,
            manages_own_context,
        }
    }

    fn over_threshold(&self, tokens: usize) -> bool {
        if self.threshold <= 0.0 || self.threshold >= 1.0 {
            return false;
        }
        (tokens as f64 / self.context_limit as f64) > self.threshold
    }

    async fn context_tokens(&self, session: &Session, conversation: &Conversation) -> Result<i32> {
        match session.usage.total_tokens {
            Some(tokens) => Ok(tokens),
            None => crate::context_mgmt::count_context_tokens(conversation).await,
        }
    }

    async fn command_error(
        conversation: &Conversation,
        message: String,
        emit: &Emitter,
    ) -> Result<OperationResult<GooseEffect>> {
        let command = messages_since_kickoff(conversation)?
            .first()
            .cloned()
            .ok_or_else(|| anyhow!("compact command conversation has no kickoff message"))?;
        let message_id = command
            .id
            .clone()
            .ok_or_else(|| anyhow!("Persisted slash command message has no id"))?;
        let command = command.with_visibility(true, false);
        let response = Message::assistant()
            .with_text(message)
            .with_visibility(true, false);
        emit.message(command).await;
        let response = emit.message(response).await;
        yielded_with([
            ConversationEffect::SetMessageVisibility {
                message_id,
                user_visible: true,
                agent_visible: false,
            }
            .into(),
            response.into(),
        ])
    }

    async fn clear(
        conversation: &Conversation,
        emit: &Emitter,
    ) -> Result<OperationResult<GooseEffect>> {
        let command = messages_since_kickoff(conversation)?
            .first()
            .cloned()
            .ok_or_else(|| anyhow!("clear command conversation has no kickoff message"))?;
        let response = Message::assistant()
            .with_text("Conversation cleared")
            .with_visibility(true, false);
        // Like the legacy command path, echo the command as the user sent it; the
        // replacement below records it as user-only.
        let command = emit.message(command).await.with_visibility(true, false);
        let response = emit.message(response).await;
        yielded_with([Conversation::new_unvalidated([command, response]).into()])
    }
}

#[async_trait]
impl Operation<Session, GooseEffect> for CompactionOperation {
    fn name(&self) -> &'static str {
        "compaction"
    }

    async fn run_command(
        &self,
        command: &SlashCommand<'_>,
        session: &Session,
        conversation: &Conversation,
        emit: &Emitter,
    ) -> Result<OperationResult<GooseEffect>> {
        match command.command {
            "clear" => return Self::clear(conversation, emit).await,
            "compact" => {}
            _ => return not_applicable(),
        }

        // Like the legacy command path, compact the history the command was sent
        // after, then record the command and its reply after the summary.
        let since_kickoff = messages_since_kickoff(conversation)?;
        let command = since_kickoff
            .first()
            .cloned()
            .ok_or_else(|| anyhow!("compact command conversation has no kickoff message"))?;
        let history = Conversation::new_unvalidated(
            conversation.messages()[..conversation.len() - since_kickoff.len()].to_vec(),
        );

        let span = chat_span(
            self.provider.as_ref(),
            &self.model_config,
            &session.id,
            "compaction",
        );
        let result = match compact_messages(
            self.provider.as_ref(),
            &self.model_config,
            &session.id,
            &history,
            true,
        )
        .instrument(span.clone())
        .await
        {
            Ok(result) => result,
            Err(error) => {
                span.record("error.type", "compaction_error");
                return Self::command_error(conversation, error.to_string(), emit).await;
            }
        };
        let usage = result.usage;
        record_chat_usage(&span, &usage);

        let response = Message::assistant()
            .with_text("Compaction complete")
            .with_visibility(true, false);
        // Echo the command as the user sent it; the replacement records it as
        // user-only.
        let command = emit.message(command).await.with_visibility(true, false);
        let response = emit.message(response).await;
        let mut compacted = result.conversation.messages().to_vec();
        compacted.extend([command, response]);
        yielded_with([GooseEffect::ReplaceConversation {
            conversation: Conversation::new_unvalidated(compacted),
            usage: Some(usage),
            then_announce: None,
        }])
    }

    async fn moim_parts(
        &self,
        session: &Session,
        conversation: &Conversation,
    ) -> Result<Vec<String>> {
        if self.manages_own_context {
            return Ok(Vec::new());
        }
        Ok(compaction_part(
            Some(self.context_tokens(session, conversation).await?),
            self.context_limit,
            self.threshold,
        )
        .into_iter()
        .collect())
    }

    async fn run(
        &self,
        session: &Session,
        conversation: &Conversation,
        emit: &Emitter,
    ) -> Result<OperationResult<GooseEffect>> {
        if self.manages_own_context {
            return not_applicable();
        }

        let messages = messages_since_kickoff(conversation)?;
        let reactive_context_error = matches!(
            trailing_error(conversation),
            Some(MessageErrorKind::ContextLengthExceeded)
        );

        if reactive_context_error {
            let prior_compactions = messages
                .iter()
                .filter(|message| is_reactive_compaction_summary(message))
                .count();
            if prior_compactions >= MAX_CONTEXT_ERROR_COMPACTIONS {
                return not_applicable();
            }
        } else {
            if last_effective_role(messages)? != EffectiveRole::User {
                return not_applicable();
            }
            let tokens = self.context_tokens(session, conversation).await?;
            if tokens <= 0 || !self.over_threshold(tokens as usize) {
                return not_applicable();
            }
        }

        // The provider error behind a reactive compaction is dropped, not kept in
        // history: the legacy loop never records it, and leaving it after the
        // prompt would make the summary treat the prompt as an unfinished tool loop.
        let conversation_without_error;
        let conversation = if reactive_context_error {
            let mut messages = conversation.messages().to_vec();
            messages.pop();
            conversation_without_error = Conversation::new_unvalidated(messages);
            &conversation_without_error
        } else {
            conversation
        };

        let notice = if reactive_context_error {
            "Context limit reached. Compacting to continue conversation...".to_string()
        } else {
            let threshold_percentage = (self.threshold * 100.0) as u32;
            format!(
                "Exceeded auto-compact threshold of {threshold_percentage}%. \
                 Performing auto-compaction..."
            )
        };
        emit.message(
            Message::assistant()
                .with_system_notification(SystemNotificationType::InlineMessage, notice),
        )
        .await;
        emit.message(Message::assistant().with_system_notification(
            SystemNotificationType::ProgressMessage,
            COMPACTION_PROGRESS_TEXT,
        ))
        .await;

        let span = chat_span(
            self.provider.as_ref(),
            &self.model_config,
            &session.id,
            "compaction",
        );
        match compact_messages(
            self.provider.as_ref(),
            &self.model_config,
            &session.id,
            conversation,
            false,
        )
        .instrument(span.clone())
        .await
        {
            Ok(result) => {
                let mut compacted = result.conversation;
                let usage = result.usage;
                record_chat_usage(&span, &usage);
                let mut then_announce = None;
                if reactive_context_error {
                    // The summary directly follows the retained originals.
                    if let Some(summary) = compacted.messages_mut().get_mut(conversation.len()) {
                        summary.metadata.set_operation_note(
                            COMPACTION_OPERATION_NAME,
                            REACTIVE_COMPACTION_NOTE,
                            serde_json::Value::Bool(true),
                        );
                    }
                } else {
                    // Reported once the replacement is published, as the legacy loop
                    // yields it after `HistoryReplaced`.
                    then_announce = Some(Box::new(Message::assistant().with_system_notification(
                        SystemNotificationType::InlineMessage,
                        "Compaction complete",
                    )));
                }
                applied([GooseEffect::ReplaceConversation {
                    conversation: compacted,
                    usage: Some(usage),
                    then_announce,
                }])
            }
            Err(e) => {
                span.record("error.type", "compaction_error");
                emit.message(Message::assistant().with_text(format!(
                    "Ran into this error trying to compact: {e}.\n\n\
                     Please try again or create a new session"
                )))
                .await;
                yielded()
            }
        }
    }
}

/// Reactive compactions mark their summary so later context errors in the same
/// turn can count them; the note lives in `metadata.operations`, never sent to
/// providers.
fn is_reactive_compaction_summary(message: &Message) -> bool {
    message
        .metadata
        .operation_note(COMPACTION_OPERATION_NAME, REACTIVE_COMPACTION_NOTE)
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}
