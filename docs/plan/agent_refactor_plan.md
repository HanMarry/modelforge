# agent.rs 重构方案

## 当前状态分析

- **文件规模**: 6229 行
- **核心结构**: Agent 结构体 (284行定义) + AgentConfig (216行定义)
- **函数总量**: ~200+ 函数（包括测试函数）
- **主要问题**: 
  - 单文件过大，维护困难
  - 功能耦合严重（工具执行、Hook系统、消息管理、重试逻辑混杂）
  - 测试代码与核心代码混合（~2000行测试代码）

## 模块拆分设计

### 1. agent_core.rs (~800行)
**职责**: Agent 核心结构、初始化、配置管理

**公开接口**:
```rust
pub struct Agent {
    pub(super) provider: SharedProvider,
    pub config: AgentConfig,
    pub(super) current_goose_mode: Mutex<GooseMode>,
    pub extension_manager: Arc<ExtensionManager>,
    // ... 其他字段保持不变
}

pub struct AgentConfig {
    pub session_manager: Arc<SessionManager>,
    pub permission_manager: Arc<PermissionManager>,
    // ... 配置字段
}

impl Agent {
    pub fn new() -> Self;
    pub async fn update_provider(...) -> Result<()>;
    pub async fn update_goose_mode(...) -> Result<()>;
    pub async fn recreate_provider_for_session(...) -> Result<()>;
    pub async fn restore_provider_from_session(...) -> Result<bool>;
    pub async fn set_goal(...);
    pub async fn get_goal() -> Option<String>;
    pub async fn set_grind(...);
    pub async fn get_grind() -> Option<String>;
}
```

**包含函数** (~15个核心函数):
- new()
- update_provider()
- update_goose_mode() 
- goose_mode()
- recreate_provider_for_session()
- restore_provider_from_session()
- update_thinking_effort()
- set_goal() / get_goal()
- set_grind() / get_grind()
- provider() (内部辅助函数)

---

### 2. agent_tools.rs (~1200行)
**职责**: 工具执行、调度、确认、检查

**公开接口**:
```rust
pub struct ToolExecutor {
    confirmation_router: ToolConfirmationRouter,
    confirmation_coordinator: ToolConfirmationCoordinator,
    inspection_manager: ToolInspectionManager,
}

impl Agent {
    pub async fn dispatch_tool_call(...) -> Result<ToolCallResult>;
    pub async fn submit_tool_confirmation(...) -> Result<()>;
    pub async fn list_tools(...) -> Vec<Tool>;
    pub async fn supports_action_required_permissions() -> bool;
}
```

**包含函数** (~20个):
- dispatch_tool_call()
- handle_approved_and_denied_tools()
- submit_tool_confirmation()
- try_route_tool_confirmation_to_provider()
- supports_action_required_permissions()
- list_tools()
- categorize_tool() (辅助函数)
- extract_string_arg() (辅助函数)

**依赖关系**:
- 依赖 agent_core::Agent (读取配置)
- 依赖 agent_hooks (emit_pre_tool_use_result)
- 被 agent_messages 调用 (工具执行后保存消息)

---

### 3. agent_hooks.rs (~600行)
**职责**: Hook 系统的触发、协调、结果处理

**公开接口**:
```rust
impl Agent {
    pub async fn emit_hook(...) -> Result<()>;
    pub async fn emit_hook_with_banners(...) -> Result<()>;
    pub(crate) async fn emit_pre_tool_use_result(...) -> PreToolUseResult;
}
```

**包含函数** (~8个):
- emit_hook()
- emit_hook_with_banners()
- emit_with_matcher() (内部)
- emit_pre_tool_use_result()
- stop_hook_block_cap() (配置读取)
- session_start_hook_emitted() (状态检查)

**依赖关系**:
- 依赖 agent_core::Agent
- 被 agent_tools 调用 (工具执行前检查)
- 被 agent_messages 调用 (stop hook)

---

### 4. agent_messages.rs (~1000行)
**职责**: 消息处理、持久化、对话管理

**公开接口**:
```rust
impl Agent {
    pub async fn push_message_with_id(...) -> Result<()>;
    pub async fn persist_message_with_id(...) -> Result<()>;
    pub(crate) fn attach_turn_usage(...) -> Option<UsageEvent>;
    pub(crate) fn ensure_message_event_id(...);
}
```

**包含函数** (~12个):
- push_message_with_id()
- persist_message_with_id()
- attach_turn_usage()
- ensure_message_event_id()
- agent_visible_message_text()
- user_event_projection()
- tool_confirmation_request_ids() (辅助)

**依赖关系**:
- 依赖 agent_core::Agent
- 依赖 agent_tools (工具结果消息)
- 被 agent_reply 调用 (reply循环中保存消息)

---

### 5. agent_extensions.rs (~800行)
**职责**: 扩展管理、加载、卸载、状态持久化

