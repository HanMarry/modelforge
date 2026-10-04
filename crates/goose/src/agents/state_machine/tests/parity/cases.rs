//! 10 个维度的对照用例（需求 4.3）。
//!
//! 每个用例在两条路径上使用同一输入、同一初始会话与同一 provider 脚本。脚本按预期的
//! 推理次数编写：某条路径多调用一次 provider 时会拿到"脚本已用完"的错误，少调用时
//! 事件与持久化写入会少于另一侧，两种情况都体现为差异项。

use super::super::calculator_extension::{value, ADD};
use super::model::{CaseInput, Dimension, HookSpec, ParityCase, Turn};
use super::provider::ScriptStep;
use crate::config::GooseMode;
use crate::conversation::message::Message;
use crate::permission::Permission;

/// 推理次数上限。状态机在本轮助手消息数达到上限时追加最大轮数提示，
/// 所以上限取得比任何用例预期的推理次数都大。
const MAX_TURNS: u32 = 5;
const CALL_ID: &str = "call-1";
/// 超过自动压缩阈值的上下文用量：harness 固定上下文上限 128000、阈值 0.8，即 102400。
const OVER_THRESHOLD_TOKENS: i32 = 110_000;

/// Stop hook：第一次结束轮次时以退出码 2 拒绝并要求继续，之后放行。
/// 标记文件放在插件目录里，两条路径各自使用独立的临时目录。
const STOP_ONCE_SCRIPT: &str = "#!/bin/sh\n\
if [ -f \"$PLUGIN_ROOT/denied\" ]; then exit 0; fi\n\
touch \"$PLUGIN_ROOT/denied\"\n\
echo \"parity: not done yet\" >&2\n\
exit 2\n";

/// 全部对照用例，每个维度至少 1 个。
pub(super) fn all_cases() -> Vec<ParityCase> {
    vec![
        streamed_chunks(),
        provider_message_without_id(),
        user_only_message(),
        stop_hook_denies_once(),
        approval(
            "approve_allow_once",
            Permission::AllowOnce,
            "The total is 1.",
        ),
        approval(
            "approve_deny_once",
            Permission::DenyOnce,
            "The tool call was denied.",
        ),
        cancel_mid_stream(),
        transient_server_error(),
        empty_reply(),
        context_limit_compaction(),
        auto_compaction_over_threshold(),
        resume_existing_history(),
        second_turn_in_session(),
        clear_command(),
        compact_command(),
        status_command(),
        goal_query_command(),
        prompts_command(),
        unknown_command(),
        auto_tool_call(),
        scheduled_turn(),
    ]
}

fn user_turn(text: &str) -> Turn {
    Turn {
        message: Message::user().with_text(text),
        schedule_id: None,
        confirmation: None,
    }
}

fn case_input(turns: Vec<Turn>, script: Vec<ScriptStep>) -> CaseInput {
    CaseInput {
        turns,
        script,
        mode: GooseMode::Auto,
        calculator: false,
        hook: None,
        max_turns: MAX_TURNS,
    }
}

/// 单轮用例：提交一条用户文本，provider 按 `script` 依次响应。
fn single_turn(
    name: &'static str,
    dimension: Dimension,
    text: &str,
    script: Vec<ScriptStep>,
) -> ParityCase {
    let input = case_input(vec![user_turn(text)], script);
    ParityCase {
        name,
        dimension,
        input,
        initial_session: Vec::new(),
        initial_context_tokens: None,
    }
}

fn add_one() -> ScriptStep {
    ScriptStep::ToolCall {
        id: CALL_ID,
        name: ADD,
        arguments: value(1),
    }
}

/// 运行前已写入会话存储的一问一答。
fn prior_exchange() -> Vec<Message> {
    let question = Message::user()
        .with_text("What is two plus two?")
        .with_id("seed-user");
    let answer = Message::assistant()
        .with_text("Two plus two is four.")
        .with_id("seed-assistant");
    vec![question, answer]
}

