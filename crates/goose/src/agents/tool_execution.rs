use async_stream::try_stream;
use async_trait::async_trait;
use futures::stream::{self, BoxStream};
use futures::{Stream, StreamExt};
use rmcp::model::CallToolResult;
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use std::path::PathBuf;

use crate::config::permission::PermissionLevel;
use crate::conversation::message::Message;
use crate::mcp_utils::ToolResult;
use crate::permission::Permission;
use rmcp::model::{ContentBlock, ServerNotification};

#[derive(Clone)]
pub(crate) struct ToolCallNotificationEmitter {
    sender: mpsc::Sender<ServerNotification>,
}

impl ToolCallNotificationEmitter {
    pub(crate) fn new(sender: mpsc::Sender<ServerNotification>) -> Self {
        Self { sender }
    }

    pub(crate) fn emit_best_effort(&self, notification: ServerNotification) {
        // Do not let a slow notification consumer delay tool execution.
        let _ = self.sender.try_send(notification);
    }
}

/// Guards tools that may modify the working tree (developer `write`/`edit`/
/// `shell`). The ACP server injects a guard when a client declares checkpoint
/// support; `ensure` must succeed before the tool runs, and success is cached so
/// a turn only creates one checkpoint.
#[async_trait]
pub trait PreWriteGuard: Send + Sync {
    async fn ensure(&self, working_dir: Option<PathBuf>) -> Result<(), String>;
}

/// Context passed through the tool call dispatch chain.
#[derive(Clone)]
pub struct ToolCallContext {
    pub session_id: String,
    pub working_dir: Option<PathBuf>,
    pub tool_call_request_id: Option<String>,
    notification_emitter: Option<ToolCallNotificationEmitter>,
    pre_write_guard: Option<Arc<dyn PreWriteGuard>>,
}

impl ToolCallContext {
    pub fn new(
        session_id: String,
        working_dir: Option<PathBuf>,
        tool_call_request_id: Option<String>,
    ) -> Self {
        Self {
            session_id,
            working_dir,
            tool_call_request_id,
            notification_emitter: None,
            pre_write_guard: None,
        }
    }

    pub fn working_dir_str(&self) -> Option<&str> {
        self.working_dir.as_ref().and_then(|p| p.to_str())
    }

    pub(crate) fn with_notification_emitter(
        mut self,
        notification_emitter: ToolCallNotificationEmitter,
    ) -> Self {
        self.notification_emitter = Some(notification_emitter);
        self
    }

    pub(crate) fn notification_emitter(&self) -> Option<&ToolCallNotificationEmitter> {
        self.notification_emitter.as_ref()
    }

    pub(crate) fn with_pre_write_guard(
        mut self,
        pre_write_guard: Option<Arc<dyn PreWriteGuard>>,
    ) -> Self {
        self.pre_write_guard = pre_write_guard;
        self
    }

    pub(crate) fn pre_write_guard(&self) -> Option<Arc<dyn PreWriteGuard>> {
        self.pre_write_guard.clone()
    }
}

// ToolCallResult combines the result of a tool call with an optional notification stream that
// can be used to receive notifications from the tool.
pub struct ToolCallResult {
    pub result: Box<dyn Future<Output = ToolResult<rmcp::model::CallToolResult>> + Send + Unpin>,
    pub notification_stream: Option<Box<dyn Stream<Item = ServerNotification> + Send + Unpin>>,
    pub action_required_stream: Option<Box<dyn Stream<Item = Message> + Send + Unpin>>,
}

impl From<ToolResult<rmcp::model::CallToolResult>> for ToolCallResult {
    fn from(result: ToolResult<rmcp::model::CallToolResult>) -> Self {
        Self {
            result: Box::new(futures::future::ready(result)),
            notification_stream: None,
            action_required_stream: None,
        }
    }
}

use crate::agents::Agent;
use crate::conversation::message::ToolRequest;
use crate::session::Session;
use crate::tool_inspection::get_security_finding_id_from_results;

