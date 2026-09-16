# Phase 1 实施指南 - 状态机差异修复

## 概览

**目标**: 修复传统路径与状态机路径的 2 项功能差异  
**文件**: `crates/goose/src/agents/agent.rs`  
**工时**: 2-3 天  
**优先级**: P0

---

## 背景分析

### 当前状态

**状态机路径** (`reply_with_state_machine`, line 1773-1779):
```rust
if let Some(schedule_id) = session_config.schedule_id.clone() {
    session_manager
        .update(&session_id)
        .schedule_id(Some(schedule_id))
        .apply()
        .await?;
}
```
✅ **已实现**: Schedule ID 显式持久化到会话存储

**传统路径** (`reply_impl`, line 2041-2219):
```rust
async fn reply_impl(
    &self,
    user_message: Message,
    session_config: SessionConfig,
    cancel_token: Option<CancellationToken>,
) -> Result<BoxStream<'_, Result<AgentEvent>>> {
    // ... 省略 elicitation 检查 (line 2060-2095)
    
    if super::state_machine::enabled() {
        return self.reply_with_state_machine(...).await;  // line 2097-2104
    }
    
    // 传统路径开始 (line 2107+)
    let session = session_manager.get_session(&session_config.id, true).await?;
    // ❌ 缺失: schedule_id 持久化逻辑
    
    // ... 直接进入消息处理 (line 2130-2219)
}
```

---

## 差异 1: Schedule ID 持久化

### 问题描述

**状态机路径**: Schedule ID 在 turn 开始时持久化到 SessionManager  
**传统路径**: Schedule ID 仅存在于 `SessionConfig` 中，会话重启后丢失

### 影响范围

- **scheduled task 会话**: 通过 `goose run --recipe` 或 cron 触发的会话
- **会话恢复**: 进程重启后，scheduled task 无法关联回原始 schedule
- **监控和统计**: Telemetry 无法追踪 scheduled task 的执行历史

### 修复方案

#### Option A: 对齐到状态机行为（推荐）

**代码修改位置**: `reply_impl()` 函数，line 2107 之后

**实施步骤**:

1. **在 elicitation 检查后、状态机分发前添加持久化逻辑**

**修改点**: 在 line 2106 (`}`) 之后，line 2107 (`let message_text = ...`) 之前插入

```rust
// 在状态机分发后、传统路径开始前添加
if super::state_machine::enabled() {
    return self.reply_with_state_machine(...).await;
}

// ✅ 新增：传统路径的 schedule_id 持久化
if let Some(schedule_id) = session_config.schedule_id.clone() {
    session_manager
        .update(&session_config.id)
        .schedule_id(Some(schedule_id))
        .apply()
        .await?;
}

let message_text = message_text_for_trace;
// ... 继续传统路径逻辑
```

2. **验证修改正确性**

**测试用例**:
```rust
#[tokio::test]
async fn test_traditional_path_persists_schedule_id() {
    let agent = create_test_agent().await;
    let session_id = "test-scheduled-session".to_string();
    let schedule_id = "cron-daily-backup".to_string();
    
    let session_config = SessionConfig {
        id: session_id.clone(),
        schedule_id: Some(schedule_id.clone()),
        ..Default::default()
    };
    
    // 确保状态机未启用
    std::env::remove_var("GOOSE_STATE_MACHINE");
    
    let message = Message::user().with_text("Hello");
    agent.reply(message, session_config, None).await.unwrap();
    
    // 验证 schedule_id 已持久化
    let session = agent.config.session_manager
        .get_session(&session_id, false)
        .await
        .unwrap();
    assert_eq!(session.schedule_id, Some(schedule_id));
}
```

**运行验证**:
```bash
cargo test -p goose test_traditional_path_persists_schedule_id
```

#### Option B: 文档化差异为预期行为

**场景**: 如果团队决定状态机路径提供更强持久性保证是合理的架构差异

**实施步骤**:

1. **更新 AGENTS.md**

在 "Agent Loop Migration" 章节添加：

```markdown
## Agent Loop Migration

### Known Behavioral Differences

Until the migration is complete, the following differences exist:

#### 1. Schedule ID Persistence
- **State Machine Path**: Schedule ID is persisted to SessionManager at turn start
- **Traditional Path**: Schedule ID remains in-memory only (SessionConfig)
- **Impact**: Scheduled task sessions lose their schedule association after process restart in traditional path
- **Planned Resolution**: Unified behavior in state machine (Week 7)
```

2. **更新 state_machine_parity_analysis.md**

将 "Schedule ID 处理" 从 "⚠️ 轻微差异" 移至 "📋 已知预期差异"

---

## 差异 2: Hook 工作目录上下文

### 问题描述

**状态机路径**: Hook context 包含 `with_working_dir(session.working_dir)`  
**传统路径**: Hook context 缺少工作目录信息

### 影响范围

- **Hook 脚本**: 无法获取会话工作目录，`cd` 到正确路径失败
- **多项目环境**: Hook 在错误的目录执行命令

### 修复方案

#### Option A: 对齐到状态机行为（推荐）

**代码修改位置**: `reply_impl()` 函数中的 Hook 触发点

**当前代码** (line 2136-2138):
```rust
if is_first_agent_turn && !self.session_start_emitted.swap(true, Ordering::AcqRel) {
    self.emit_hook(crate::hooks::HookEvent::SessionStart, &session_config.id)
        .await;
}
```

**问题**: `emit_hook()` 内部构建的 `HookContext` 不包含 `working_dir`

**修改方案**:

**步骤 1**: 检查 `emit_hook()` 函数签名

```bash
grep -A 10 "fn emit_hook" crates/goose/src/agents/agent.rs
```

