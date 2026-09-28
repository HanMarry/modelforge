//! 对照测试的数据模型：用例、维度、执行路径、轨迹与单路径失败（需求 4.2、4.3、4.6）。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::provider::ScriptStep;
use crate::config::GooseMode;
use crate::conversation::message::Message;
use crate::permission::Permission;

/// 需求 4.3 规定的 10 个对照维度。
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Dimension {
    MessageVisibility,
    Hook,
    ToolApproval,
    Cancellation,
    Retry,
    ContextCompaction,
    SessionResume,
    SlashCommand,
    PersistenceOrder,
    ScheduleContext,
}

impl Dimension {
    pub(super) const ALL: [Self; 10] = [
        Self::MessageVisibility,
        Self::Hook,
        Self::ToolApproval,
        Self::Cancellation,
        Self::Retry,
        Self::ContextCompaction,
        Self::SessionResume,
        Self::SlashCommand,
        Self::PersistenceOrder,
        Self::ScheduleContext,
    ];
}

/// 执行路径。legacy 是默认路径，即不设置 `GOOSE_STATE_MACHINE`。
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub(super) enum ExecPath {
    #[serde(rename = "legacy")]
    Legacy,
    #[serde(rename = "sm")]
    StateMachine,
}

impl ExecPath {
    /// 运行该路径时 `GOOSE_STATE_MACHINE` 的取值，`None` 表示删除该变量。
    pub(super) fn state_machine_flag(self) -> Option<&'static str> {
        match self {
            Self::Legacy => None,
            Self::StateMachine => Some("1"),
        }
    }
}

/// 单路径失败的原因（需求 4.6）。
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum FailureKind {
    Error,
    Panic,
    Timeout,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct PathFailure {
    pub(super) kind: FailureKind,
    pub(super) reason: String,
}

impl PathFailure {
    pub(super) fn new(kind: FailureKind, reason: impl Into<String>) -> Self {
        Self {
            kind,
            reason: reason.into(),
        }
    }
}

/// 一条路径的运行轨迹：`events` 是 `Agent::reply` 流出的事件序列，
/// `persistence` 是会话存储里的写入序列（消息按行 ID 即写入顺序，其后是用量记录与会话记录）。
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Trace {
    pub(super) events: Vec<Value>,
    pub(super) persistence: Vec<Value>,
}

/// 单条路径的运行结果：成功时是轨迹，出错、panic 或超时时是失败原因。
pub(super) type PathResult = Result<Trace, PathFailure>;

/// 一个对照用例：两条路径使用同一输入、同一初始会话与同一 provider 脚本（需求 4.2）。
#[derive(Clone, Debug)]
pub(super) struct ParityCase {
    pub(super) name: &'static str,
    pub(super) dimension: Dimension,
    pub(super) input: CaseInput,
    /// 运行前按顺序写入会话存储的消息。
    pub(super) initial_session: Vec<Message>,
}

#[derive(Clone, Debug)]
pub(super) struct CaseInput {
    /// 依次提交给 `Agent::reply` 的用户轮次。
    pub(super) turns: Vec<Turn>,
    /// `ScriptedProvider` 按顺序返回的响应。
    pub(super) script: Vec<ScriptStep>,
    pub(super) mode: GooseMode,
    /// 是否挂载测试用的 calculator 扩展。
    pub(super) calculator: bool,
    pub(super) hook: Option<HookSpec>,
    pub(super) max_turns: u32,
}

#[derive(Clone, Debug)]
pub(super) struct Turn {
    pub(super) message: Message,
    pub(super) schedule_id: Option<String>,
    /// 收到工具确认请求时提交的决定；未设置时按拒绝处理。
    pub(super) confirmation: Option<Permission>,
}

/// 安装到临时插件目录的 hook：`event` 是 hook 事件名，`script` 是 `sh` 脚本内容。
#[derive(Clone, Copy, Debug)]
pub(super) struct HookSpec {
    pub(super) event: &'static str,
    pub(super) script: &'static str,
}
