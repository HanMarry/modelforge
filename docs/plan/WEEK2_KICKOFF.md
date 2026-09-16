# Week 2 启动计划

## 执行日期
**2026-09-22 - 2026-09-26**（5个工作日）

---

## 核心目标

本周完成 4 个并行轨道的 Phase 1 工作：

1. **状态机迁移 Phase 1** (P0) - 差异修复 + 对等性测试框架
2. **错误处理统一 Phase 1** (P1) - 文档化 + ProviderError 设计
3. **Clone 优化 Phase 1** (P1) - agent.rs 热点优化
4. **Arc<Mutex> 迁移规划** (P1) - 读重场景识别

---

## 任务分解

### Track 1: 状态机迁移 Phase 1 (P0)

**负责人**: TBD  
**工时**: 3-4 天

#### Day 1-2: 差异修复

**任务 1.1: Schedule ID 持久化对齐**
- **文件**: `crates/goose/src/agents/agent.rs`
- **目标**: 传统路径 `reply_impl()` 中添加 schedule_id 持久化
- **实现**:
  ```rust
  // 在 reply_impl() 中的适当位置添加
  if let Some(schedule_id) = session_config.schedule_id.clone() {
      session_manager
          .update(&session_id)
          .schedule_id(Some(schedule_id))
          .apply()
          .await?;
  }
  ```
- **验证**: 
  - 运行现有测试套件
  - 手动验证 scheduled task 会话的 schedule_id 持久化

**任务 1.2: Hook 工作目录上下文对齐**
- **文件**: `crates/goose/src/agents/agent.rs`
- **目标**: 传统路径 Hook 调用中添加 `with_working_dir()`
- **实现**:
  ```rust
  self.hook_manager
      .emit(
          HookEvent::SessionStart,
          HookContext::new(HookEvent::SessionStart, &session_id)
              .with_working_dir(session.working_dir.to_string_lossy().to_string()),
      )
      .await;
  ```
- **验证**: Hook 集成测试通过

**交付物**:
- [ ] 差异修复 PR（或差异文档化决策记录）
- [ ] 代码审查通过
- [ ] 所有现有测试通过

#### Day 3-5: 对等性测试框架

**任务 1.3: 创建测试文件**
- **文件**: `crates/goose/tests/state_machine_parity_test.rs`
- **结构**:
  ```rust
  // 测试辅助函数
  fn setup_test_environment() -> TestContext { ... }
  fn normalize_events(events: Vec<AgentEvent>) -> Vec<NormalizedEvent> { ... }
  fn compare_session_states(state1: &Session, state2: &Session) -> Result<()> { ... }
  
  // 10 个核心测试用例（见下文）
  #[tokio::test]
  async fn test_simple_user_message_parity() { ... }
  // ...
  ```

**任务 1.4: 实现 10 个对等性测试**
1. `test_simple_user_message_parity` - 简单用户消息处理
2. `test_tool_call_execution_parity` - 工具调用和响应
3. `test_elicitation_response_parity` - Elicitation 响应处理
4. `test_slash_command_parity` - Slash 命令处理
5. `test_compaction_trigger_parity` - 压缩触发逻辑
6. `test_retry_logic_parity` - 重试逻辑
7. `test_hook_emission_parity` - Hook 触发时机
8. `test_session_naming_parity` - 会话命名
9. `test_schedule_id_handling_parity` - Schedule ID 处理
10. `test_error_recovery_parity` - 错误恢复

**每个测试的结构**:
```rust
#[tokio::test]
async fn test_NAME_parity() {
    // 1. Setup
    let ctx = setup_test_environment().await;
    let input = create_test_input();
    
    // 2. 传统路径执行
    let traditional_events = ctx.agent
        .reply(input.clone(), SessionConfig::default(), None)
        .await?
        .collect::<Vec<_>>()
        .await;
    
    // 3. 状态机路径执行
    std::env::set_var("GOOSE_STATE_MACHINE", "1");
    let state_machine_events = ctx.agent
        .reply(input.clone(), SessionConfig::default(), None)
        .await?
        .collect::<Vec<_>>()
        .await;
    std::env::remove_var("GOOSE_STATE_MACHINE");
    
    // 4. 对比
    let normalized_trad = normalize_events(traditional_events);
    let normalized_sm = normalize_events(state_machine_events);
    assert_eq!(normalized_trad, normalized_sm);
    
    // 5. 会话状态对比
    compare_session_states(&ctx.session_trad, &ctx.session_sm)?;
}
```

