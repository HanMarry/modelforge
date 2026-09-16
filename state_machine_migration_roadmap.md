# 状态机迁移路线图

## 执行摘要

基于完成的功能对等性分析，状态机架构已准备好取代传统 agent.rs 路径。本文档定义了完整迁移的路线图。

**关键结论**：
- ✅ 功能对等性：10/10 核心功能已验证
- ✅ 架构成熟度：28 个 operation 模块覆盖完整生命周期
- ✅ 测试覆盖：258KB 独立测试 vs 传统路径内嵌测试
- ⚠️ 轻微差异：2 项（Schedule ID 持久化、Hook 工作目录上下文）
- 🔴 **性能阻塞项（2026-09-15 代码审查新增）**：状态机每个 step 全量重载会话，
  详见下文 **Phase 1.0**。**不修复则
  Phase 3 的性能验收必然不达标**，因此在 Phase 1 内完成。

**建议时间线**：4-6 周完成生产迁移

---

## Phase 1: 差异修复与测试补全（Week 1-2）

### 1.0 性能阻塞项：每 step 全量重载会话（必做前置）

> **来源**：2026-09-15 全项目代码审查（`PROJECT-AUDIT-20260915.md` #3）。
> 原文的迁移路线图只覆盖了功能对等性，漏掉了这一项。

**问题**：状态机主循环每推进一步，都会把整个会话从 SQLite 重新读取并逐条 JSON
反序列化。

```rust
// crates/goose/src/agents/state_machine/session.rs:198
loop {
    let session = runtime.load(session_id).await?;   // ← 每个 step 一次全量加载
    let Some(mut result) = machine.step(&session, emit).await? else { break; };
    ...
    machine.apply(runtime, &session, &mut result, emit).await?;
    if result.yield_to_client { break; }
}
```

`load` → `get_session(id, true)` → `get_conversation` → 对每行执行
`serde_json::from_str`（`session_manager.rs:1871-1907`）。

**为什么必须在 Phase 1 处理**：Phase 3 的验收标准是"性能不低于传统路径"。传统
路径每轮只读 2 次会话并把 conversation 留在内存（`agent.rs:2109-2111`），状态机
是**每步各读一次**。会话 1000 条消息时，一轮约 5000 次消息反序列化，对比传统
路径约 2000 次，且随会话增长线性放大。**这个差距不会因为后续优化而消失，只会
被 Phase 3 的基准测试暴露出来。**

**重要：这是刻意设计，不是疏漏。** `crates/goose-agent/README.md:39` 明确写着
"The machine reloads the session between passes; it never caches it."，且有
`reconstruction_isolation_lifecycle` 测试守护该不变量。

**因此不能简单加内存缓存** —— 那会破坏"决策由持久化会话重建"这一契约。

**建议改法**：
1. 给 `SessionStorage` 增加 `load_messages_since(session_id, last_row_id)`，
   把每步全表读降为增量读，同时保留重建不变量（推荐）。
2. 若走"缓存 + 仅 ReplaceConversation 时重载"路线，**必须同步修改**
   `goose-agent/README.md:9/39` 与 `AGENTS.md` 的措辞，否则该修复会被 review
   判定为违反契约。

**验收标准**：
- [ ] 单轮工具调用的会话读取次数从 O(步数) 降到 O(1)
- [ ] `reconstruction_isolation_lifecycle` 仍然通过
- [ ] Phase 3 基准测试中状态机路径的会话装载耗时不超过传统路径

**工时估算**：3-5 天

**可达性说明**：状态机路径当前仅在 `GOOSE_STATE_MACHINE=1` 时启用
（`state_machine/mod.rs:73-77` 默认 false），所以这是**迁移阻塞项**而非线上回归。
一旦状态机转为默认路径，该问题立即升级为线上性能问题。

### 1.1 处理功能差异

**任务**: 解决 2 项轻微差异

**Option A - 对齐到状态机行为（推荐）**：
```rust
// 在传统路径 reply_impl() 中添加 schedule_id 持久化
if let Some(schedule_id) = session_config.schedule_id.clone() {
    session_manager
        .update(&session_id)
        .schedule_id(Some(schedule_id))
        .apply()
        .await?;
}

// 在传统路径 Hook 调用中添加 with_working_dir()
self.hook_manager
    .emit(
        HookEvent::SessionStart,
        HookContext::new(HookEvent::SessionStart, &session_id)
            .with_working_dir(session.working_dir.to_string_lossy().to_string()),
    )
    .await;
```

