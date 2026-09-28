//! 在两条执行路径上运行同一个对照用例并采集轨迹（需求 4.2、4.6）。
//!
//! 每条路径使用全新的临时目录、会话存储与 `ScriptedProvider`，运行时持有 `env_lock`
//! 把 `GOOSE_STATE_MACHINE` 固定为该路径的取值；运行包在 60 秒超时与 `catch_unwind` 里，
//! 出错、panic 或超时都记为该路径的失败，不影响其余用例。

use std::any::Any;
use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use futures::{FutureExt, StreamExt};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::super::calculator_extension::CalculatorExtension;
use super::model::{
    ExecPath, FailureKind, HookSpec, ParityCase, PathFailure, PathResult, Trace, Turn,
};
use super::provider::{ScriptedProvider, MODEL_NAME};
use crate::agents::extension::ExtensionConfig;
use crate::agents::mcp_client::McpClientTrait;
use crate::agents::{Agent, AgentConfig, AgentEvent, GoosePlatform, SessionConfig};
use crate::config::permission::PermissionManager;
use crate::conversation::message::{ActionRequiredData, MessageContent};
use crate::hooks::HookManager;
use crate::permission::Permission;
use crate::plugins::discovery::{DiscoveredPlugin, PluginScope};
use crate::providers::base::Provider;
use crate::session::{SessionManager, SessionType};
use goose_providers::model::ModelConfig;

pub(super) const STATE_MACHINE_ENV: &str = "GOOSE_STATE_MACHINE";
/// 两条路径共同固定的配置（环境变量优先于配置文件）：跳过可重试错误的退避等待；
/// 关闭工具对摘要，它会在后台并发调用 provider，打乱脚本的消费顺序；
/// 固定上下文上限与自动压缩阈值，不受运行环境与用户配置影响。
const PINNED_ENV: [(&str, &str); 4] = [
    ("GOOSE_PROVIDER_SKIP_BACKOFF", "true"),
    ("GOOSE_TOOL_PAIR_SUMMARIZATION", "false"),
    ("GOOSE_CONTEXT_LIMIT", "128000"),
    ("GOOSE_AUTO_COMPACT_THRESHOLD", "0.8"),
];
/// 单条路径的运行时限（需求 4.6）。
pub(super) const PATH_TIMEOUT: Duration = Duration::from_secs(60);
/// 轨迹中临时目录路径的替换值：两条路径的临时目录不同，但不属于行为差异。
pub(super) const TEMP_ROOT: &str = "<tmp>";

const MESSAGE_ROWS: &str = "SELECT message_id, role, content_json, metadata_json, \
    created_timestamp FROM messages WHERE session_id = ? ORDER BY id";
const USAGE_ROWS: &str = "SELECT model, input_tokens, output_tokens, total_tokens, cost, \
    is_compaction, created_timestamp FROM usage_ledger WHERE session_id = ? ORDER BY id";

type MessageRow = (Option<String>, String, String, Option<String>, i64);
type UsageRow = (
    Option<String>,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    Option<f64>,
    Option<i64>,
    i64,
);

/// 同一用例在两条路径上各运行 1 次，先 legacy 后状态机。
pub(super) async fn run_both(case: &ParityCase) -> (PathResult, PathResult) {
    let legacy = run_path(case, ExecPath::Legacy).await;
    let state_machine = run_path(case, ExecPath::StateMachine).await;
    (legacy, state_machine)
}

/// 固定 `GOOSE_STATE_MACHINE` 后运行一条路径，把错误、panic 与超时转成 `PathFailure`。
pub(super) async fn run_path(case: &ParityCase, path: ExecPath) -> PathResult {
    let mut env = vec![(STATE_MACHINE_ENV, path.state_machine_flag())];
    for (name, value) in PINNED_ENV {
        env.push((name, Some(value)));
    }
    let _env = env_lock::lock_env(env);
    let run = AssertUnwindSafe(execute(case)).catch_unwind();
    let Ok(finished) = tokio::time::timeout(PATH_TIMEOUT, run).await else {
        let reason = format!("{path:?} path exceeded {PATH_TIMEOUT:?}");
        return Err(PathFailure::new(FailureKind::Timeout, reason));
    };
    match finished {
        Ok(Ok(trace)) => Ok(trace),
        Ok(Err(error)) => {
            let reason = format!("{error:#}");
            Err(PathFailure::new(FailureKind::Error, reason))
        }
        Err(payload) => {
            let reason = panic_reason(payload.as_ref());
            Err(PathFailure::new(FailureKind::Panic, reason))
        }
    }
}