**公开接口**:
```rust
impl Agent {
    pub async fn add_extension(...) -> Result<ExtensionLoadResult>;
    pub async fn add_extensions_bulk(...) -> Result<Vec<ExtensionLoadResult>>;
    pub async fn remove_extension(...) -> Result<()>;
    pub async fn remove_extension_by_key(...) -> Result<bool>;
    pub async fn list_extensions() -> Vec<String>;
    pub async fn get_extension_configs() -> Vec<ExtensionConfig>;
    pub async fn persist_extension_state(...) -> Result<()>;
    pub async fn persist_extension_configs(...) -> Result<()>;
    pub async fn load_extensions_from_session(...) -> Result<()>;
}
```

**包含函数** (~10个):
- add_extension()
- add_extensions_bulk()
- add_extension_inner() (内部)
- remove_extension()
- remove_extension_by_key()
- list_extensions()
- get_extension_configs()
- persist_extension_state()
- persist_extension_configs()
- load_extensions_from_session()

---

### 6. agent_prompts.rs (~400行)
**职责**: 系统提示词管理、扩展提示词、计划提示词

**公开接口**:
```rust
impl Agent {
    pub async fn extend_system_prompt(...);
    pub async fn remove_system_prompt_extra(...);
    pub async fn override_system_prompt(...);
    pub async fn clear_system_prompt_override();
    pub async fn list_extension_prompts(...) -> HashMap<String, Vec<Prompt>>;
    pub async fn get_prompt(...) -> Result<String>;
    pub async fn get_plan_prompt(...) -> Result<String>;
}
```

**包含函数** (~7个):
- extend_system_prompt()
- remove_system_prompt_extra()
- override_system_prompt()
- clear_system_prompt_override()
- list_extension_prompts()
- get_prompt()
- get_plan_prompt()

---

### 7. agent_reply.rs (~1500行)
**职责**: reply 主循环、流式响应、状态机集成

**公开接口**:
```rust
impl Agent {
    pub async fn reply(...) -> Result<BoxStream<'_, Result<AgentEvent>>>;
}
```

**包含函数** (~5个核心 + 辅助):
- reply() (入口)
- reply_impl() (实现)
- reply_internal() (核心逻辑，包含 try_stream 大循环)
- stream_state_machine_turn() (状态机路径)
- stream_state_machine_session() (状态机会话)
- prepare_reply_context() (上下文准备)
- load_project_instructions() (项目指令加载)

**依赖关系**:
- 依赖所有其他模块 (orchestrator 角色)
- 调用 agent_tools::dispatch_tool_call()
- 调用 agent_hooks::emit_hook()
- 调用 agent_messages::push_message_with_id()
- 调用 agent_retry::handle_retry_logic()
- 调用 agent_state::steer()

---

### 8. agent_retry.rs (~300行)
**职责**: 重试逻辑、错误处理、重试计数管理

**公开接口**:
```rust
pub struct RetryManager {
    attempts: AtomicU32,
}

impl Agent {
    pub(crate) async fn reset_retry_attempts();
    pub(crate) async fn increment_retry_attempts() -> u32;
    pub(crate) async fn handle_retry_logic(...) -> RetryDecision;
}
```

**包含函数** (~5个):
- reset_retry_attempts()
- increment_retry_attempts()
- handle_retry_logic()
- should_retry_after_error() (判断)
- max_retry_count() (配置读取)

---

### 9. agent_state.rs (~400行)
**职责**: 状态管理、steer 队列、容器管理

**公开接口**:
```rust
pub struct SteerQueue {
    messages: VecDeque<SteerMessage>,
}

impl Agent {
    pub async fn steer(...) -> Result<()>;
    pub async fn discard_pending_steers(...);
    pub async fn set_container(...);
    pub async fn get_container() -> Option<Container>;
}
```

**包含函数** (~6个):
- steer()
- discard_pending_steers()
- drain_steer_queue() (内部)
- set_container()
- get_container()
- has_pending_steers() (检查)

---

### 10. tests/ (新测试目录，~2000行)
**职责**: 将所有 #[cfg(test)] 模块移动到独立测试文件

**文件结构**:
```
crates/goose/tests/
├── agent_core_test.rs          (~200行)
├── agent_tools_test.rs         (~400行)
├── agent_hooks_test.rs         (~500行)
├── agent_messages_test.rs      (~300行)
├── agent_extensions_test.rs    (~200行)
├── agent_reply_test.rs         (~400行)
└── test_helpers.rs             (~100行，共享测试工具)
```

---

## 实施计划

### Phase 1: 准备阶段 (2小时)
1. **创建模块文件结构**
   ```bash
   mkdir -p crates/goose/src/agents/modules
   touch crates/goose/src/agents/modules/{core,tools,hooks,messages,extensions,prompts,reply,retry,state}.rs
   touch crates/goose/src/agents/modules/mod.rs
   ```

2. **在 agent.rs 中添加模块声明**
   ```rust
   // 在 agent.rs 顶部添加
   mod modules;
   pub use modules::*;
   ```

