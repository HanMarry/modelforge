# ModelForge 优化计划（v1）

> **唯一计划源（SOT）**。执行流水见 [EXECUTION_LOG.md](EXECUTION_LOG.md)；Week 2 四轨道框架见 [WEEK2_SUMMARY.md](WEEK2_SUMMARY.md)。
> 建立于 2026-09-16，依据六份审查报告 + PROJECT-AUDIT 45 项 + 本日实测对账。

## 0. 摘要与状态板

**一句话**：技术外壳与领域内容已对齐甚至反超对标产品 MathModel；当前阻碍不在"能不能做建模"，而在 **API Key 保存链路阻断内核启动**、工程基线未固定、若干已修未复验项。本计划按 P0（阻断，立即修）→ P1（高优先，随后排期）→ P2/P3（清理与战略项）推进。

| # | P0 项 | 状态（2026-09-16） | 验收标准 |
|---|-------|-------------------|----------|
| P0-1 | API Key 保存静默失效 | ✅ **已修复并验证**（`52d60fc`，[验证记录](../reports/P0-1-verification.md)） | 保存 key 后不重启即 Ready；重启后仍 Ready；编辑 provider 不回退 |
| P0-2 | 仓库基线未固定（改动未提交） | ✅ 已完成（4 批提交 + tag `p0-baseline`） | 两仓库 `git status` 归零 + tag `p0-baseline` |
| P0-3 | compile_latex 假成功（残留/超时/校验） | ✅ **已修复并验证**（`d0e56ec`，[验证记录](../reports/P0-3-verification.md)） | 定向测试通过：清旧产物、杀进程树、PDF 四重校验 |
| P0-4 | HTTP 凭据明文（自定义头 + CLI configure） | ⚠️ 部分修（ACP 层已迁密钥） | config.yaml 无明文（自定义头 + CLI 路径） |
| P0-5 | /plan 失败永久落盘 GOOSE_MODE=auto | ✅ 已修（自证未独立复验） | 独立重放：/mode 恢复、config sha256 不变、错误上抛 |

## 1. 范围与方法

- **审查对象**：`goose/`（Rust 内核 16 crate + Electron 桌面端）及其内容资产（47 技能 / 17 论文模板 / 104 绘图模板）
- **依据报告**（归档于顶层 `docs/reports/`）：
  - `ModelForge-代码层审查报告.md`（第三轮·代码层）
  - `ModelForge-优化审查报告.md`（第二轮·工程流程层）
  - `ModelForge-重新审查报告-20260915.md`（修复轮复核 + 启动取证）
  - `差距审查报告.md`（对标 MathModel）
  - `goose-core-fault-surface-report.md`（内核故障面 7 条）
  - `goose/PROJECT-AUDIT-20260915.md`（45 项分级清单）
  - `RUNTIME-PACKAGING-PLAN.md`（顶层 docs/plan/）
- **方法**：静态审查 → 修复轮 → 复核。本计划为**对账归并**（以最新报告口径为准），不重复已完成的扫描；P0 修复执行时再逐项读源码定改法。

## 2. P0 阻断项（本次执行）

### P0-1 API Key 保存静默失效（最高优先）

- **现象**：用户保存 API Key 后仍报「内核未启动：缺少 API Key」（`main.log` 稳定复现），必须重启应用。
- **根因（2026-09-16 实测链路）**：
  1. 应用侧密钥副本 `%APPDATA%/ModelForge/agent-kernel-secrets.json` 不存在，`resolveKey`（`ui/desktop/src/utils/agentKernel.ts:206-228`）四级回退全部落空；
  2. 回退链第 4 级（读 `secrets.yaml`）在 Windows 默认配置下**结构性失效**——goose 密钥默认写系统凭据管理器，`secrets.yaml` 仅 `GOOSE_DISABLE_KEYRING` 时存在（`crates/goose/src/config/base.rs:89-91`）；
  3. 编辑 provider 流程不落密钥：`ProviderGrid.tsx:298` 编辑时 `api_key: ''`，`CustomProviderForm.tsx:456-458` 允许留空提交，`agentKernelCapture.ts:7-9` 空值静默 return；
  4. 无「已有密钥」查询 IPC，UI 无法区分"goose 有密钥、副本缺失"与"彻底没配"；
  5. 保存后不自愈：`agentKernel.ts:342-378` `refresh()` 在 `active===null` 时不重新 provision、不清 `status.error`。
- **修法**（全 TS，不动 Rust，见提交 `fix(agent-kernel): ...`）：
  - `status` 新增 `hasCapturedKey` + 新增 `hasProviderKey()`；`refresh` 改 async，`runtime!=='builtin' && !active` 时重新 `apply()` 自愈；
  - 编辑保存时经新 IPC 查询副本，缺失则派发 `AGENT_KERNEL_CHANGED` 事件；
  - AgentKernelSection 显示密钥副本状态 + 可操作补录指引（i18n 联动）。