fn panic_reason(payload: &(dyn Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        return (*text).to_string();
    }
    if let Some(text) = payload.downcast_ref::<String>() {
        return text.clone();
    }
    "panic with a non-string payload".to_string()
}

async fn execute(case: &ParityCase) -> Result<Trace> {
    let temp_dir = tempfile::tempdir()?;
    let root = temp_dir.path();
    let cancel = CancellationToken::new();
    let mode = case.input.mode;
    let sessions = Arc::new(SessionManager::new(root.join("data")));
    let permissions = Arc::new(PermissionManager::new(root.join("permissions")));
    let config = AgentConfig::new(
        sessions.clone(),
        permissions,
        None,
        mode,
        true,
        GoosePlatform::GooseCli,
    );
    let mut agent = Agent::with_config(config);
    if let Some(hook) = case.input.hook {
        agent.set_hook_manager_for_test(install_hook(root, hook)?);
    }

    let working_dir = root.join("work");
    std::fs::create_dir_all(&working_dir)?;
    let name = "parity".to_string();
    let session = sessions
        .create_session(working_dir, name, SessionType::Hidden, mode)
        .await?;
    let id = session.id.as_str();
    let script = case.input.script.clone();
    let provider = ScriptedProvider::new(script, cancel.clone());
    let provider: Arc<dyn Provider> = Arc::new(provider);
    let model = ModelConfig::new(MODEL_NAME);
    agent.update_provider(provider, model, id).await?;
    agent.update_goose_mode(mode, id).await?;
    if case.input.calculator {
        add_calculator(&agent).await;
    }
    for message in &case.initial_session {
        sessions.add_message(id, message).await?;
    }

    let mut events = Vec::new();
    for turn in &case.input.turns {
        let max_turns = case.input.max_turns;
        let turn_events = run_turn(&agent, id, turn, max_turns, &cancel).await?;
        events.extend(turn_events);
    }
    let persistence = read_persistence(&sessions, id).await?;
    let mut trace = Trace {
        events,
        persistence,
    };
    scrub_trace(&mut trace, &root.to_string_lossy());
    Ok(trace)
}

/// 提交一个用户轮次并收集全部事件；遇到工具确认请求时按轮次设定作答（未设定即拒绝）。
async fn run_turn(
    agent: &Agent,
    id: &str,
    turn: &Turn,
    max_turns: u32,
    cancel: &CancellationToken,
) -> Result<Vec<Value>> {
    let session_config = SessionConfig {
        id: id.to_string(),
        schedule_id: turn.schedule_id.clone(),
        max_turns: Some(max_turns),
        retry_config: None,
    };
    let message = turn.message.clone();
    let token = Some(cancel.clone());
    let mut stream = agent.reply(message, session_config, token).await?;
    let mut events = Vec::new();
    while let Some(event) = stream.next().await {
        let event = event?;
        let confirmations = confirmation_requests(&event);
        events.push(event_json(&event));
        for confirmation_id in confirmations {
            let decision = turn.confirmation.clone();
            let permission = decision.unwrap_or(Permission::DenyOnce);
            agent
                .submit_tool_confirmation(id, &confirmation_id, permission)
                .await?;
        }
    }
    Ok(events)
}

pub(super) fn event_json(event: &AgentEvent) -> Value {
    match event {
        AgentEvent::Message(message) => json!({ "type": "message", "message": message }),
        AgentEvent::Usage(usage) => json!({ "type": "usage", "usage": usage }),
        AgentEvent::MessageUsage { message_id, usage } => json!({
            "type": "message_usage",
            "message_id": message_id,
            "usage": usage
        }),
        AgentEvent::McpNotification((extension, notification)) => json!({
            "type": "mcp_notification",
            "extension": extension,
            "notification": notification
        }),
        AgentEvent::HistoryReplaced(conversation) => json!({
            "type": "history_replaced",
            "conversation": conversation
        }),
    }
}

