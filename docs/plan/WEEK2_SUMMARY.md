# Week 2 准备纪要（合并稿）

> 2026-09-16 合并自 6 份 Week 2 准备文档（WEEK2_READINESS_REPORT / READINESS_CHECKLIST / LAUNCH_CONFIRMATION / SETUP_SUMMARY / PREPARATION_COMPLETE / FINAL_SUMMARY），原件归档于 `docs/archive/week2-prep/`。
> 计划总源见 [OPTIMIZATION_PLAN.md](OPTIMIZATION_PLAN.md)；执行流水见 [EXECUTION_LOG.md](EXECUTION_LOG.md)。

## 一、Week 1 交付回顾（2026-09-15 完成）

| # | 任务 | 交付物 | 状态 |
|---|------|--------|------|
| 1 | 向量数据库 PoC | 509 行代码 + 集成测试 191 行 + `docs/plan/vector_db_poc_report.md` | ✅ 已完成（feature flag 隔离，未接入 agent 流程） |
| 2 | 状态机对等性分析 | `docs/archive/state_machine_parity_analysis.md` | ✅ 结论已被 AUDIT/路线图吸收 |
| 3 | 状态机迁移路线图 | `state_machine_migration_roadmap.md`（根目录，进行中） | ✅ 已交付 |
| 4 | 错误处理策略分析 | `docs/archive/error_handling_analysis.md` | ✅ 已交付 |
| 5 | Clone 优化分析 | `docs/archive/clone_optimization_analysis.md` | ✅ 已交付 |

**合计**：703 行代码 + ~2300 行分析文档。

**D1 战略决策（2026-09-15）**：废弃「agent.rs 手动重构」Task 3——状态机架构已功能对等（10/10），将完全替代传统路径；节省 2-3 周。风险：迁移失败需回退（缓解方案见路线图）。

## 二、Week 2 工作框架（4 轨道并行）

| 轨道 | 优先级 | 内容 | 预估工时 | 关键交付 |
|------|--------|------|----------|----------|
| Track 1 | P0 | 状态机迁移 Phase 1 | 16-20h / 12 子任务 | Schedule ID 持久化修复（agent.rs:2107）、Hook 工作目录修复（agent.rs:2136-2138）、10 个对等性测试、CI 集成 |
| Track 2 | P1 | 错误处理统一 Phase 1 | 8-12h / 8 子任务 | ERROR_HANDLING_GUIDE.md、ProviderError 类型设计 |
| Track 3 | P1 | Clone 优化 Phase 1 | 12-16h / 9 子任务 | agent.rs clone 收敛（190→120）、Message 传递重构、性能基准 |
| Track 4 | P1 | Arc<Mutex> 迁移规划 | 4-8h / 5 子任务 | ARC_RWLOCK_MIGRATION_PLAN.md、60 实例优先级分析 |

**合计**：40-56 小时 / 34 个子任务（平均粒度 1.5h）。
实施细节见 [PHASE1_IMPLEMENTATION_GUIDE.md](PHASE1_IMPLEMENTATION_GUIDE.md)、[agent_refactor_plan.md](agent_refactor_plan.md)。

## 三、启动前检查清单（截至 2026-09-16 的状态）

| 项 | 要求 | 现状 |
|----|------|------|
| 开发环境 | 内核编译 + 单测 + clippy 通过 | ⚠️ 本机无 MSVC、中文路径受限，编译走 `E:\goose-build` + GNU 工具链（见 `环境修复操作清单.md`）；`cargo check` 通道已验证可用 |
| GitHub Issues | 建 4 个轨道 Issue | 未建（当前无自有远端，upstream 仅为参考） |
| Git 分支 | week2-optimization + 4 轨道分支 | 未建（当前工作分支 `modelforge`，见 OPTIMIZATION_PLAN §2 基线说明） |
| 文档分发 | 必读清单发全员 | 单人+AI 协作模式，按需查阅即可 |
| 测试工具 | cargo-criterion / flamegraph | Track 3 开工前安装 |

## 四、待决策点

1. **启动日期**：建议 2026-09-22（周一）；实际以 P0 修复完成后为准（P0 插队，见下）
2. **人员/角色**：原规划 2-3 名全职开发者 + 轨道负责人 + 审查人；当前为单人 + AI 助手执行，轨道按顺序串行推进
3. **P1 轨道优先级**（若资源受限）：Track 2 错误处理 > Track 3 Clone 优化 > Track 4 规划
4. **D1 废弃决策**：已于 09-15 批准，待 Tech Lead 复核（可选）

## 五、成功标准

- **P0（启动条件）**：Week 1 分析完成 ✅ / Week 2 规划完整 ✅ / 环境验证通过 ⏳
- **P1（Week 2 结束时）**：Track 1：2 项差异修复 + 10 测试通过；Track 2：指南完成；Track 3：clone < 120；Track 4：迁移规划完成
- **P2（资源充足时）**：ProviderError 实施、性能提升 >15%、3 个 Arc<RwLock> 迁移

## 六、风险

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| R1 状态机差异修复引入新 bug | 中 | 高 | 按 PHASE1_IMPLEMENTATION_GUIDE 逐步 + 测试 |
| R2 人力不足/中断 | 低 | 高 | 优先 P0 轨道，P1 可延期 |
| R3 测试环境问题 | 中 | 中 | Day 1 优先验证环境 |
| R4 Arc<Mutex> 迁移并发问题 | 低 | 中 | Week 2 仅规划不动手 |

## 七、与 P0 插队任务的关系（2026-09-16 注）

2026-09-16 起执行「先修 P0 五项阻断项」（API Key 静默失效 / 仓库基线 / compile_latex / HTTP 凭据 / /plan 复验），**插队优先于本框架**：P0 全部完成并验证后，再按本纪要推进 Week 2 的 4 轨道。P0 清单与验收标准见 [OPTIMIZATION_PLAN.md](OPTIMIZATION_PLAN.md)。
