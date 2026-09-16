# Week 2 进度追踪看板

## 概览

**周期**: 2026-09-22 - 2026-09-26（5个工作日）  
**整体进度**: 0% (0/4 轨道完成)  
**状态**: 🟡 准备中

---

## 轨道进度总览

| 轨道 | 优先级 | 进度 | 状态 | 预计完成 | 实际完成 |
|-----|--------|------|------|---------|---------|
| Track 1: 状态机迁移 Phase 1 | P0 | 0% | ⏳ 待开始 | Day 4 | - |
| Track 2: 错误处理 Phase 1 | P1 | 0% | ⏳ 待开始 | Day 3 | - |
| Track 3: Clone 优化 Phase 1 | P1 | 0% | ⏳ 待开始 | Day 4 | - |
| Track 4: Arc<Mutex> 迁移规划 | P1 | 0% | ⏳ 待开始 | Day 2 | - |

---

## Track 1: 状态机迁移 Phase 1 (P0)

**负责人**: TBD  
**工时**: 16-20h  
**当前进度**: 0/12 任务

### Day 1-2: 差异修复 (0%)

#### Schedule ID 持久化
- [ ] 在 `reply_impl()` 添加持久化逻辑 (2h)
- [ ] 编写单元测试 `test_traditional_path_persists_schedule_id` (1h)
- [ ] 运行完整测试套件验证 (0.5h)
- [ ] 提交 PR (0.5h)

#### Hook 工作目录上下文
- [ ] 检查 `emit_hook()` 当前实现 (0.5h)
- [ ] 修改 SessionStart hook 触发点 (1h)
- [ ] 检查并更新其他 hook 触发点 (1h)
- [ ] 编写单元测试 `test_traditional_path_hook_has_working_dir` (1h)
- [ ] 运行 Hook 集成测试 (0.5h)
- [ ] 提交 PR (0.5h)

**小计**: 8h

### Day 3-5: 对等性测试框架 (0%)

- [ ] 创建 `tests/state_machine_parity_test.rs` (1h)
- [ ] 实现测试辅助函数 (2h)
  - `setup_test_environment()`
  - `normalize_events()`
  - `compare_session_states()`
- [ ] 实现 10 个对等性测试 (8h)
  - [ ] test_simple_user_message_parity
  - [ ] test_tool_call_execution_parity
  - [ ] test_elicitation_response_parity
  - [ ] test_slash_command_parity
  - [ ] test_compaction_trigger_parity
  - [ ] test_retry_logic_parity
  - [ ] test_hook_emission_parity
  - [ ] test_session_naming_parity
  - [ ] test_schedule_id_handling_parity
  - [ ] test_error_recovery_parity
- [ ] CI/CD 配置更新 (1h)
- [ ] 代码覆盖率报告生成 (0.5h)

**小计**: 12.5h

**Track 1 总工时**: 20.5h

---

## Track 2: 错误处理 Phase 1 (P1)

**负责人**: TBD  
**工时**: 8-12h  
**当前进度**: 0/8 任务

### Day 1-2: 文档化 (0%)

- [ ] 创建 `docs/ERROR_HANDLING_GUIDE.md` (3h)
  - 分层策略（应用层 vs 库层）
  - 使用场景和示例
  - 边界转换模式
  - 反模式警告
- [ ] 更新 `CONTRIBUTING.md` (1h)
  - 添加"错误处理最佳实践"章节
  - 快速决策树
- [ ] 团队审查 (1h)

**小计**: 5h

### Day 3: ProviderError 设计 (0%)

- [ ] 在 `providers/base.rs` 设计 `ProviderError` 枚举 (2h)
  - AuthRequired 变体
  - RateLimited 变体
  - InvalidResponse 变体
  - Network 变体
  - Config 变体
  - Other 变体
- [ ] 实现 `From<ProviderError> for anyhow::Error` (0.5h)
- [ ] 编写单元测试覆盖所有变体 (1.5h)
- [ ] 文档注释完善 (1h)

**小计**: 5h

**Track 2 总工时**: 10h

---

## Track 3: Clone 优化 Phase 1 (P1)

**负责人**: TBD  
**工时**: 12-16h  
**当前进度**: 0/9 任务

### Day 1-2: Message 传递优化 (0%)

- [ ] 使用 criterion 创建性能基准测试 (2h)
- [ ] 运行基准测试（优化前） (0.5h)
- [ ] 评估 Arc<Message> vs 所有权移动方案 (2h)
- [ ] 实施选定方案 (3h)
- [ ] 运行基准测试（优化后） (0.5h)
- [ ] 功能测试验证 (1h)

**小计**: 9h

### Day 3-4: 配置传递优化 (0%)

- [ ] 重构配置传递为引用借用 (2h)
- [ ] 更新函数签名 (1h)
- [ ] 运行测试套件 (0.5h)
- [ ] （可选）ID 字符串优化 Arc<str>/Cow<str> (2h)
- [ ] 验证 agent.rs clone < 120 (0.5h)
- [ ] clippy 检查 (0.5h)

**小计**: 6.5h

**Track 3 总工时**: 15.5h

---

## Track 4: Arc<Mutex> 迁移规划 (P1)

**负责人**: TBD  
**工时**: 4-8h  
**当前进度**: 0/5 任务

### Day 1-2: 读重场景识别 (0%)

- [ ] 扫描所有 Arc<Mutex> 实例 (1h)
  ```bash
  grep -rn "Arc<Mutex" crates/goose/src/ > arc_mutex_instances.txt
  ```