/// 消息可见性：分块流式回复，各块共享同一个消息 ID。
fn streamed_chunks() -> ParityCase {
    let script = vec![ScriptStep::Chunks(vec!["Hel", "lo ", "there."])];
    single_turn(
        "streamed_chunks",
        Dimension::MessageVisibility,
        "Say hello.",
        script,
    )
}

/// 消息可见性：provider 返回不带 ID 的消息，由 `Agent::reply` 补上随机 ID。
fn provider_message_without_id() -> ParityCase {
    let message = Message::assistant().with_text("A reply without an id.");
    let script = vec![ScriptStep::Messages(vec![message])];
    single_turn(
        "provider_message_without_id",
        Dimension::MessageVisibility,
        "Reply once.",
        script,
    )
}

/// 消息可见性：只对用户可见的消息不进入推理，脚本为空。
fn user_only_message() -> ParityCase {
    let message = Message::user()
        .with_text("A note kept only for the record.")
        .user_only();
    let turn = Turn {
        message,
        schedule_id: None,
        confirmation: None,
    };
    ParityCase {
        name: "user_only_message",
        dimension: Dimension::MessageVisibility,
        input: case_input(vec![turn], Vec::new()),
        initial_session: Vec::new(),
        initial_context_tokens: None,
    }
}

/// hook：Stop hook 第一次拒绝结束轮次，应再推理一次后结束。
fn stop_hook_denies_once() -> ParityCase {
    let script = vec![
        ScriptStep::Text("First answer."),
        ScriptStep::Text("Second answer."),
    ];
    let mut case = single_turn(
        "stop_hook_denies_once",
        Dimension::Hook,
        "Finish the task.",
        script,
    );
    case.input.hook = Some(HookSpec {
        event: "Stop",
        script: STOP_ONCE_SCRIPT,
    });
    case
}

/// 工具审批：Approve 模式下调用 calculator，收到确认请求后按 `decision` 作答，再推理一次。
fn approval(name: &'static str, decision: Permission, reply: &'static str) -> ParityCase {
    let script = vec![add_one(), ScriptStep::Text(reply)];
    let mut case = single_turn(
        name,
        Dimension::ToolApproval,
        "Add one to the total.",
        script,
    );
    case.input.mode = GooseMode::Approve;
    case.input.calculator = true;
    case.input.turns[0].confirmation = Some(decision);
    case
}

/// 取消：流式返回第一块后触发取消令牌。
fn cancel_mid_stream() -> ParityCase {
    let chunks = vec!["Partial ", "reply ", "never sent."];
    let script = vec![ScriptStep::CancelMidStream(chunks)];
    single_turn(
        "cancel_mid_stream",
        Dimension::Cancellation,
        "Write a long answer.",
        script,
    )
}

/// 重试：流的第一项是可重试的服务端错误，重试后成功。
fn transient_server_error() -> ParityCase {
    let script = vec![ScriptStep::ServerError, ScriptStep::Text("Recovered.")];
    single_turn(
        "transient_server_error",
        Dimension::Retry,
        "Answer after a hiccup.",
        script,
    )
}

/// 重试：模型第一次返回空回复。
fn empty_reply() -> ParityCase {
    let script = vec![ScriptStep::Empty, ScriptStep::Text("Second try.")];
    single_turn("empty_reply", Dimension::Retry, "Answer, please.", script)
}

/// 上下文压缩：provider 报上下文超限，压缩（一次摘要调用）后继续回答。
fn context_limit_compaction() -> ParityCase {
    let script = vec![
        ScriptStep::ContextLimit,
        ScriptStep::Text("Summary: the user asked what two plus two is."),
        ScriptStep::Text("Three plus three is six."),
    ];
    let mut case = single_turn(
        "context_limit_compaction",
        Dimension::ContextCompaction,
        "And three plus three?",
        script,
    );
    case.initial_session = prior_exchange();
    case
}