pub(super) enum ToolStreamItem<T> {
    ActionRequired(Message),
    Message(ServerNotification),
    Result(T),
}

pub(super) type ToolStream =
    Pin<Box<dyn Stream<Item = ToolStreamItem<ToolResult<CallToolResult>>> + Send>>;

pub(super) fn tool_stream<S, A, F>(rx: S, action_required_rx: A, done: F) -> ToolStream
where
    S: Stream<Item = ServerNotification> + Send + Unpin + 'static,
    A: Stream<Item = Message> + Send + Unpin + 'static,
    F: Future<Output = ToolResult<CallToolResult>> + Send + 'static,
{
    Box::pin(async_stream::stream! {
        tokio::pin!(done);
        let mut rx = rx;
        let mut action_required_rx = action_required_rx;

        loop {
            tokio::select! {
                Some(msg) = action_required_rx.next() => {
                    yield ToolStreamItem::ActionRequired(msg);
                }
                Some(msg) = rx.next() => {
                    yield ToolStreamItem::Message(msg);
                }
                r = &mut done => {
                    yield ToolStreamItem::Result(r);
                    break;
                }
            }
        }
    })
}

pub const DECLINED_RESPONSE: &str = "The user has declined to run this tool. \
    DO NOT attempt to call this tool again. \
    If there are no alternative methods to proceed, clearly explain the situation and STOP.";

/// Tool result of a call whose approver rejected it (ModelForge requirement 15.5).
pub const DECLINED_REJECTED_RESPONSE: &str = "已拒绝：审批人拒绝了这次工具调用，工具没有执行。\
    DO NOT attempt to call this tool again. \
    If there are no alternative methods to proceed, clearly explain the situation and STOP.";

/// Tool result of a call that nobody approved before the client's deadline (requirement 15.5).
pub const DECLINED_TIMEOUT_RESPONSE: &str = "已超时：审批在时限内没有得到批准，工具没有执行。\
    DO NOT attempt to call this tool again. \
    If there are no alternative methods to proceed, clearly explain the situation and STOP.";

/// Why a client denied a tool call, when it said so in its permission response. A denial
/// without a recorded reason keeps [`DECLINED_RESPONSE`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolDenialReason {
    /// The approver explicitly rejected the call.
    Rejected,
    /// No approval arrived before the client's deadline.
    TimedOut,
}

impl ToolDenialReason {
    /// Parses the wire value a client sends: `"rejected"` or `"timeout"`.
    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "rejected" => Some(Self::Rejected),
            "timeout" => Some(Self::TimedOut),
            _ => None,
        }
    }

    /// The tool result recorded for the denied call.
    pub fn tool_result_text(self) -> &'static str {
        match self {
            Self::Rejected => DECLINED_REJECTED_RESPONSE,
            Self::TimedOut => DECLINED_TIMEOUT_RESPONSE,
        }
    }
}

/// A declined result is written right after the answer arrives, so an older reason belongs to a
/// call that was never declined (a cancelled turn, for example) and is dropped.
const TOOL_DENIAL_REASON_TTL: Duration = Duration::from_secs(10 * 60);
/// Upper bound on remembered reasons, so abandoned entries cannot pile up.
const TOOL_DENIAL_REASON_CAPACITY: usize = 256;

struct RecordedToolDenial {
    session_id: String,
    request_id: String,
    reason: ToolDenialReason,
    recorded_at: Instant,
}

/// Denial reasons by session and tool request. The permission response that carries the reason
/// reaches the agent as a bare `Permission`, so the reason waits here until the declined tool
/// result is written, on the live path or on the state machine's.
static TOOL_DENIAL_REASONS: std::sync::Mutex<VecDeque<RecordedToolDenial>> =
    std::sync::Mutex::new(VecDeque::new());

fn tool_denial_reasons() -> std::sync::MutexGuard<'static, VecDeque<RecordedToolDenial>> {
    let mut reasons = TOOL_DENIAL_REASONS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    reasons.retain(|entry| entry.recorded_at.elapsed() < TOOL_DENIAL_REASON_TTL);
    reasons
}

