use anyhow::Result;
use async_trait::async_trait;

use crate::agents::state_machine::effects::GooseEffect;
use crate::agents::state_machine::usage;
use crate::agents::AgentEvent;
use crate::conversation::message::{ActionRequiredData, Message, MessageContent};
use crate::conversation::Conversation;
use crate::session::{Session, SessionManager};
use goose_agent::machine::{EffectHandler, EffectUsage, MachineSession, SessionLoader};
use goose_agent::operation::{ConversationEffect, Emitter, MachineEffect};

fn contains_tool_confirmation_request(message: &Message) -> bool {
    message.content.iter().any(|content| {
        matches!(
            content,
            MessageContent::ActionRequired(action)
                if matches!(&action.data, ActionRequiredData::ToolConfirmation { .. })
        )
    })
}

impl MachineSession for Session {
    fn id(&self) -> &str {
        &self.id
    }
    fn conversation(&self) -> Option<&Conversation> {
        self.conversation.as_ref()
    }
}

#[async_trait]
impl SessionLoader<Session> for SessionManager {
    async fn load(&self, session_id: &str) -> Result<Session> {
        self.get_session(session_id, true).await
    }
}

#[async_trait]
impl EffectHandler<Session, GooseEffect> for SessionManager {
    async fn apply_effects(
        &self,
        session: &Session,
        effects: &mut [GooseEffect],
        emit: &Emitter,
    ) -> Result<()> {
        for effect in effects.iter_mut() {
            effect.ensure_message_ids();
        }
        usage::enrich(session, effects);

        for effect in effects.iter_mut() {
            match effect {
                GooseEffect::Conversation(ConversationEffect::AppendMessage(message)) => {
                    self.add_message(&session.id, message).await?;
                }
                GooseEffect::Conversation(ConversationEffect::ReplaceConversation(
                    conversation,
                )) => {
                    self.replace_conversation(&session.id, conversation).await?;
                    self.update(&session.id)
                        .usage(usage::estimate_context(conversation).await?)
                        .apply()
                        .await?;
                }
                GooseEffect::ReplaceConversation {
                    conversation,
                    usage: replacement_usage,
                } => {
                    if let Some(provider_usage) = replacement_usage {
                        usage::record(self, session, provider_usage, true).await?;
                    }
                    self.replace_conversation(&session.id, conversation).await?;
                    self.update(&session.id)
                        .usage(usage::estimate_context(conversation).await?)
                        .apply()
                        .await?;
                }
                GooseEffect::Conversation(ConversationEffect::PatchToolRequestMeta {
                    tool_call_id,
                    patch,
                }) => {
                    self.update_tool_request_meta(&session.id, tool_call_id, patch.clone())
                        .await?;
                }
                GooseEffect::Conversation(ConversationEffect::SetMessageVisibility {
                    message_id,
                    user_visible,
                    agent_visible,
                }) => {
                    self.update_message_metadata(&session.id, message_id, |mut metadata| {
                        metadata.user_visible = *user_visible;
                        metadata.agent_visible = *agent_visible;
                        metadata
                    })
                    .await?;
                }
                GooseEffect::SetRecipe(recipe) => {
                    self.update(&session.id)
                        .recipe(recipe.as_ref().clone())
                        .apply()
                        .await?;
                }
                GooseEffect::SetExtensionData(extension_data) => {
                    self.update(&session.id)
                        .extension_data(extension_data.clone())
                        .apply()
                        .await?;
                }
                GooseEffect::RecordUsage(provider_usage) => {
                    usage::record(self, session, provider_usage, false).await?;
                }
            }
        }

        for effect in effects {
            match effect {
                GooseEffect::Conversation(ConversationEffect::AppendMessage(message)) => {
                    if contains_tool_confirmation_request(message) {
                        // Responses can arrive immediately, so publish only after the persistence pass.
                        emit.emit(AgentEvent::Message(message.clone())).await;
                    }
                    if let Some(usage) = message
                        .metadata
                        .usage
                        .as_deref()
                        .filter(|_| !message.user_visible_content().content.is_empty())
                        .cloned()
                    {
                        emit.emit(AgentEvent::MessageUsage {
                            message_id: message.id.clone(),
                            usage,
                        })
                        .await;
                    }
                }
                GooseEffect::Conversation(ConversationEffect::ReplaceConversation(
                    conversation,
                ))
                | GooseEffect::ReplaceConversation { conversation, .. } => {
                    emit.emit(AgentEvent::HistoryReplaced(conversation.clone()))
                        .await;
                }
                GooseEffect::RecordUsage(usage) => {
                    emit.emit(AgentEvent::Usage(usage.clone())).await
                }
                _ => {}
            }
        }
        Ok(())
    }
}

impl EffectUsage<GooseEffect> for SessionManager {
    fn usage(
        &self,
        effect: &GooseEffect,
    ) -> Option<goose_providers::conversation::token_usage::Usage> {
        match effect {
            GooseEffect::RecordUsage(usage)
            | GooseEffect::ReplaceConversation {
                usage: Some(usage), ..
            } => Some(usage.usage),
            _ => None,
        }
    }
}