- **验收**：单测（hasCapturedKey 生命周期 / 自愈 / 回归）+ 6 步 E2E（重放本机故障：不重启即 Ready、重启仍 Ready、编辑不回退、Forget 后回缺密钥态）。

### P0-2 仓库基线

- **现状**：分支 `modelforge`（领先 upstream/main 12 提交）；25 条未提交（vector_db PoC + agent.rs 修复 + 17 份过程文档）。构建产物 output/dist/.playwright-cli 已正确 gitignore（实测）。
- **修法**：本次文档整理后分 4 批提交（PoC / unwrap 修复 / 文档 / .gitignore），打 tag `p0-baseline`。
- **验收**：`git status` 归零；两仓库均有基线提交。

### P0-3 compile_latex 假成功（剩余四项）

- **现状**（`crates/goose-mcp/src/modeling/mod.rs`）：error 态（`5b11c67`）与 5 字节头校验已修；剩余：编译前不清旧产物 → 旧 PDF 冒充成功；失败/超时残留半成品；仅验 5 字节头；超时不杀进程树（latexmk→pdflatex 孙进程存活持锁）。
- **修法**：
  1. 编译前 `remove_file(pdf_path)`（best-effort）+ 记录 `started_at`；
  2. 失败/超时路径清残留；
  3. `validate_pdf(path, started_at)`：>1KB + mtime≥started + `%PDF-` 头 + 尾部 1KB 含 `%%EOF`；
  4. 超时杀进程树：改用 `process_wrap`（已有依赖，`subprocess.rs:43` 在用）Windows Job Object / Unix Session。
- **验收**：`cargo test -p goose-mcp modeling:: --lib` 通过（含新增校验用例 + `#[ignore]` 杀树用例）。

### P0-4 HTTP 凭据明文（剩余两处）

- **现状**：`extensions.rs:326-359` 敏感判定仅认 `env_keys` + 6 个硬编码头名 → 自定义认证头（如 `X-DeepSeek-Token`）仍明文；CLI `goose configure`（`configure.rs:1147-1171`）明文回显收集直写。
- **修法**：
  1. 抽 `is_sensitive_header_name()`（含 token/key/secret/auth/password/credential/cookie/session），扩展判定后沿用既有 `MODELFORGE_MCP_HEADER_<sha256>` 机制；
  2. CLI 敏感头改 `cliclack::password` + 复用 `try_store_secret`（`configure.rs:671-683`）存引用 + 注册 env_keys；
  3. 微项：`extensions.rs:321-324` regex 改 `OnceLock`。
- **验收**：`cargo check -p goose-cli`；手工 configure 后 config.yaml 无明文。

### P0-5 /plan 失败落盘 GOOSE_MODE=auto（复验）

- **现状**：修复已存在（`session/mod.rs:1507-1544` GooseModeGuard，先 restore 再传播错误），自证未独立复验。
- **复验**：用 `scripts/provider-error-proxy/` 注入 act 阶段失败 → 断言 a) `/mode` 恢复非 auto；b) config.yaml sha256 不变；c) 错误正常上抛。
- **产出**：`docs/reports/P0-5-plan-mode-verification.md`。

## 3. P1 清单（登记，P0 完成后按周计划节奏执行）

| # | 项 | 位置 | 备注 |
|---|----|------|------|
| 3.1 | Rust 故障面 7 条：子目录 hints 空 gitignore 泄 .env、持锁递归扫 skills 树、hints 重复膨胀、hook 超时孤儿进程、gateway 消息任务不可取消、Config 无缓存、pairing fsync 持锁 | `hints/load_hints.rs:130`、`agents/extension_manager.rs:1698`、`hooks/mod.rs:1050`、`gateway/telegram.rs:1061` 等 | 详见 fault-surface 报告，修复前逐条复验 |
| 3.2 | 引擎不匹配：latexmk 硬编码 `-pdf` 而模板需 xelatex；typst/tectonic 路径从未真跑 | `modeling/mod.rs:281` | 与 P0-3 同批处理 |
| 3.3 | 更新器两套配置指向不存在仓库/上游 | `utils/githubUpdater.ts:457-459`、`forge.config.ts` | 发布前必须解决 |
| 3.4 | 交付链路未跑通：make 未执行、release 未编、adapter 未进依赖、CLI 单平台、adapter settingSources 未隔离、合规需改首启下载 | `ui/desktop/package.json`、`prepare-platform-binaries.js` | 见 RUNTIME-PACKAGING-PLAN |
| 3.5 | 首启无国内推荐 provider | `components/onboarding/*` | 桌面端体验 |
| 3.6 | 状态机迁移硬前置：每 step 全量重载会话、thinking 双路径分歧 | `state_machine/session.rs:198`、`state_machine/inference.rs:105-121` | = Week 2 Track 1 |
| 3.7 | 桌面 9 条失败测试（全为上游 PRISTINE 文件，非本 fork 回归） | 5 个测试文件（desktopFileAccess 等） | 待 CI 定性 |
| 3.8 | 无 fork 自有 CI（docs:check/check-skills/brand:check 无自动触发） | `.github/workflows/` | 建自有远端后 |
| 3.9 | 双源码树漂移（robocopy 复制编译）；中文路径 + 缺 MSVC（mklink+BuildTools 方案未落地） | `build-kernel.ps1` | 方案就绪待收敛 |