/// Remembers why the client denied `request_id` in `session_id`. Call it before the denial is
/// submitted to the agent, so the declined tool result can carry the reason.
pub fn record_tool_denial_reason(session_id: &str, request_id: &str, reason: ToolDenialReason) {
    let mut reasons = tool_denial_reasons();
    reasons.retain(|entry| entry.session_id != session_id || entry.request_id != request_id);
    while reasons.len() >= TOOL_DENIAL_REASON_CAPACITY {
        reasons.pop_front();
    }
    reasons.push_back(RecordedToolDenial {
        session_id: session_id.to_string(),
        request_id: request_id.to_string(),
        reason,
        recorded_at: Instant::now(),
    });
}

/// The tool result of a declined call: the text of the reason recorded for it, which is used
/// once, or [`DECLINED_RESPONSE`] when the client gave none.
pub(crate) fn declined_response(session_id: &str, request_id: &str) -> String {
    let mut reasons = tool_denial_reasons();
    let position = reasons
        .iter()
        .position(|entry| entry.session_id == session_id && entry.request_id == request_id);
    let recorded = position.and_then(|index| reasons.remove(index));
    match recorded {
        Some(entry) => entry.reason.tool_result_text().to_string(),
        None => DECLINED_RESPONSE.to_string(),
    }
}

pub const CHAT_MODE_TOOL_SKIPPED_RESPONSE: &str = "Let the user know the tool call was skipped in goose chat mode. \
                                        DO NOT apologize for skipping the tool call. DO NOT say sorry. \
                                        Provide an explanation of what the tool call would do, structured as a \
                                        plan for the user. Again, DO NOT apologize. \
                                        **Example Plan:**\n \
                                        1. **Identify Task Scope** - Determine the purpose and expected outcome.\n \
                                        2. **Outline Steps** - Break down the steps.\n \
                                        If needed, adjust the explanation based on user preferences or questions.";