- [ ] 分类读写比例 (3h)
  - 读重 (>80% 读取): 迁移候选
  - 写重 (>50% 写入): 保持 Mutex
  - 不确定: 需 profiling
- [ ] 重点文件分析 (2h)
  - `providers/acp/provider.rs`
  - `providers/acp/server.rs`
  - `agents/extension_manager.rs`
- [ ] 创建 `ARC_RWLOCK_MIGRATION_PLAN.md` (2h)
  - 60 个实例清单
  - 迁移优先级排序
  - 死锁风险评估
  - Week 3 实施顺序

**Track 4 总工时**: 8h

---

## 每日站会记录

### Day 1 (2026-09-22)
- **参与者**: TBD
- **昨日完成**: Week 1 所有分析任务
- **今日计划**: 
  - Track 1: 开始差异修复（Schedule ID）
  - Track 2: 创建错误处理指南
  - Track 4: 扫描 Arc<Mutex> 实例
- **阻塞问题**: 无

### Day 2 (2026-09-23)
- **参与者**: TBD
- **昨日完成**: TBD
- **今日计划**: TBD
- **阻塞问题**: TBD

### Day 3 (2026-09-24)
- **参与者**: TBD
- **昨日完成**: TBD
- **今日计划**: TBD
- **阻塞问题**: TBD

### Day 4 (2026-09-25)
- **参与者**: TBD
- **昨日完成**: TBD
- **今日计划**: TBD
- **阻塞问题**: TBD

### Day 5 (2026-09-26)
- **参与者**: TBD
- **昨日完成**: TBD
- **今日计划**: TBD
- **阻塞问题**: TBD

---

## 阻塞问题追踪

| ID | 问题描述 | 影响轨道 | 严重性 | 提出日期 | 负责人 | 状态 | 解决日期 |
|----|---------|---------|--------|---------|--------|------|---------|
| - | 暂无阻塞问题 | - | - | - | - | - | - |

---

## PR 追踪

| PR # | 标题 | 轨道 | 状态 | 创建日期 | 审查者 | 合并日期 |
|------|-----|------|------|---------|--------|---------|
| - | feat: persist schedule_id in traditional agent path | Track 1 | 📝 待创建 | - | TBD | - |
| - | feat: add working_dir to hooks in traditional path | Track 1 | 📝 待创建 | - | TBD | - |
| - | test: add state machine parity test suite | Track 1 | 📝 待创建 | - | TBD | - |
| - | docs: add ERROR_HANDLING_GUIDE | Track 2 | 📝 待创建 | - | TBD | - |
| - | feat: design unified ProviderError | Track 2 | 📝 待创建 | - | TBD | - |
| - | perf: optimize agent.rs message passing | Track 3 | 📝 待创建 | - | TBD | - |
| - | perf: refactor config passing to borrowing | Track 3 | 📝 待创建 | - | TBD | - |
| - | docs: add ARC_RWLOCK_MIGRATION_PLAN | Track 4 | 📝 待创建 | - | TBD | - |

---

## 风险警报

### 当前风险 (0 个活跃)

暂无活跃风险

### 已缓解风险

- R1: 状态机差异修复引入新 bug - 通过完整测试套件缓解
- R2: 对等性测试环境复杂 - Phase 1 实施指南提供详细步骤

---

## 成功指标

### 技术指标

| 指标 | 目标 | 当前 | 状态 |
|-----|------|------|------|
| 状态机差异数 | 0 | 2 | 🔴 |
| 对等性测试通过率 | 100% | - | ⏳ |
| ERROR_HANDLING_GUIDE 完成度 | 100% | 0% | ⏳ |
| ProviderError 设计完成 | ✅ | ❌ | ⏳ |
| agent.rs clone 数量 | <120 | 190 | 🔴 |
| Arc<Mutex> 迁移计划 | ✅ | ❌ | ⏳ |

### 流程指标

| 指标 | 目标 | 当前 | 状态 |
|-----|------|------|------|
| 每日站会参与率 | 100% | - | ⏳ |
| PR 平均审查时间 | <4h | - | ⏳ |
| CI/CD 通过率 | 100% | - | ⏳ |
| 阻塞问题解决时间 | <24h | - | ⏳ |

---

## Week 2 结束标准

### 必须完成 (P0)

- [ ] Track 1: 状态机迁移 Phase 1 完成
  - [ ] 2 项差异修复
  - [ ] 10 个对等性测试通过
  - [ ] CI/CD 集成

### 应该完成 (P1)

- [ ] Track 2: 错误处理 Phase 1 完成
  - [ ] ERROR_HANDLING_GUIDE.md
  - [ ] ProviderError 设计

- [ ] Track 3: Clone 优化 Phase 1 完成
  - [ ] agent.rs clone < 120

- [ ] Track 4: Arc<Mutex> 迁移规划完成
  - [ ] ARC_RWLOCK_MIGRATION_PLAN.md

---

## 快速链接

- [Week 2 启动计划](WEEK2_KICKOFF.md) - 详细任务分解
- [Phase 1 实施指南](PHASE1_IMPLEMENTATION_GUIDE.md) - 差异修复步骤
- [状态机迁移路线图](state_machine_migration_roadmap.md) - 完整迁移计划
- [错误处理策略分析](error_handling_analysis.md) - 错误处理分析
- [Clone 优化分析](clone_optimization_analysis.md) - Clone 优化策略
- [执行记录](EXECUTION_LOG.md) - 项目整体追踪

---

**最后更新**: 2026-09-15  
**下次更新**: 每日站会后更新  
**维护者**: Goose 优化项目组