/// 上下文压缩：会话记录的上下文用量已超过自动压缩阈值（128000 × 0.8），
/// 推理前主动压缩（一次摘要调用），比较提示、`history_replaced` 与“Compaction complete”的先后。
fn auto_compaction_over_threshold() -> ParityCase {
    let script = vec![
        ScriptStep::Text("Summary: the user asked what two plus two is."),
        ScriptStep::Text("Five plus five is ten."),
    ];
    let mut case = single_turn(
        "auto_compaction_over_threshold",
        Dimension::ContextCompaction,
        "And five plus five?",
        script,
    );
    case.initial_session = prior_exchange();
    case.initial_context_tokens = Some(OVER_THRESHOLD_TOKENS);
    case
}

/// 会话恢复：会话存储里已有历史，在其上继续一轮。
fn resume_existing_history() -> ParityCase {
    let script = vec![ScriptStep::Text("Four plus four is eight.")];
    let mut case = single_turn(
        "resume_existing_history",
        Dimension::SessionResume,
        "Thanks. And four plus four?",
        script,
    );
    case.initial_session = prior_exchange();
    case
}

/// 会话恢复：同一会话连续两轮，第二轮在第一轮写入的历史上继续。
fn second_turn_in_session() -> ParityCase {
    let turns = vec![user_turn("Hello."), user_turn("Hello again.")];
    let script = vec![ScriptStep::Text("Hi."), ScriptStep::Text("Hi again.")];
    ParityCase {
        name: "second_turn_in_session",
        dimension: Dimension::SessionResume,
        input: case_input(turns, script),
        initial_session: Vec::new(),
        initial_context_tokens: None,
    }
}

/// slash command：`/clear` 清空已有历史，不调用 provider。
fn clear_command() -> ParityCase {
    let mut case = single_turn(
        "clear_command",
        Dimension::SlashCommand,
        "/clear",
        Vec::new(),
    );
    case.initial_session = prior_exchange();
    case
}

/// slash command：`/compact` 手动压缩已有历史（一次摘要调用），比较命令回显、
/// “Compaction complete”与 `history_replaced` 的内容和先后。
fn compact_command() -> ParityCase {
    let script = vec![ScriptStep::Text(
        "Summary: the user asked what two plus two is.",
    )];
    let mut case = single_turn(
        "compact_command",
        Dimension::SlashCommand,
        "/compact",
        script,
    );
    case.initial_session = prior_exchange();
    case
}

/// slash command：`/status` 只回报会话状态（仅用户可见），不调用 provider。
fn status_command() -> ParityCase {
    single_turn(
        "status_command",
        Dimension::SlashCommand,
        "/status",
        Vec::new(),
    )
}

/// slash command：不带参数的 `/goal` 查询当前目标，不调用 provider。
fn goal_query_command() -> ParityCase {
    single_turn(
        "goal_query_command",
        Dimension::SlashCommand,
        "/goal",
        Vec::new(),
    )
}

/// slash command：`/prompts` 列出扩展提供的 prompt（本用例没有扩展），不调用 provider。
fn prompts_command() -> ParityCase {
    single_turn(
        "prompts_command",
        Dimension::SlashCommand,
        "/prompts",
        Vec::new(),
    )
}

/// slash command：未知命令按普通消息交给模型。
fn unknown_command() -> ParityCase {
    let script = vec![ScriptStep::Text("That is not a command I know.")];
    single_turn(
        "unknown_command",
        Dimension::SlashCommand,
        "/not-a-command",
        script,
    )
}

/// 持久化顺序：Auto 模式下直接执行工具，比较用户消息、工具请求、工具结果与回复的写入顺序。
fn auto_tool_call() -> ParityCase {
    let script = vec![add_one(), ScriptStep::Text("The total is 1.")];
    let mut case = single_turn(
        "auto_tool_call",
        Dimension::PersistenceOrder,
        "Add one to the total.",
        script,
    );
    case.input.calculator = true;
    case
}

/// 调度上下文：带 `schedule_id` 的轮次，比较会话记录与用量流水里的调度信息。
fn scheduled_turn() -> ParityCase {
    let script = vec![ScriptStep::Text("The scheduled report is ready.")];
    let mut case = single_turn(
        "scheduled_turn",
        Dimension::ScheduleContext,
        "Run the scheduled report.",
        script,
    );
    case.input.turns[0].schedule_id = Some("parity-schedule".to_string());
    case
}