**Option B - 文档化差异为预期行为**：
- 在 AGENTS.md 中记录两条路径的行为差异
- 明确状态机路径提供更强的持久性保证

**验收标准**：
- [ ] 选择并实施 Option A 或 Option B
- [ ] 更新相关文档
- [ ] 通过代码审查

**工时估算**：2-3 天

### 1.2 编写对等性测试套件

**任务**: 实现 `tests/state_machine_parity_test.rs`

**测试用例**：
```rust
// 基础行为对比
#[tokio::test]
async fn test_simple_user_message_parity() {
    // 验证简单用户消息的处理流程一致
}

#[tokio::test]
async fn test_tool_call_execution_parity() {
    // 验证工具调用和响应处理一致
}

#[tokio::test]
async fn test_elicitation_response_parity() {
    // 验证 Elicitation 响应处理一致
}

#[tokio::test]
async fn test_slash_command_parity() {
    // 验证 slash 命令处理一致
}

#[tokio::test]
async fn test_compaction_trigger_parity() {
    // 验证压缩触发条件和结果一致
}

#[tokio::test]
async fn test_retry_logic_parity() {
    // 验证重试逻辑行为一致
}

#[tokio::test]
async fn test_hook_emission_parity() {
    // 验证 Hook 触发时机和上下文一致
}

#[tokio::test]
async fn test_session_naming_parity() {
    // 验证会话命名逻辑一致
}

#[tokio::test]
async fn test_schedule_id_handling_parity() {
    // 验证 schedule_id 处理一致
}

#[tokio::test]
async fn test_error_recovery_parity() {
    // 验证错误恢复行为一致
}
```

**测试策略**：
1. 为每个测试用例准备相同的输入
2. 分别通过传统路径和状态机路径执行
3. 对比输出事件序列、最终会话状态、持久化数据
4. 允许的差异：时间戳、随机 ID（需标准化）

**验收标准**：
- [ ] 10 个核心对等性测试全部通过
- [ ] 代码覆盖率 > 85%
- [ ] CI/CD 集成

**工时估算**：5-7 天

---

## Phase 2: 边缘场景验证（Week 3）

### 2.1 并发与竞争条件测试

```rust
#[tokio::test]
async fn test_concurrent_tool_calls() {
    // 验证并发工具调用的处理一致性
}

#[tokio::test]
async fn test_rapid_user_input() {
    // 验证快速连续用户输入的处理
}

#[tokio::test]
async fn test_cancellation_token_handling() {
    // 验证取消令牌在两条路径中行为一致
}
```

### 2.2 压力测试

```rust
#[tokio::test]
async fn test_large_context_handling() {
    // 验证大上下文（接近限制）的处理
}

#[tokio::test]
async fn test_repeated_compaction() {
    // 验证多次压缩后的稳定性
}

#[tokio::test]
async fn test_long_running_session() {
    // 验证长时间运行会话的稳定性
}
```

### 2.3 错误注入测试

```rust
#[tokio::test]
async fn test_provider_failure_handling() {
    // 验证 Provider 故障恢复
}

#[tokio::test]
async fn test_tool_execution_failure() {
    // 验证工具执行失败的处理
}

#[tokio::test]
async fn test_session_storage_failure() {
    // 验证会话存储失败的处理
}
```

**验收标准**：
- [ ] 所有边缘场景测试通过
- [ ] 无未处理的竞争条件
- [ ] 错误恢复行为符合预期

**工时估算**：4-5 天

---

## Phase 3: 性能基准与优化（Week 4）

### 3.1 性能基准测试

**测试维度**：
1. **响应延迟**：首次响应时间、完整响应时间
2. **吞吐量**：每秒处理的消息数
3. **内存使用**：峰值内存、平均内存
4. **CPU 使用**：平均 CPU 占用率
5. **并发能力**：最大并发会话数

**测试场景**：
```rust
// 使用 criterion 进行基准测试
fn benchmark_simple_reply(c: &mut Criterion) {
    c.bench_function("traditional_path_simple_reply", |b| {
        b.iter(|| {
            // 传统路径执行
        });
    });
    
    c.bench_function("state_machine_simple_reply", |b| {
        b.iter(|| {
            // 状态机路径执行
        });
    });
}
```