**预期**: 
```rust
async fn emit_hook(&self, event: HookEvent, session_id: &str) {
    let ctx = HookContext::new(event, session_id);  // ❌ 缺少 working_dir
    self.hook_manager.emit(event, ctx).await;
}
```

**步骤 2**: 修改为直接构建带 `working_dir` 的 `HookContext`

**替换** line 2136-2138:
```rust
if is_first_agent_turn && !self.session_start_emitted.swap(true, Ordering::AcqRel) {
    // ✅ 修改：直接构建带 working_dir 的 HookContext
    let ctx = crate::hooks::HookContext::new(
        crate::hooks::HookEvent::SessionStart,
        &session_config.id,
    )
    .with_working_dir(session.working_dir.to_string_lossy().to_string());
    
    self.hook_manager
        .emit(crate::hooks::HookEvent::SessionStart, ctx)
        .await;
}
```

**步骤 3**: 验证 `session` 变量在此处可用

**检查**: line 2109-2111 已获取 `session`:
```rust
let session = session_manager.get_session(&session_config.id, true).await?;
```
✅ 可直接使用 `session.working_dir`

**步骤 4**: 更新其他 Hook 触发点

**搜索所有 Hook 触发点**:
```bash
grep -n "emit_hook\|hook_manager.emit" crates/goose/src/agents/agent.rs
```

**需要更新的位置**:
- SessionStart hook (line 2137)
- UserPromptSubmit hook (line 2141-2153) - ✅ 已直接构建 HookContext
- 其他 hook 触发点（如有）

**验证测试**:
```rust
#[tokio::test]
async fn test_traditional_path_hook_has_working_dir() {
    let agent = create_test_agent().await;
    let working_dir = PathBuf::from("/test/project");
    
    // 模拟 Hook 接收器
    let (tx, mut rx) = mpsc::channel(10);
    agent.hook_manager.register_test_hook(tx);
    
    std::env::remove_var("GOOSE_STATE_MACHINE");
    
    let message = Message::user().with_text("First message");
    agent.reply(message, session_config, None).await.unwrap();
    
    // 验证 SessionStart hook 包含 working_dir
    let hook_ctx = rx.recv().await.unwrap();
    assert_eq!(hook_ctx.working_dir, Some(working_dir.to_string_lossy().to_string()));
}
```

---

## 实施清单

### Day 1: Schedule ID 持久化

- [ ] **Task 1.1**: 在 `reply_impl()` 中添加 schedule_id 持久化逻辑
- [ ] **Task 1.2**: 编写单元测试 `test_traditional_path_persists_schedule_id`
- [ ] **Task 1.3**: 运行完整测试套件验证无回归
  ```bash
  cargo test -p goose
  ```
- [ ] **Task 1.4**: 提交 PR: "feat: persist schedule_id in traditional agent path"

### Day 2: Hook 工作目录上下文

- [ ] **Task 2.1**: 检查 `emit_hook()` 函数当前实现
- [ ] **Task 2.2**: 修改 SessionStart hook 触发点 (line 2136-2138)
- [ ] **Task 2.3**: 检查并更新其他 hook 触发点
- [ ] **Task 2.4**: 编写单元测试 `test_traditional_path_hook_has_working_dir`
- [ ] **Task 2.5**: 运行 Hook 集成测试
  ```bash
  cargo test -p goose --test hook_integration_test
  ```
- [ ] **Task 2.6**: 提交 PR: "feat: add working_dir to hooks in traditional path"

### Day 3: 验证与文档

- [ ] **Task 3.1**: 运行完整测试套件
  ```bash
  cargo test --all-targets
  cargo clippy --all-targets -- -D warnings
  ```
- [ ] **Task 3.2**: 手动测试 scheduled task 会话
  ```bash
  # 创建测试 recipe
  goose run --recipe test-scheduled.yaml
  # 重启进程
  # 验证 schedule_id 保留
  ```
- [ ] **Task 3.3**: 更新 AGENTS.md（如果选择 Option B）
- [ ] **Task 3.4**: 更新 state_machine_parity_analysis.md
  - 将 "⚠️ 轻微差异" 标记移除
  - 添加 "✅ 已修复" 标记
- [ ] **Task 3.5**: 代码审查

---

## 风险管理

### 高风险

**R1: schedule_id 持久化影响现有会话**
- **缓解**: 仅影响新 turn，现有会话数据不变
- **验证**: 测试非 scheduled 会话（`schedule_id = None`）行为不变

**R2: Hook 修改破坏现有 Hook 脚本**
- **缓解**: 添加 `working_dir` 是向后兼容的（Hook 脚本可忽略新字段）
- **验证**: 运行现有 Hook 集成测试

### 中风险

**R3: 测试覆盖不完整**
- **缓解**: 编写专门的对等性测试（Week 2 Task 1.3）
- **应急**: 灰度发布，监控 scheduled task 行为

---

## 验收标准

### 功能标准

- [ ] 传统路径 schedule_id 持久化到 SessionManager
- [ ] 传统路径 Hook context 包含 working_dir
- [ ] 所有现有测试通过
- [ ] 新增测试覆盖修复的差异

### 代码质量标准

- [ ] 无新增 clippy 警告
- [ ] 代码审查通过
- [ ] 提交消息清晰（遵循 Conventional Commits）

### 文档标准

- [ ] state_machine_parity_analysis.md 更新
- [ ] AGENTS.md 更新（如适用）
- [ ] PR 描述包含验证步骤

---

## 下一步

完成 Phase 1.1（差异修复）后，立即开始 Phase 1.2（对等性测试套件编写），详见 [state_machine_migration_roadmap.md](state_machine_migration_roadmap.md#12-编写对等性测试套件)。

---

**文档版本**: v1.0  
**创建日期**: 2026-09-15  
**预计开始**: Week 2 Day 1  
**负责人**: TBD