/// Folds persisted effects into the in-memory session after every apply, so each
/// later step observes the same state a fresh `load()` would have returned —
/// without re-reading the whole session from SQLite on every step.
///
/// Must stay in sync with `SessionManager::apply_effects` above: every effect
/// variant persisted there is mirrored here with the same semantics.
async fn mirror_effects(session: &mut Session, effects: &[GooseEffect]) -> Result<()> {
    for effect in effects {
        match effect {
            GooseEffect::Conversation(ConversationEffect::AppendMessage(message)) => {
                let Some(conversation) = session.conversation.as_mut() else {
                    continue;
                };
                let mut message = message.clone();
                if let Some(last) = conversation.messages().last() {
                    message.created = message.created.max(last.created);
                }
                conversation.messages_mut().push(message);
            }
            GooseEffect::Conversation(ConversationEffect::ReplaceConversation(conversation)) => {
                session.conversation = Some(conversation.clone());
                session.usage = usage::estimate_context(conversation).await?;
            }
            GooseEffect::ReplaceConversation {
                conversation,
                usage: replacement_usage,
            } => {
                if let Some(provider_usage) = replacement_usage {
                    session.accumulated_usage += provider_usage.usage;
                }
                session.conversation = Some(conversation.clone());
                session.usage = usage::estimate_context(conversation).await?;
            }
            GooseEffect::Conversation(ConversationEffect::PatchToolRequestMeta {
                tool_call_id,
                patch,
            }) => {
                let (Some(conversation), Some(source)) =
                    (session.conversation.as_mut(), patch.as_object())
                else {
                    continue;
                };
                for message in conversation.messages_mut().iter_mut().rev() {
                    let tool_request =
                        message
                            .content
                            .iter_mut()
                            .find_map(|content| match content {
                                MessageContent::ToolRequest(request)
                                    if request.id == *tool_call_id =>
                                {
                                    Some(request)
                                }
                                _ => None,
                            });
                    if let Some(tool_request) = tool_request {
                        let meta = tool_request
                            .tool_meta
                            .get_or_insert_with(|| serde_json::json!({}));
                        if let Some(target) = meta.as_object_mut() {
                            for (key, value) in source {
                                target.insert(key.clone(), value.clone());
                            }
                        }
                        break;
                    }
                }
            }
            GooseEffect::Conversation(ConversationEffect::SetMessageVisibility {
                message_id,
                user_visible,
                agent_visible,
            }) => {
                let Some(conversation) = session.conversation.as_mut() else {
                    continue;
                };
                if let Some(message) = conversation
                    .messages_mut()
                    .iter_mut()
                    .find(|message| message.id.as_deref() == Some(message_id.as_str()))
                {
                    message.metadata.user_visible = *user_visible;
                    message.metadata.agent_visible = *agent_visible;
                }
            }
            GooseEffect::SetRecipe(recipe) => {
                session.recipe = (**recipe).clone();
            }
            GooseEffect::SetExtensionData(extension_data) => {
                session.extension_data = extension_data.clone();
            }
            GooseEffect::RecordUsage(provider_usage) => {
                session.usage = provider_usage.usage;
                session.accumulated_usage += provider_usage.usage;
            }
        }
    }
    Ok(())
}

pub(crate) async fn run(
    machine: &crate::agents::state_machine::StateMachine<'_, Session, GooseEffect>,
    runtime: &SessionManager,
    session_id: &str,
    emit: &Emitter,
) -> Result<Session> {
    let mut session = runtime.load(session_id).await?;
    tracing::Span::current().record(
        "gen_ai.agent.name",
        crate::agents::gen_ai_telemetry::agent_name(&session),
    );
    let trace_input = if crate::agents::gen_ai_telemetry::capture_message_content() {
        session
            .conversation()
            .and_then(|conversation| {
                crate::agents::state_machine::messages_since_kickoff(conversation).ok()
            })
            .and_then(|messages| messages.first())
            .map(crate::conversation::message::Message::user_visible_content)
            .map(|message| message.as_concat_text())
            .filter(|text| !text.is_empty())
    } else {
        None
    };
    if let Some(input) = trace_input {
        tracing::Span::current().record("trace_input", input.as_str());
    }

    let mut turn_usage = goose_providers::conversation::token_usage::Usage::default();
    loop {
        // session 在每步 apply 后由 mirror_effects 同步到与持久层一致，无需逐步重载
        let Some(mut result) = machine.step(&session, emit).await? else {
            break;
        };
        tracing::debug!(target: "goose::state_machine", step = result.applied_step, "applied step");
        for effect in &result.effects {
            if let Some(usage) = runtime.usage(effect) {
                turn_usage += usage;
            }
        }
        machine.apply(runtime, &session, &mut result, emit).await?;
        mirror_effects(&mut session, &result.effects).await?;
        if result.yield_to_client {
            break;
        }
    }

    let last_assistant_text = session
        .conversation()
        .and_then(|conversation| {
            crate::agents::state_machine::messages_since_kickoff(conversation).ok()
        })
        .into_iter()
        .flatten()
        .rev()
        .filter(|message| message.role == rmcp::model::Role::Assistant)
        .map(crate::conversation::message::Message::user_visible_content)
        .map(|message| message.as_concat_text())
        .find(|text| !text.is_empty())
        .unwrap_or_default();
    if !last_assistant_text.is_empty() {
        let span = tracing::Span::current();
        if crate::agents::gen_ai_telemetry::capture_message_content() {
            span.record("trace_output", last_assistant_text.as_str());
            let output = crate::agents::gen_ai_telemetry::simple_output_json(&last_assistant_text);
            span.record("gen_ai.output.messages", output.as_str());
        }
    }
    crate::agents::gen_ai_telemetry::record_usage(&tracing::Span::current(), &turn_usage);
    Ok(session)
}