fn confirmation_requests(event: &AgentEvent) -> Vec<String> {
    let AgentEvent::Message(message) = event else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    for content in &message.content {
        let MessageContent::ActionRequired(action) = content else {
            continue;
        };
        if let ActionRequiredData::ToolConfirmation { id, .. } = &action.data {
            ids.push(id.clone());
        }
    }
    ids
}

async fn add_calculator(agent: &Agent) {
    let action_required = agent.config.session_manager.action_required();
    let calculator = Arc::new(CalculatorExtension::new(action_required));
    let config = ExtensionConfig::Platform {
        name: "calculator".to_string(),
        description: "Stateful test calculator".to_string(),
        display_name: None,
        bundled: None,
        available_tools: vec![],
    };
    let info = calculator.get_info().cloned();
    agent
        .extension_manager
        .add_client("calculator".to_string(), config, calculator, info)
        .await;
}

/// 把 hook 装进临时插件目录：`hooks/hooks.json` 登记事件，命令用 `sh` 执行 `hook.sh`。
fn install_hook(root: &Path, hook: HookSpec) -> Result<HookManager> {
    let plugin_dir = root.join("parity-plugin");
    std::fs::create_dir_all(plugin_dir.join("hooks"))?;
    let command = json!({ "type": "command", "command": "sh ${PLUGIN_ROOT}/hook.sh" });
    let mut events = serde_json::Map::new();
    events.insert(hook.event.to_string(), json!([{ "hooks": [command] }]));
    let config = json!({ "hooks": events });
    std::fs::write(plugin_dir.join("hooks/hooks.json"), config.to_string())?;
    std::fs::write(plugin_dir.join("hook.sh"), hook.script)?;
    let plugin = DiscoveredPlugin {
        name: "parity-plugin".into(),
        root: plugin_dir,
        scope: PluginScope::Project,
    };
    Ok(HookManager::from_plugins_for_test(vec![plugin]))
}

/// 读出会话存储的写入序列：消息表按自增行 ID（即写入顺序），然后是用量流水，最后是会话记录。
async fn read_persistence(sessions: &SessionManager, id: &str) -> Result<Vec<Value>> {
    let pool = sessions.storage().pool().await?;
    let messages = sqlx::query_as::<_, MessageRow>(MESSAGE_ROWS)
        .bind(id)
        .fetch_all(pool)
        .await?;
    let usage = sqlx::query_as::<_, UsageRow>(USAGE_ROWS)
        .bind(id)
        .fetch_all(pool)
        .await?;

    let mut writes = Vec::with_capacity(messages.len() + usage.len() + 1);
    for (message_id, role, content, metadata, created) in messages {
        let metadata = metadata.as_deref().map(parse_json);
        writes.push(json!({
            "table": "messages",
            "message_id": message_id,
            "role": role,
            "content": parse_json(&content),
            "metadata": metadata,
            "created_timestamp": created
        }));
    }
    for (model, input, output, total, cost, compaction, created) in usage {
        writes.push(json!({
            "table": "usage_ledger",
            "model": model,
            "input_tokens": input,
            "output_tokens": output,
            "total_tokens": total,
            "cost": cost,
            "is_compaction": compaction,
            "created_timestamp": created
        }));
    }

    let session = sessions.get_session(id, false).await?;
    let mut record = serde_json::to_value(&session)?;
    if let Some(fields) = record.as_object_mut() {
        fields.remove("working_dir");
        fields.remove("conversation");
    }
    writes.push(json!({ "table": "sessions", "row": record }));
    Ok(writes)
}

fn parse_json(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.to_string()))
}

fn scrub_trace(trace: &mut Trace, root: &str) {
    for value in &mut trace.events {
        scrub_path(value, root);
    }
    for value in &mut trace.persistence {
        scrub_path(value, root);
    }
}

/// 把字符串里的临时目录路径替换为 `TEMP_ROOT`。
pub(super) fn scrub_path(value: &mut Value, root: &str) {
    match value {
        Value::String(text) => {
            if text.contains(root) {
                *text = text.replace(root, TEMP_ROOT);
            }
        }
        Value::Array(items) => {
            for item in items {
                scrub_path(item, root);
            }
        }
        Value::Object(fields) => {
            for item in fields.values_mut() {
                scrub_path(item, root);
            }
        }
        _ => {}
    }
}