**性能目标**：
- 状态机路径延迟 ≤ 传统路径 + 10%
- 内存使用差异 ≤ 15%
- 吞吐量差异 ≤ 5%

> ⚠️ **前置条件**：上述目标在 **Phase 1.0（会话装载性能）**
> 完成前**不可能达成**。当前状态机每 step 全量重载会话，而传统路径每轮只读 2 次，
> 差距随会话长度线性放大。**若 Phase 1.0 未完成，请不要把本阶段的失败归因于
> "架构性能不足"** —— 那是会话装载方式的问题，不是状态机本身的问题。
>
> 建议本阶段的基准测试额外单列一项指标：**单轮工具调用中的会话装载次数**。
> 这个数字能直接、稳定地反映 Phase 1.0 是否生效，不受机器性能波动影响。

### 3.2 性能优化（如果需要）

**潜在优化点**：
1. Operation 链式调用优化
2. 状态持久化批处理
3. 消息元数据序列化优化
4. 并发控制参数调优

**验收标准**：
- [ ] 性能基准测试完成
- [ ] 性能报告生成
- [ ] 性能差异在可接受范围内

**工时估算**：3-5 天

---

## Phase 4: 生产灰度发布（Week 5-6）

### 4.1 灰度策略

**阶段 1 - 内部测试（5%）**：
- 启用 `GOOSE_STATE_MACHINE=1` 的开发环境会话
- 监控 1 周，收集反馈
- 验证核心功能无回归

**阶段 2 - 早期用户（25%）**：
- 向早期采用者推出
- 监控 telemetry 和错误率
- 收集用户反馈

**阶段 3 - 半数用户（50%）**：
- 扩大到 50% 用户群
- 继续监控稳定性
- 准备回滚方案

**阶段 4 - 全量发布（100%）**：
- 全部用户切换到状态机路径
- 移除 `GOOSE_STATE_MACHINE` 环境变量检查
- 准备废弃传统路径

### 4.2 监控指标

**核心指标**：
1. **成功率**：会话完成率
2. **错误率**：各类错误的发生频率
3. **性能**：P50/P95/P99 延迟
4. **用户体验**：用户满意度评分

**告警阈值**：
- 错误率 > 1% → 暂停灰度
- P95 延迟增加 > 20% → 调查优化
- 用户投诉 > 5 个/天 → 快速响应

### 4.3 回滚计划

**触发条件**：
- 严重功能回归
- 性能严重下降（> 50%）
- 数据丢失或损坏

**回滚步骤**：
1. 立即关闭 `GOOSE_STATE_MACHINE=1`
2. 验证传统路径恢复正常
3. 分析根因并修复
4. 重新启动灰度

**验收标准**：
- [ ] 灰度发布完成
- [ ] 所有监控指标正常
- [ ] 无严重回归报告

**工时估算**：10-14 天（含监控周期）

---

## Phase 5: 传统路径废弃（Week 7+）

### 5.1 代码清理

**移除内容**：
1. `reply_impl()` 中的传统路径分支（agent.rs:2105-3600+）
2. `GOOSE_STATE_MACHINE` 环境变量检查
3. 传统路径特定的测试代码
4. 相关文档中的双路径说明

**保留内容**：
1. 共享的底层函数（`compact_messages()`, 重试函数等）
2. 类型定义（`Message`, `SessionConfig` 等）
3. 状态机 operation 模块

### 5.2 代码重构

**简化 agent.rs**：
```rust
// 简化后的 reply() 函数
pub async fn reply(
    &self,
    user_message: Message,
    session_config: SessionConfig,
    cancel_token: Option<CancellationToken>,
) -> Result<BoxStream<'_, Result<AgentEvent>>> {
    // 直接调用状态机路径
    self.reply_with_state_machine(user_message, session_config, cancel_token)
        .await
}

// 移除 reply_impl() 函数
```

### 5.3 文档更新

**更新文档**：
1. `AGENTS.md` - 移除双路径说明
2. `README.md` - 更新架构描述
3. `CONTRIBUTING.md` - 更新开发指南
4. API 文档 - 标记废弃的 API

**验收标准**：
- [ ] 传统路径代码完全移除
- [ ] 所有测试通过
- [ ] 文档更新完成
- [ ] PR 合并到主分支

**工时估算**：3-5 天

---

## 风险管理

### 高风险项