impl Agent {
    pub(super) fn handle_approval_tool_requests<'a>(
        &'a self,
        tool_requests: &'a [ToolRequest],
        tool_futures: &'a mut Vec<(String, ToolStream)>,
        request_to_response_map: &'a mut HashMap<String, Message>,
        cancellation_token: Option<CancellationToken>,
        session: &'a Session,
        inspection_results: &'a [crate::tool_inspection::InspectionResult],
    ) -> BoxStream<'a, anyhow::Result<Message>> {
        try_stream! {
        for request in tool_requests.iter() {
            if let Ok(tool_call) = request.tool_call.clone() {
                let security_message = inspection_results.iter()
                    .find(|result| result.tool_request_id == request.id)
                    .and_then(|result| {
                        if let crate::tool_inspection::InspectionAction::RequireApproval(Some(message)) = &result.action {
                            Some(message.clone())
                        } else {
                            None
                        }
                    });

                let confirmation_rx = self
                    .tool_confirmation_router
                    .register(session.id.clone(), request.id.clone())
                    .await;

                let action_required_msg = Message::assistant()
                    .with_action_required(
                        request.id.clone(),
                        tool_call.name.to_string().clone(),
                        tool_call.arguments.clone().unwrap_or_default(),
                        security_message,
                    )
                    .user_only();
                yield action_required_msg;

                let confirmation = confirmation_rx.await
                    .map_err(|_| anyhow::anyhow!("Confirmation channel closed for request {}", request.id))?;

                if let Some(finding_id) = get_security_finding_id_from_results(&request.id, inspection_results) {
                    let action = match confirmation.permission {
                        Permission::AllowOnce | Permission::AlwaysAllow => "ALLOW",
                        _ => "BLOCK",
                    };
                    tracing::info!(
                        monotonic_counter.goose.prompt_injection_user_decisions = 1,
                        security.event_type = "user_decision",
                        security.action = action,
                        security.finding_id = %finding_id,
                        tool.request_id = %request.id,
                        user.decision = ?confirmation.permission,
                        "security finding: user decision"
                    );
                }

                if confirmation.permission == Permission::AllowOnce || confirmation.permission == Permission::AlwaysAllow {
                    let (req_id, tool_result) = self.dispatch_tool_call(tool_call.clone(), request.id.clone(), cancellation_token.clone(), session).await;

                    tool_futures.push((req_id, match tool_result {
                        Ok(result) => tool_stream(
                            result.notification_stream.unwrap_or_else(|| Box::new(stream::empty())),
                            result.action_required_stream.unwrap_or_else(|| Box::new(stream::empty())),
                            result.result,
                        ),
                        Err(e) => tool_stream(
                            Box::new(stream::empty()),
                            Box::new(stream::empty()),
                            futures::future::ready(Err(e)),
                        ),
                    }));

                    if confirmation.permission == Permission::AlwaysAllow {
                        self.tool_inspection_manager
                            .update_permission_manager(&tool_call.name, PermissionLevel::AlwaysAllow)
                            .await;
                    }
                } else {
                    if let Some(response) = request_to_response_map.get_mut(&request.id) {
                        response.add_tool_response_with_metadata(
                            request.id.clone(),
                            Ok(CallToolResult::error(vec![ContentBlock::text(
                                declined_response(&session.id, &request.id),
                            )])),
                            request.metadata.as_ref(),
                        );
                    }

                    if confirmation.permission == Permission::AlwaysDeny {
                        self.tool_inspection_manager
                            .update_permission_manager(&tool_call.name, PermissionLevel::NeverAllow)
                            .await;
                    }
                }
            }
        }
    }.boxed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The registry is process-wide and tests run in parallel, so every test uses its own
    // session ids.

    #[test]
    fn a_denial_without_a_reason_keeps_the_default_text() {
        assert_eq!(
            declined_response("denial-default", "request-1"),
            DECLINED_RESPONSE
        );
    }

    #[test]
    fn a_recorded_reason_becomes_the_result_once() {
        record_tool_denial_reason("denial-once", "request-1", ToolDenialReason::TimedOut);

        assert_eq!(
            declined_response("denial-once", "request-1"),
            DECLINED_TIMEOUT_RESPONSE
        );
        assert_eq!(
            declined_response("denial-once", "request-1"),
            DECLINED_RESPONSE
        );
    }

    #[test]
    fn reasons_belong_to_one_session_and_request() {
        record_tool_denial_reason("denial-scope-a", "request-1", ToolDenialReason::Rejected);

        assert_eq!(
            declined_response("denial-scope-b", "request-1"),
            DECLINED_RESPONSE
        );
        assert_eq!(
            declined_response("denial-scope-a", "request-2"),
            DECLINED_RESPONSE
        );
        assert_eq!(
            declined_response("denial-scope-a", "request-1"),
            DECLINED_REJECTED_RESPONSE
        );
    }

    #[test]
    fn a_later_reason_replaces_an_earlier_one() {
        record_tool_denial_reason("denial-replace", "request-1", ToolDenialReason::Rejected);
        record_tool_denial_reason("denial-replace", "request-1", ToolDenialReason::TimedOut);

        assert_eq!(
            declined_response("denial-replace", "request-1"),
            DECLINED_TIMEOUT_RESPONSE
        );
        assert_eq!(
            declined_response("denial-replace", "request-1"),
            DECLINED_RESPONSE
        );
    }

    #[test]
    fn wire_values_and_result_texts() {
        assert_eq!(
            ToolDenialReason::from_wire("rejected"),
            Some(ToolDenialReason::Rejected)
        );
        assert_eq!(
            ToolDenialReason::from_wire("timeout"),
            Some(ToolDenialReason::TimedOut)
        );
        assert_eq!(ToolDenialReason::from_wire("expired"), None);
        assert_eq!(ToolDenialReason::from_wire(""), None);
        assert!(ToolDenialReason::Rejected
            .tool_result_text()
            .starts_with("已拒绝"));
        assert!(ToolDenialReason::TimedOut
            .tool_result_text()
            .starts_with("已超时"));
    }
}