### Phase 2: 独立模块先行 (优先级从高到低)

#### 2.1 agent_retry.rs (最独立，2小时)
- **原因**: 最小依赖，仅依赖 Agent 配置
- **步骤**:
  1. 复制 RetryManager 相关函数到 agent_retry.rs
  2. 在 agent.rs 中 `pub use modules::retry::*;`
  3. 删除 agent.rs 中的原函数
  4. 运行测试验证

#### 2.2 agent_state.rs (较独立，3小时)
- **原因**: steer 队列逻辑自包含
- **步骤**:
  1. 移动 SteerQueue 和相关函数
  2. 调整 pub(super) 可见性
  3. 更新 agent.rs 引用
  4. 测试验证

#### 2.3 agent_prompts.rs (中等独立，3小时)
- **原因**: 仅操作 PromptManager
- **步骤**:
  1. 移动提示词管理函数
  2. 保持 PromptManager 字段在 Agent
  3. 测试验证

#### 2.4 agent_extensions.rs (4小时)
- **原因**: ExtensionManager 逻辑完整
- **步骤**:
  1. 移动扩展相关函数
  2. 处理与 tools 模块的接口
  3. 测试验证

### Phase 3: 核心模块重构

#### 3.1 agent_hooks.rs (5小时)
- **依赖**: 需要 tools 模块接口定义
- **步骤**:
  1. 定义 Hook 相关 trait
  2. 移动 emit_* 函数
  3. 处理与 tools/messages 的循环依赖
  4. 测试验证

#### 3.2 agent_tools.rs (6小时)
- **依赖**: 需要 hooks 模块
- **挑战**: 工具执行涉及多模块交互
- **步骤**:
  1. 定义 ToolExecutor trait
  2. 移动工具执行函数
  3. 重构确认流程接口
  4. 测试验证

#### 3.3 agent_messages.rs (5小时)
- **依赖**: tools, hooks 模块
- **步骤**:
  1. 移动消息处理函数
  2. 处理 UsageEvent 依赖
  3. 测试验证

### Phase 4: 核心与 Reply 分离

#### 4.1 agent_core.rs (4小时)
- **步骤**:
  1. 保留 Agent/AgentConfig 定义在 agent.rs
  2. 移动配置管理函数到 core.rs
  3. 处理所有模块的反向依赖

#### 4.2 agent_reply.rs (8小时)
- **最后处理**: 依赖所有其他模块
- **步骤**:
  1. 移动 reply() 主循环
  2. 重构模块间调用接口
  3. 完整集成测试

### Phase 5: 测试迁移 (4小时)
1. 移动测试到 tests/ 目录
2. 创建 test_helpers.rs 共享测试工具
3. 修复测试中的模块路径

### Phase 6: 清理与优化 (2小时)
1. 删除 agent.rs 中的空实现
2. 统一模块导出 (mod.rs)
3. 文档更新
4. Clippy 检查

---

## 模块依赖图

```
agent_core (Agent 定义)
    ↓
agent_retry, agent_state, agent_prompts (独立模块)
    ↓
agent_extensions (依赖 core)
    ↓
agent_hooks (依赖 core, extensions)
    ↓
agent_tools (依赖 core, hooks)
    ↓
agent_messages (依赖 core, tools, hooks)
    ↓
agent_reply (orchestrator，依赖所有模块)
```

---

## 风险与注意事项

### 高风险点
1. **循环依赖**: hooks ↔ tools 需要通过 trait 解耦
2. **可见性调整**: pub(super) → pub(crate) 可能暴露内部 API
3. **测试破坏**: 大量测试依赖 Agent 内部结构

### 缓解策略
1. **增量迁移**: 每个模块迁移后立即测试
2. **保留桥接**: 在 agent.rs 中保留 `pub use` 兼容旧代码
3. **CI 守护**: 每次提交运行完整测试套件

---

## 预期收益

### 代码质量
- **可维护性**: 单文件 6229行 → 10个模块平均 ~600行
- **可测试性**: 独立模块可单元测试，减少集成测试依赖
- **可读性**: 清晰的模块边界，职责明确

### 开发效率
- **并行开发**: 不同模块可由不同开发者维护
- **局部重构**: 修改一个模块不影响其他模块
- **编译速度**: 模块化后增量编译更高效

### 未来扩展
- **状态机迁移**: reply 模块独立后易于替换为状态机
- **工具系统升级**: tools 模块可独立演进
- **Hook 系统增强**: hooks 模块可支持更多类型

---

## 总工时估算: 48小时
- Phase 1: 2小时
- Phase 2: 2.1(2h) + 2.2(3h) + 2.3(3h) + 2.4(4h) = 12小时
- Phase 3: 3.1(5h) + 3.2(6h) + 3.3(5h) = 16小时
- Phase 4: 4.1(4h) + 4.2(8h) = 12小时
- Phase 5: 4小时
- Phase 6: 2小时

**建议分 3 周完成，每周 16 小时**
