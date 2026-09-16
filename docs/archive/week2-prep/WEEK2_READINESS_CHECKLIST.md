# Week 2 工作准备清单

## 概览

**目标**: 确保 Week 2 工作顺利启动  
**完成时间**: Week 2 Day 1 开始前  
**负责人**: 项目负责人 + 各轨道负责人

---

## 人员分配

### 待确认事项

- [ ] 确认 Week 2 可用开发人员（预计需要 2-3 人全职）
- [ ] 分配各轨道负责人：
  - Track 1 (状态机迁移 P0): \_\_\_\_\_\_\_\_
  - Track 2 (错误处理 P1): \_\_\_\_\_\_\_\_
  - Track 3 (Clone 优化 P1): \_\_\_\_\_\_\_\_
  - Track 4 (Arc<Mutex> 规划 P1): \_\_\_\_\_\_\_\_
- [ ] 指定代码审查人员（至少 1 人）
- [ ] 指定 Tech Lead（架构决策审批）

---

## 开发环境

### 必需工具

- [ ] Rust 工具链已安装
  ```bash
  rustc --version  # 应显示 1.70+
  cargo --version
  ```

- [ ] Hermit 环境激活
  ```bash
  source bin/activate-hermit
  ```

- [ ] 依赖安装完成
  ```bash
  cargo build
  ```

- [ ] 测试环境验证
  ```bash
  cargo test -p goose
  ```

### 性能测试工具

- [ ] criterion 基准测试框架
  ```bash
  cargo install cargo-criterion
  ```

- [ ] flamegraph 性能分析（可选）
  ```bash
  cargo install flamegraph
  ```

- [ ] clippy 和 fmt 检查
  ```bash
  cargo clippy --version
  cargo fmt --version
  ```

---

## 代码仓库准备

### Git 分支策略

- [ ] 从 main 分支创建 Week 2 工作分支
  ```bash
  git checkout main
  git pull origin main
  git checkout -b week2-optimization
  ```

- [ ] 为每个 Track 创建特性分支
  ```bash
  git checkout -b track1-state-machine-parity
  git checkout -b track2-error-handling
  git checkout -b track3-clone-optimization
  git checkout -b track4-arc-mutex-plan
  ```

### GitHub Issues

- [ ] 为 Track 1 创建 Issue: "State Machine Parity - Phase 1"
  - 标签: P0, state-machine, Week-2
  - 关联: state_machine_migration_roadmap.md
  
- [ ] 为 Track 2 创建 Issue: "Unified Error Handling - Phase 1"
  - 标签: P1, error-handling, Week-2
  - 关联: error_handling_analysis.md
  
- [ ] 为 Track 3 创建 Issue: "Clone Optimization - agent.rs"
  - 标签: P1, performance, Week-2
  - 关联: clone_optimization_analysis.md
  
- [ ] 为 Track 4 创建 Issue: "Arc<Mutex> Migration Planning"
  - 标签: P1, concurrency, Week-2
  - 关联: clone_optimization_analysis.md (Arc<Mutex> 章节)

---

## 文档准备

### 必读文档

每位开发人员开始工作前必须阅读：

- [ ] [AGENTS.md](AGENTS.md) - 贡献工作流程
- [ ] [EXECUTION_LOG.md](EXECUTION_LOG.md) - 项目整体状态
- [ ] [WEEK2_KICKOFF.md](WEEK2_KICKOFF.md) - Week 2 详细计划
- [ ] [WEEK2_PROGRESS.md](WEEK2_PROGRESS.md) - 进度追踪看板

### 轨道特定文档

**Track 1 负责人必读**:
- [ ] [state_machine_parity_analysis.md](state_machine_parity_analysis.md)
- [ ] [state_machine_migration_roadmap.md](state_machine_migration_roadmap.md)
- [ ] [PHASE1_IMPLEMENTATION_GUIDE.md](PHASE1_IMPLEMENTATION_GUIDE.md)

**Track 2 负责人必读**:
- [ ] [error_handling_analysis.md](error_handling_analysis.md)

**Track 3 负责人必读**:
- [ ] [clone_optimization_analysis.md](clone_optimization_analysis.md)

**Track 4 负责人必读**:
- [ ] [clone_optimization_analysis.md](clone_optimization_analysis.md) - "Arc<Mutex> vs Arc<RwLock> 分析"章节

---

## 会议日程

### 启动会议

- [ ] 召开 Week 2 启动会（Monday 9:00 AM）
  - **议程**:
    1. 回顾 Week 1 成果（15 分钟）
    2. Week 2 目标对齐（15 分钟）
    3. 各轨道任务分配（20 分钟）
    4. 风险和依赖讨论（10 分钟）
  - **参与者**: 全体开发人员 + Tech Lead
  - **产出**: 明确的任务分配和时间承诺

### 每日站会

- [ ] 设置每日站会日历提醒（10:00 AM，15 分钟）
- [ ] 准备站会模板（见 WEEK2_PROGRESS.md）
- [ ] 指定站会主持人（轮换）

### 代码审查会

- [ ] 设置每日代码审查时间段（3:00-5:00 PM）
- [ ] 明确审查标准：
  - 所有测试通过
  - Clippy 无警告
  - 遵循 AGENTS.md 规范
  - 性能测试通过（Track 3）

---

## 沟通渠道

### Slack/Teams 频道

- [ ] 创建 #week2-optimization 频道
- [ ] Pin 重要文档链接：
  - WEEK2_KICKOFF.md
  - WEEK2_PROGRESS.md
  - GitHub Issues 看板