**交付物**:
- [ ] 10 个对等性测试实现
- [ ] 所有测试通过
- [ ] CI/CD 配置更新（`.github/workflows/` 中添加测试）
- [ ] 代码覆盖率报告 > 85%

---

### Track 2: 错误处理统一 Phase 1 (P1)

**负责人**: TBD  
**工时**: 2-3 天

#### Day 1-2: 文档化

**任务 2.1: 创建错误处理指南**
- **文件**: `docs/ERROR_HANDLING_GUIDE.md`
- **内容**:
  ```markdown
  # 错误处理指南
  
  ## 分层策略
  
  ### 应用层 (anyhow)
  - 使用场景: Agent loop, Session, Tools
  - 示例: ...
  
  ### 库层 (thiserror)
  - 使用场景: Providers, Config, Plugins
  - 示例: ...
  
  ### 边界转换
  - 模式: impl From<CustomError> for anyhow::Error
  - 示例: ...
  
  ## 反模式
  - 过度使用 .unwrap()
  - 吞噬错误信息
  - 字符串错误匹配
  ```

**任务 2.2: 更新贡献指南**
- **文件**: `CONTRIBUTING.md`
- **添加章节**: "错误处理最佳实践"
- **内容**: 引用 ERROR_HANDLING_GUIDE.md，提供快速决策树

**交付物**:
- [ ] `docs/ERROR_HANDLING_GUIDE.md` 完成
- [ ] `CONTRIBUTING.md` 更新
- [ ] 团队审查通过

#### Day 3: ProviderError 设计

**任务 2.3: 设计统一 ProviderError**
- **文件**: `crates/goose/src/providers/base.rs`
- **设计**:
  ```rust
  #[derive(Debug, thiserror::Error)]
  pub enum ProviderError {
      #[error("Authentication required for provider {provider}")]
      AuthRequired { provider: String },
      
      #[error("Rate limited: retry after {retry_after:?}")]
      RateLimited { retry_after: Option<Duration> },
      
      #[error("Invalid response from provider: {0}")]
      InvalidResponse(String),
      
      #[error("Network error: {0}")]
      Network(String),
      
      #[error("Configuration error: {0}")]
      Config(#[from] ConfigError),
      
      #[error(transparent)]
      Other(#[from] anyhow::Error),
  }
  
  // 自动转换为 anyhow::Error
  impl From<ProviderError> for anyhow::Error {
      fn from(err: ProviderError) -> Self {
          anyhow::Error::new(err)
      }
  }
  ```

**交付物**:
- [ ] ProviderError 定义完成
- [ ] 单元测试覆盖所有变体
- [ ] 文档注释完整

---

### Track 3: Clone 优化 Phase 1 (P1)

**负责人**: TBD  
**工时**: 3-4 天

#### Day 1-2: Message 传递优化

**任务 3.1: 评估优化方案**
- **目标**: 决定使用 Arc<Message> 还是所有权移动
- **文件**: `crates/goose/src/agents/agent.rs` (lines 316-337)
- **当前问题**:
  ```rust
  // ❌ 两次深度复制
  messages.push(message.clone());
  conversation.push(message.clone());
  ```
- **方案对比**:
  - **方案A**: `Arc<Message>` - 改动小，兼容性好
  - **方案B**: 所有权移动 - 零成本，需重构数据流
- **决策标准**: 性能提升 vs 代码复杂度

**任务 3.2: 实施优化**
- **基准测试**: 使用 criterion 测量当前性能
- **实施**: 根据选定方案重构
- **验证**: 性能测试 + 功能测试

**交付物**:
- [ ] 性能基准报告（优化前）
- [ ] Message 传递优化 PR
- [ ] 性能基准报告（优化后，预期提升 30-50%）
- [ ] 所有测试通过

#### Day 3-4: 配置传递优化

**任务 3.3: 配置借用重构**
- **文件**: `crates/goose/src/agents/agent.rs` (lines 413-428)
- **目标**: 将配置传递从 clone 改为引用借用
- **当前问题**:
  ```rust
  let goose_platform = config.goose_platform.clone();
  let explicit_mcp_host_info = config.mcp_host_info.clone();
  ```
- **优化后**:
  ```rust
  let goose_platform = &config.goose_platform;
  let explicit_mcp_host_info = config.mcp_host_info.as_ref();
  ```
- **预期减少**: ~15 次配置 clone

**任务 3.4: ID 字符串优化（可选）**
- **时间允许时**: 实现 `Arc<str>` 或 `Cow<str>` 优化
- **预期减少**: ~20 次字符串 clone

