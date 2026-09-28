//! 对照测试用的 provider stub：按固定顺序返回固定响应，不持有任何网络客户端（需求 4.2）。

use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use futures::stream;
use rmcp::model::{CallToolRequestParams, Tool};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::conversation::message::Message;
use crate::providers::base::{
    stream_from_single_message, MessageStream, Provider, ProviderUsage, Usage,
};
use goose_providers::errors::ProviderError;
use goose_providers::model::ModelConfig;

pub(super) const PROVIDER_NAME: &str = "scripted";
pub(super) const MODEL_NAME: &str = "mock-model";

type StreamItem = Result<(Option<Message>, Option<ProviderUsage>), ProviderError>;

/// `ScriptedProvider` 的一次响应。
#[derive(Clone, Debug)]
pub(super) enum ScriptStep {
    /// 一条完整的文本回复。
    Text(&'static str),
    /// 分块流式返回的文本，各块共享同一个消息 ID。
    Chunks(Vec<&'static str>),
    /// 原样流式返回的消息，不补消息 ID。
    Messages(Vec<Message>),
    /// 一次工具调用。
    ToolCall {
        id: &'static str,
        name: &'static str,
        arguments: Value,
    },
    /// 没有任何内容的助手消息。
    Empty,
    /// 请求直接失败：上下文超限。
    ContextLimit,
    /// 流的第一项是可重试的服务端错误。
    ServerError,
    /// 返回第一块后触发取消令牌，再返回剩余的块。
    CancelMidStream(Vec<&'static str>),
}

/// 按脚本顺序响应 `stream` 调用；脚本用完后返回错误，任何需要联网的方法都会 panic。
pub(super) struct ScriptedProvider {
    script: Vec<ScriptStep>,
    next: AtomicUsize,
    cancel: CancellationToken,
}

impl ScriptedProvider {
    pub(super) fn new(script: Vec<ScriptStep>, cancel: CancellationToken) -> Self {
        Self {
            script,
            next: AtomicUsize::new(0),
            cancel,
        }
    }

    /// 已经收到的 `stream` 调用次数。
    pub(super) fn calls(&self) -> usize {
        self.next.load(Ordering::SeqCst)
    }

    fn respond(&self, call: usize, step: ScriptStep) -> Result<MessageStream, ProviderError> {
        let id = format!("scripted-{call}");
        let usage = scripted_usage();
        match step {
            ScriptStep::Text(text) => {
                let message = Message::assistant().with_text(text).with_id(id);
                Ok(stream_from_single_message(message, usage))
            }
            ScriptStep::Chunks(chunks) => Ok(chunked(id, chunks, usage, None)),
            ScriptStep::Messages(messages) => Ok(passthrough(messages, usage)),
            ScriptStep::ToolCall {
                id: request_id,
                name,
                arguments,
            } => {
                let arguments = arguments.as_object().cloned().unwrap_or_default();
                let call = CallToolRequestParams::new(name).with_arguments(arguments);
                let message = Message::assistant()
                    .with_tool_request(request_id, Ok(call))
                    .with_id(id);
                Ok(stream_from_single_message(message, usage))
            }
            ScriptStep::Empty => {
                let message = Message::assistant().with_id(id);
                Ok(stream_from_single_message(message, usage))
            }
            ScriptStep::ContextLimit => {
                let details = "scripted context limit".to_string();
                Err(ProviderError::ContextLengthExceeded(details))
            }
            ScriptStep::ServerError => {
                let details = "scripted transient error".to_string();
                let items: [StreamItem; 1] = [Err(ProviderError::ServerError(details))];
                Ok(Box::pin(stream::iter(items)))
            }
            ScriptStep::CancelMidStream(chunks) => {
                let cancel = Some(self.cancel.clone());
                Ok(chunked(id, chunks, usage, cancel))
            }
        }
    }
}

fn scripted_usage() -> ProviderUsage {
    let usage = Usage::new(Some(10), Some(5), Some(15));
    ProviderUsage::new(MODEL_NAME.to_string(), usage)
}

/// 逐块返回文本，最后一块带用量；`cancel` 存在时在交出第二块之前触发取消。
fn chunked(
    id: String,
    chunks: Vec<&'static str>,
    usage: ProviderUsage,
    cancel: Option<CancellationToken>,
) -> MessageStream {
    let last = chunks.len().saturating_sub(1);
    let items = chunks
        .into_iter()
        .enumerate()
        .map(move |(index, chunk)| -> StreamItem {
            if let (1, Some(token)) = (index, &cancel) {
                token.cancel();
            }
            let message = Message::assistant().with_text(chunk).with_id(id.clone());
            let chunk_usage = (index == last).then(|| usage.clone());
            Ok((Some(message), chunk_usage))
        });
    Box::pin(stream::iter(items))
}

fn passthrough(messages: Vec<Message>, usage: ProviderUsage) -> MessageStream {
    let last = messages.len().saturating_sub(1);
    let items = messages
        .into_iter()
        .enumerate()
        .map(move |(index, message)| -> StreamItem {
            let message_usage = (index == last).then(|| usage.clone());
            Ok((Some(message), message_usage))
        });
    Box::pin(stream::iter(items))
}

fn network_forbidden(operation: &str) -> ! {
    panic!("ScriptedProvider must never reach the network (called {operation})")
}

#[async_trait]
impl Provider for ScriptedProvider {
    fn get_name(&self) -> &str {
        PROVIDER_NAME
    }

    async fn stream(
        &self,
        _model_config: &ModelConfig,
        _system: &str,
        _messages: &[Message],
        _tools: &[Tool],
    ) -> Result<MessageStream, ProviderError> {
        let call = self.next.fetch_add(1, Ordering::SeqCst);
        let Some(step) = self.script.get(call).cloned() else {
            let total = self.script.len();
            let details = format!("scripted provider exhausted after {total} responses");
            return Err(ProviderError::ExecutionError(details));
        };
        self.respond(call, step)
    }

    async fn fetch_supported_models(&self) -> Result<Vec<String>, ProviderError> {
        network_forbidden("fetch_supported_models")
    }

    async fn configure_oauth(&self) -> Result<(), ProviderError> {
        network_forbidden("configure_oauth")
    }

    async fn refresh_credentials(&self) -> Result<(), ProviderError> {
        network_forbidden("refresh_credentials")
    }
}

mod tests {
    use futures::StreamExt;
    use serde_json::json;

    use super::*;
    use crate::conversation::message::MessageContent;

    async fn collect(provider: &ScriptedProvider) -> Result<Vec<Message>, ProviderError> {
        let model = ModelConfig::new(MODEL_NAME);
        let mut stream = provider.stream(&model, "", &[], &[]).await?;
        let mut messages = Vec::new();
        while let Some(item) = stream.next().await {
            let (message, _usage) = item?;
            messages.extend(message);
        }
        Ok(messages)
    }

    fn tool_request_ids(message: &Message) -> Vec<String> {
        message
            .content
            .iter()
            .filter_map(|content| match content {
                MessageContent::ToolRequest(request) => Some(request.id.clone()),
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn responds_in_script_order_then_reports_exhaustion() {
        let tool_call = ScriptStep::ToolCall {
            id: "call-1",
            name: "calculator__add",
            arguments: json!({ "value": 1 }),
        };
        let script = vec![ScriptStep::Text("first"), tool_call];
        let provider = ScriptedProvider::new(script, CancellationToken::new());

        let first = collect(&provider).await.expect("first response");
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].as_concat_text(), "first");
        assert_eq!(first[0].id.as_deref(), Some("scripted-0"));

        let second = collect(&provider).await.expect("second response");
        assert_eq!(tool_request_ids(&second[0]), ["call-1"]);

        let exhausted = collect(&provider).await.expect_err("script is exhausted");
        let message = exhausted.to_string();
        assert!(message.contains("exhausted after 2 responses"));
        assert_eq!(provider.calls(), 3);
    }

    #[tokio::test]
    async fn cancel_mid_stream_fires_after_the_first_chunk() {
        let cancel = CancellationToken::new();
        let script = vec![ScriptStep::CancelMidStream(vec!["a ", "b ", "c"])];
        let provider = ScriptedProvider::new(script, cancel.clone());
        let model = ModelConfig::new(MODEL_NAME);
        let mut stream = provider.stream(&model, "", &[], &[]).await.unwrap();

        let (first, _usage) = stream.next().await.expect("first chunk").unwrap();
        assert!(first.is_some());
        assert!(!cancel.is_cancelled());
        let rest: Vec<_> = stream.collect().await;
        assert_eq!(rest.len(), 2);
        assert!(cancel.is_cancelled());
    }

    #[tokio::test]
    async fn failures_are_scripted_errors() {
        let script = vec![ScriptStep::ContextLimit, ScriptStep::ServerError];
        let provider = ScriptedProvider::new(script, CancellationToken::new());

        let context_limit = collect(&provider).await.expect_err("context limit");
        let is_context_limit = matches!(context_limit, ProviderError::ContextLengthExceeded(_));
        assert!(is_context_limit);
        let server_error = collect(&provider).await.expect_err("server error");
        assert!(matches!(server_error, ProviderError::ServerError(_)));
    }

    #[tokio::test]
    #[should_panic(expected = "must never reach the network")]
    async fn network_methods_panic() {
        let provider = ScriptedProvider::new(Vec::new(), CancellationToken::new());
        let _ = provider.fetch_supported_models().await;
    }
}