## 4. P2/P3 清单（索引式）

| # | 项 | 来源 |
|---|----|------|
| 4.1 | 前端小项：check_env 双套实现、skillEnablement 路径校验/EXDEV、streaks DST、导入体积上限、extract_errors 偏宽、.TEX 大写替换 | 代码层审查 §2.5/3/4/5 |
| 4.2 | AUDIT 批次 2-4（getSnapshot 深拷贝、memo、虚拟化、bundle、取消语义、SQL、瞬时失败固化、CI 等） | PROJECT-AUDIT §9 |
| 4.3 | 待决文案/界面：deeplink 改名、主页样例题文案、102/104、cartopy 模板、catalog i18n、goose 残留路径、.disabled-by-default 死文件 | 优化审查 4.2/4.3 |
| 4.4 | 结构债：`include_dir!` 204MB 内容内核耦合、文档重叠失真（本次已部分解决） | 优化审查 §2/3.5 |
| 4.5 | 修复轮遗留：09:29-10:01 无记录开发（已归档溯源）、REPLICATION_PLAN 三待办、clippy -D warnings 不可达、debug shim 误开风险、密钥 raw base64 与易变 id | 重审 §3/P2 |
| 4.6 | 商业化差距（账号/积分/广场/协作/机器人/回溯/市场） | 差距审查 2.3/3，战略未决 |

## 5. 与 7 周计划（EXECUTION_LOG）的关系

- **本文档 = 计划源**：P0-P3 全清单、状态、验收标准在此维护；
- **EXECUTION_LOG = 流水账**：按周记录"做了什么/何时/结论"，Week 2 起追加；
- **冲突规则**：P0 插队优先（本次先修），P0 完成后回到 Week 2 四轨道（见 WEEK2_SUMMARY）；P1 清单与四轨道重叠项（如 3.6 状态机 = Track 1）按轨道走，不重复排期。

| Week 2 轨道 | 对应本节条目 |
|-------------|--------------|
| Track 1 状态机迁移 | §3.6 |
| Track 2 错误处理 | §4.2（AUDIT 错误处理相关项） |
| Track 3 Clone 优化 | §4.2（`agent.rs` clone 相关） |
| Track 4 Arc<Mutex> 规划 | 独立（规划文档产出） |

## 6. 验收与度量（命令清单）

- **Rust**（一律在 `E:\goose-build`，先 `build-kernel.ps1 -SyncOnly`）：
  - P0-3：`cargo test -p goose-mcp modeling:: --lib`
  - P0-4：`cargo check -p goose-cli`（+ `cargo test -p goose config` 若改公共 crate）
- **桌面端**（`ui/desktop`，`npx --yes pnpm@10.30.0`）：
  - P0-1：`vitest run src/utils/agentKernel.test.ts` + `typecheck` + `lint:check`（含 i18n）
- **E2E**：P0-1 六步重放（用现有内核，无需重建）；P0-5 用 `scripts/provider-error-proxy/`
- **证据落点**：`docs/reports/`（每 P0 一份验证记录）

## 7. 变更记录

| 日期 | 变更 | 备注 |
|------|------|------|
| 2026-09-16 | 建立本计划 v1；目录清理（顶层 + goose docs 归位）；WEEK2 六合一 | 见 `chore`/`docs` 提交 |
| 2026-09-16 | P0-2 基线固定（4 批提交 + tag `p0-baseline`） | 见 git log |
| 2026-09-16 | **P0-1 修复并验证**（自愈 refresh + 补录引导 + e2e 重放 22.6s 通过）；附带修复 e2e 基建 `17ddb51` | `52d60fc`，见 [验证记录](../reports/P0-1-verification.md) |
| 2026-09-16 | **P0-3 修复并验证**（清旧产物 + 杀进程树实测 + PDF 四重校验，真 latexmk 集成测试通过） | `d0e56ec`，见 [验证记录](../reports/P0-3-verification.md) |