**交付物**:
- [ ] agent.rs clone 数量减少到 120 以下
- [ ] 配置传递优化 PR
- [ ] clippy 无 clone 相关警告

---

### Track 4: Arc<Mutex> 迁移规划 (P1)

**负责人**: TBD  
**工时**: 1-2 天

#### Day 1-2: 读重场景识别

**任务 4.1: 扫描 Arc<Mutex> 使用**
- **命令**: `grep -rn "Arc<Mutex" crates/goose/src/`
- **目标**: 识别所有 60 个 Arc<Mutex> 实例

**任务 4.2: 分类读写比例**
- **标准**:
  - **读重 (>80% 读取)**: 迁移候选
  - **写重 (>50% 写入)**: 保持 Mutex
  - **不确定**: 需 profiling
- **重点文件**:
  - `crates/goose/src/providers/acp/provider.rs`
  - `crates/goose/src/providers/acp/server.rs`
  - `crates/goose/src/agents/extension_manager.rs`

**任务 4.3: 创建迁移计划**
- **文件**: `ARC_RWLOCK_MIGRATION_PLAN.md`
- **内容**:
  - 60 个实例分类
  - 迁移优先级
  - 风险评估（死锁可能性）
  - Week 3 实施顺序

**交付物**:
- [ ] Arc<Mutex> 使用清单（60 个实例）
- [ ] 读写比例分类（至少 30 个读重候选）
- [ ] `ARC_RWLOCK_MIGRATION_PLAN.md` 完成

---

## 每日站会议程

**时间**: 每日 10:00 AM  
**时长**: 15 分钟

**议程**:
1. 昨日完成（每人 2 分钟）
2. 今日计划（每人 2 分钟）
3. 阻塞问题（5 分钟）
4. 跨轨道依赖同步（3 分钟）

---

## 风险管理

### 高风险

**R1: 状态机差异修复引入新 bug**
- **缓解**: 每个修复后运行完整测试套件
- **应急**: 准备 revert commit

**R2: 对等性测试环境搭建复杂**
- **缓解**: Day 1 优先搭建测试框架
- **应急**: 简化测试场景，先覆盖核心路径

### 中风险

**R3: Clone 优化方案选择争议**
- **缓解**: Day 1 快速原型验证两种方案
- **决策**: 性能测试数据驱动

**R4: ProviderError 设计需要多轮迭代**
- **缓解**: 提前与 Provider 使用方沟通
- **应急**: Phase 1 仅完成设计，实施推迟到 Week 3

---

## 成功标准

### 技术标准

- [ ] 状态机差异修复完成（2 项）
- [ ] 10 个对等性测试全部通过
- [ ] 错误处理指南文档完成
- [ ] ProviderError 设计定稿
- [ ] agent.rs clone < 120
- [ ] Arc<Mutex> 迁移计划完成

### 质量标准

- [ ] 所有 PR 代码审查通过
- [ ] CI/CD 绿灯
- [ ] 无新增 clippy 警告
- [ ] 代码覆盖率 > 85%

### 流程标准

- [ ] 每日站会 100% 参与
- [ ] 阻塞问题 < 24 小时解决
- [ ] 文档更新与代码同步

---

## 交付物清单

### 代码

1. **差异修复 PR** - 状态机对等性修复
2. **对等性测试 PR** - 10 个测试用例
3. **Clone 优化 PR** - agent.rs 优化

### 文档

4. **ERROR_HANDLING_GUIDE.md** - 错误处理指南
5. **ARC_RWLOCK_MIGRATION_PLAN.md** - 锁迁移计划
6. **CONTRIBUTING.md** - 更新错误处理章节

### 报告

7. **性能基准报告** - Clone 优化前后对比
8. **代码覆盖率报告** - 对等性测试覆盖率

---

## Week 2 结束标准

**完成标准**: 以下 4 个轨道至少 3 个达到 Phase 1 目标

1. ✅ 状态机迁移 Phase 1 完成
2. ✅ 错误处理 Phase 1 完成
3. ✅ Clone 优化 Phase 1 完成
4. ✅ Arc<Mutex> 迁移规划完成

**延期标准**: 任一 P0 任务（状态机迁移）未完成

---

## 下周预告 (Week 3)

**主要任务**:
1. 状态机迁移 Phase 2 - 边缘场景测试
2. 错误处理 Phase 2 - ProviderError 实施
3. Clone 优化 Phase 2 - Provider 层优化
4. Arc<Mutex> → Arc<RwLock> 迁移实施

---

**文档版本**: v1.0  
**创建日期**: 2026-09-15  
**负责人**: Goose 优化项目组  
**审批状态**: 📋 待审批