**R1: 未发现的功能差异**
- **缓解措施**：Phase 1-2 的全面测试
- **应急方案**：保留传统路径代码 4 周以便回滚

**R2: 性能回归**
- **缓解措施**：Phase 3 性能基准测试
- **应急方案**：性能优化或延迟迁移
- **⚠️ 已知且已定位（2026-09-15）**：状态机每 step 全量重载会话，是**确定会发生**
  的性能回归，不是"可能发生"。已在 Phase 1.0 列为必做前置项。原缓解措施
  "Phase 3 才测性能"太晚 —— 等测出来时 Phase 1-2 的工作已建立在错误的性能假设上。

**R3: 生产环境稳定性问题**
- **缓解措施**：分阶段灰度发布
- **应急方案**：快速回滚到传统路径

### 中风险项

**R4: 用户体验变化**
- **缓解措施**：收集早期用户反馈
- **应急方案**：UI/UX 调整

**R5: 第三方集成兼容性**
- **缓解措施**：测试所有 MCP 服务器集成
- **应急方案**：兼容性补丁

---

## 成功标准

### 迁移完成标准

✅ **技术标准**：
1. 所有对等性测试通过（Phase 1）
2. 所有边缘场景测试通过（Phase 2）
3. 性能指标在可接受范围内（Phase 3）
4. 生产环境稳定运行 ≥ 2 周（Phase 4）
5. 传统路径代码完全移除（Phase 5）

✅ **质量标准**：
1. 代码覆盖率 > 85%
2. 无 P0/P1 级别 bug
3. 文档完整更新
4. 团队成员完成培训

✅ **业务标准**：
1. 用户满意度 ≥ 基线
2. 错误率 ≤ 基线
3. 性能指标 ≥ 基线

---

## 资源需求

### 人力

- **主要开发者**：1-2 人（全职，6 周）
- **测试工程师**：1 人（兼职，3 周）
- **DevOps 工程师**：1 人（兼职，灰度期间）
- **技术 Leader**：代码审查和架构指导

### 基础设施

- CI/CD 资源：扩展并行测试能力
- 监控系统：增强 telemetry 收集
- 测试环境：独立的性能测试环境

---

## 时间线总览

```
Week 1-2:  Phase 1 - 差异修复与测试补全
           ├── 1.0 会话装载性能（必做前置，3-5 天，未完成则 Phase 3 无法达标）
           ├── 1.1 差异修复
           └── 1.2 对等性测试套件
Week 3:    Phase 2 - 边缘场景验证
Week 4:    Phase 3 - 性能基准与优化
Week 5-6:  Phase 4 - 生产灰度发布
Week 7+:   Phase 5 - 传统路径废弃
```

> **对原时间线的影响**：Phase 1 新增 3-5 天的性能前置项。Week 1-2 原本的工时
> 预算是 16-24h（1.1）+ 32-40h（1.2），已经偏紧；叠加 1.0 后建议将 Phase 1
> 延至 Week 1-3，或从 1.2 的对等性测试用例中砍掉优先级最低的几项。**不要靠压缩
> 1.0 来保时间线** —— 它是唯一"确定会失败"的验收项。

**关键里程碑**：
- Week 2 末：所有对等性测试通过 ✓
- Week 3 末：边缘场景验证完成 ✓
- Week 4 末：性能基准达标 ✓（**依赖 Phase 1.0 完成**）
- Week 6 末：100% 用户迁移 ✓
- Week 7 末：传统路径代码移除 ✓

---

## 下一步行动

### 立即执行（本周）

1. **团队对齐** - 召开迁移启动会议
2. **选择差异处理策略** - Option A vs Option B
3. **创建 GitHub Issue** - 跟踪 Phase 1 任务
4. **分配资源** - 确认开发人员和时间分配
5. 🔴 **认领 Phase 1.0（会话装载性能）** - 这是新识别的必做前置项，需要有人
   在 Phase 3 之前完成。它是当前唯一"确定会失败"的验收标准。

### 本月目标

- 完成 Phase 1（含 1.0 性能前置项）和 Phase 2
- 启动 Phase 3 性能测试
- 制定详细的灰度发布计划

---

**文档版本**：v1.1  
**创建日期**：2026-09-15  
**最后更新**：2026-09-15（根据全项目代码审查补充 Phase 1.0 性能阻塞项与 R2 风险更新）  
**负责人**：待指定  
**状态**：📋 待审批