### 状态报告

- [ ] 确定每日进度更新方式：
  - [ ] 更新 WEEK2_PROGRESS.md（推荐）
  - [ ] Slack 频道每日总结
  - [ ] GitHub Project 看板

---

## 测试策略

### 测试环境

- [ ] 验证 CI/CD 流水线正常
  ```bash
  # 检查 GitHub Actions 配置
  cat .github/workflows/rust.yml
  ```

- [ ] 本地测试命令验证
  ```bash
  # 单元测试
  cargo test -p goose
  
  # 集成测试
  cargo test --test state_machine_parity_test
  
  # Clippy 检查
  cargo clippy --all-targets -- -D warnings
  
  # 格式检查
  cargo fmt -- --check
  ```

### 测试数据

- [ ] 准备 scheduled task 测试 recipe（Track 1）
  ```yaml
  # test-scheduled.yaml
  name: Test Scheduled Task
  schedule_id: test-schedule-001
  steps:
    - prompt: "Hello from scheduled task"
  ```

- [ ] 准备 Hook 测试脚本（Track 1）
  ```bash
  # .goose/hooks/session-start.sh
  #!/bin/bash
  echo "Working directory: $GOOSE_WORKING_DIR"
  ```

---

## 性能基准

### Track 3 基准测试准备

- [ ] 创建基准测试目录
  ```bash
  mkdir -p benches
  ```

- [ ] 编写 criterion 基准配置
  ```toml
  # Cargo.toml
  [[bench]]
  name = "agent_clone_benchmark"
  harness = false
  ```

- [ ] 准备基准测试数据
  - 标准 Message 对象（100 字文本）
  - 标准 AgentConfig 对象

---

## 风险准备

### 高风险缓解

**R1: 状态机差异修复引入新 bug**
- [ ] 准备回滚脚本
  ```bash
  git checkout main -- crates/goose/src/agents/agent.rs
  ```
- [ ] 隔离测试环境（避免影响主分支）

**R2: Clone 优化性能回归**
- [ ] 记录优化前性能基准（作为回滚依据）
- [ ] 准备 A/B 测试脚本

**R3: 并发问题（Arc<Mutex> 迁移）**
- [ ] 安装死锁检测工具（parking_lot）
- [ ] 准备并发压力测试脚本

---

## 交付物准备

### 文档模板

- [ ] PR 模板准备
  ```markdown
  ## 描述
  [简要描述本 PR 的目的]
  
  ## 关联 Issue
  Closes #XXX
  
  ## 变更内容
  - [ ] 代码变更
  - [ ] 测试覆盖
  - [ ] 文档更新
  
  ## 测试
  - [ ] 单元测试通过
  - [ ] 集成测试通过
  - [ ] 性能测试通过（如适用）
  
  ## 检查清单
  - [ ] cargo fmt 已运行
  - [ ] cargo clippy 无警告
  - [ ] 遵循 AGENTS.md 规范
  ```

### 报告模板

- [ ] 性能基准报告模板（Track 3）
  ```markdown
  # Clone 优化性能报告
  
  ## 基准测试环境
  - CPU: 
  - 内存: 
  - Rust 版本: 
  
  ## 测试结果
  | 指标 | 优化前 | 优化后 | 提升 |
  |-----|--------|--------|------|
  | Message clone 延迟 | | | |
  | 内存使用 | | | |
  
  ## 结论
  ```

---

## Day 1 执行清单

### Morning (9:00 - 12:00)

- [ ] 9:00 - 启动会议
- [ ] 10:00 - 环境验证和代码拉取
- [ ] 11:00 - 开始第一个任务
  - Track 1: Schedule ID 持久化代码修改
  - Track 2: 开始编写 ERROR_HANDLING_GUIDE.md
  - Track 3: 设置 criterion 基准测试
  - Track 4: 扫描 Arc<Mutex> 实例

### Afternoon (13:00 - 18:00)

- [ ] 13:00 - 继续早上任务
- [ ] 15:00 - 第一轮代码审查（如有 PR）
- [ ] 17:00 - 更新 WEEK2_PROGRESS.md
- [ ] 17:30 - Day 1 总结会（15 分钟）
  - 完成情况
  - 遇到的问题
  - 明日计划调整

---

## 应急预案

### 人员不足

**场景**: 开发人员请假或不可用

**应对**:
1. 优先保证 P0 轨道（Track 1 状态机迁移）
2. P1 轨道延期到 Week 3
3. 通知 Tech Lead 调整时间线

### 技术阻塞

**场景**: 遇到无法解决的技术问题

**应对**:
1. 在每日站会上标记为阻塞问题
2. 升级给 Tech Lead（< 4 小时）
3. 并行开展其他任务
4. 记录问题到 WEEK2_PROGRESS.md

### 测试失败

**场景**: 现有测试套件失败

**应对**:
1. 立即停止当前工作
2. 确定是回归 bug 还是测试问题
3. 修复后再继续
4. 更新测试文档

---

## 最终检查

**在 Week 2 Day 1 开始前，确认以下所有项已完成**:

- [ ] 所有开发人员已分配轨道
- [ ] 开发环境已验证
- [ ] 必读文档已分发
- [ ] GitHub Issues 已创建
- [ ] 启动会议已安排
- [ ] 每日站会已设置
- [ ] 沟通渠道已建立
- [ ] 测试环境已准备
- [ ] 应急预案已明确

---

**清单版本**: v1.0  
**创建日期**: 2026-09-15  
**负责人**: 项目负责人  
**完成截止**: 2026-09-22 09:00 AM
