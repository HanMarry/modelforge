# ModelForge 优化计划（v2）

> **本文件是 ModelForge 的唯一执行计划**（规格需求 24.1）。仓库里其他计划类文档（复刻计划、周计划、专项方案）只作背景或历史参考，状态一律以本文件为准。执行流水见 [EXECUTION_LOG.md](EXECUTION_LOG.md)；Week 2 四轨道框架见 [WEEK2_SUMMARY.md](WEEK2_SUMMARY.md)。
> 建立于 2026-09-16，依据六份审查报告 + PROJECT-AUDIT 45 项 + 本日实测对账；2026-09-28 按需求 24 统一为下述字段格式（v2）。

## 0. 摘要与状态板

**一句话**：技术外壳与领域内容已对齐甚至反超对标产品 MathModel；当前阻碍不在"能不能做建模"，而在 **API Key 保存链路阻断内核启动**、工程基线未固定、若干已修未复验项。本计划按 P0（阻断，立即修）→ P1（高优先，随后排期）→ P2/P3（清理与战略项）推进。

### 0.1 条目字段约定（需求 24）

- 表头含「编号」列的表格都是计划条目表，每行一项，编号全文唯一。其他表格（如 §5 对照表、§7 变更记录）不是条目表。
- 每项必填：owner、状态、源码 commit、验证时间、验证命令、证据路径、剩余风险。单独的 `-`、`—`、`TBD`、`待定` 视为未填。还没有提交或验证的条目要写明原因，例如"无（未开始）""未验证"。
- 状态只能取：未开始、进行中、已完成、已验证、已阻塞。
- 标"已验证"的条目还要满足：源码 commit 给出完整 SHA 或至少 7 位前缀，且在 `modelforge` 分支历史中可达；验证命令用反引号写出，可以原样复制执行；执行环境写明操作系统与架构（如 Windows x64）；验证时间用 ISO 8601（如 `2026-09-16` 或 `2026-09-28T08:28:42Z`）。未合入 `modelforge` 的条目最多标"已完成"。
- 证据路径：用反引号写相对仓库根目录的路径（可带 `:行号`），或写相对本文件的 Markdown 链接；路径必须存在于仓库中。
- 校验：`node ui/desktop/scripts/plan-check.js`（只读）。CI 工作流 `.github/workflows/modelforge-gates.yml` 在 push 到 `modelforge` 以及指向 `modelforge` 的 PR 上执行；任何其他文件声称自己是"当前执行计划"而不指向本文件，同样判为失败。

### 0.2 P0 条目

| 编号 | 项 | owner | 状态 | 源码 commit | 验证时间 | 验证命令 | 执行环境 | 证据路径 | 剩余风险 |
|------|----|-------|------|-------------|----------|----------|----------|----------|----------|
| P0-1 | API Key 保存静默失效。验收：保存 key 后不重启即 Ready；重启后仍 Ready；编辑 provider 不回退 | leozer534-coder | 已验证 | `52d60fc`（配套 e2e 基建 `17ddb51`） | 2026-09-16 | `npx vitest run src/utils/agentKernel.test.ts`（`ui/desktop/`，26/26）；`npx playwright test tests/e2e/agent-kernel-key-recovery.spec.ts`（`ui/desktop/`，真实应用重放 1 passed） | Windows x64（本机） | [P0-1 验证记录](../reports/P0-1-verification.md)、`ui/desktop/tests/e2e/agent-kernel-key-recovery.spec.ts` | 开发模式需 `GOOSE_BINARY` 指向本机 goose.exe；打包后的内核查找归交付链路（3.4） |
| P0-2 | 仓库基线未固定（改动未提交）。验收：两仓库 `git status` 归零 + tag `p0-baseline` | leozer534-coder | 已完成 | `4a7bdc4`（tag `p0-baseline`，4 批提交的最后一批） | 2026-09-16 | `git status --porcelain`（当时输出为空）；`git rev-parse "p0-baseline^{commit}"`（附注标签，指向 `4a7bdc4`；标签只在本机仓库，未推送到 origin） | Windows x64（本机） | `.gitignore`（基线最后一批提交修正的文件）；过程见 §7 变更记录 | 没有单独的验证记录，所以不标"已验证"；外层工作区仓库的基线不在本仓库，这里无法核对 |
| P0-3 | compile_latex 假成功（残留/超时/校验）。验收：定向测试通过：清旧产物、杀进程树、PDF 四重校验 | leozer534-coder | 已验证 | `d0e56ec` | 2026-09-16 | `cargo test -p goose-mcp modeling::`（8 passed / 3 ignored）；`cargo test -p goose-mcp modeling::tests -- --ignored`（3 passed） | Windows x64（本机 `E:\goose-build`，GNU 工具链） | [P0-3 验证记录](../reports/P0-3-verification.md)、`crates/goose-mcp/src/modeling/mod.rs` | Unix 的进程组杀树分支只做了编译检查，尚未在 Unix 上实跑 `timeout_terminates_the_whole_process_tree` |
| P0-4 | HTTP 凭据明文（自定义头 + CLI configure）。验收：config.yaml 无明文（自定义头 + CLI 路径） | leozer534-coder | 已验证 | `072f711` | 2026-09-16 | `cargo test -p goose --lib utils::`（37 passed）；`cargo test -p goose --lib acp::`（334 passed）；`cargo check -p goose-cli` | Windows x64（本机 `E:\goose-build`，GNU 工具链） | [P0-4 验证记录](../reports/P0-4-verification.md)、`crates/goose/src/utils.rs`、`crates/goose-cli/src/commands/configure.rs` | `goose configure` 的交互路径需要 TTY，未自动化；自定义 Provider 的 `collect_custom_headers` 同类问题见 4.7 |
| P0-5 | /plan 失败永久落盘 GOOSE_MODE=auto。验收：独立重放：/mode 恢复、config sha256 不变、错误上抛 | leozer534-coder | 已验证 | `1600180` | 2026-09-16 | `cargo test -p goose-cli --lib session::`（190 passed；另 3 条既有的环境敏感失败与本项无关） | Windows x64（本机 `E:\goose-build`，GNU 工具链） | [P0-5 验证记录](../reports/P0-5-plan-mode-verification.md)、`crates/goose-cli/src/session/mod.rs` | 交互式端到端重放受 TTY 限制未自动化，靠静态证据链与回归测试覆盖 |

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

> **2026-09-16 晚追加批次**（用户指令「把产品的毛病修好」）：本清单已修复并独立复验——3.2 latexmk 引擎适配 ✅、3.3 更新器占位仓库（优雅降级 + 单点配置）✅、fault-surface #1 hints 泄 .env（高危安全）✅、vector_db PoC 坏提交治理 ✅、桌面 6 条负载型超时 ✅、fmt 债清零 ✅。逐项证据见 [docs/reports/PRODUCT-FIXES-20260916-verification.md](../reports/PRODUCT-FIXES-20260916-verification.md)。下表未逐行改写，未提及项照旧。

| 编号 | 项（位置；备注） | owner | 状态 | 源码 commit | 验证时间 | 验证命令 | 执行环境 | 证据路径 | 剩余风险 |
|------|------------------|-------|------|-------------|----------|----------|----------|----------|----------|
| 3.1 | Rust 故障面 7 条：子目录 hints 空 gitignore 泄 .env、持锁递归扫 skills 树、hints 重复膨胀、hook 超时孤儿进程、gateway 消息任务不可取消、Config 无缓存、pairing fsync 持锁（`hints/load_hints.rs:130`、`agents/extension_manager.rs:1698`、`hooks/mod.rs:1050`、`gateway/telegram.rs:1061` 等；详见 fault-surface 报告，修复前逐条复验） | leozer534-coder | 进行中 | `6d32b6c`（只修了 #1 hints 泄 .env） | 2026-09-16（只含 #1） | `cargo test -p goose hints --lib`（`TMP`/`TEMP` 指向没有 `.git` 祖先的目录，44/44） | Windows x64（本机） | [产品修复批次验收记录](../reports/PRODUCT-FIXES-20260916-verification.md)、`crates/goose/src/hints/load_hints.rs`、`crates/goose/src/agents/extension_manager.rs`、`crates/goose/src/hooks/mod.rs`、`crates/goose/src/gateway/telegram.rs` | #2–#7 未修；fault-surface 报告在外层工作区 `docs/reports/`，不在本仓库 |
| 3.2 | 引擎不匹配：latexmk 硬编码 `-pdf` 而模板需 xelatex；typst/tectonic 路径从未真跑（`modeling/mod.rs:281`；与 P0-3 同批处理） | leozer534-coder | 已验证 | `61068ba` | 2026-09-16 | `cargo test -p goose-mcp modeling --lib`（11 passed）；`cargo test -p goose-mcp modeling --lib -- --ignored`（ctexart 中文正文真实编译 1 passed） | Windows x64（本机 `E:\goose-build`，GNU 工具链） | [产品修复批次验收记录](../reports/PRODUCT-FIXES-20260916-verification.md)、`crates/goose-mcp/src/modeling/mod.rs` | typst 与 tectonic 路径仍未真跑 |
| 3.3 | 更新器两套配置指向不存在仓库/上游（`utils/githubUpdater.ts:457-459`、`forge.config.ts`；发布前必须解决） | leozer534-coder | 进行中 | `7d25f53`（未配置时优雅降级 + 单点配置） | 2026-09-16 | `npx vitest run src/utils/githubUpdater.check.test.ts src/utils/githubUpdater.target.test.ts`（`ui/desktop/`，10/10） | Windows x64（本机） | [产品修复批次验收记录](../reports/PRODUCT-FIXES-20260916-verification.md)、`ui/desktop/src/utils/githubUpdater.ts` | 真实发布仓库与更新源尚未建立（需求 7.9），更新通道没有真机验证 |
| 3.4 | 交付链路未跑通：make 未执行、release 未编、adapter 未进依赖、CLI 单平台、adapter settingSources 未隔离、合规需改首启下载（`ui/desktop/package.json`、`prepare-platform-binaries.js`；见外层工作区 RUNTIME-PACKAGING-PLAN） | leozer534-coder | 进行中 | `0e1f4ad`（打包链路初版）；Codex 运行时随包 `73da093` 尚未合入 `modelforge` | 未验证 | 未定：Windows 打包由 `package-windows.yml`（`workflow_dispatch`）执行，验收命令随规格需求 7 确定 | Windows x64（CI 打包，尚未完整跑通） | `ui/desktop/package.json`、`ui/desktop/scripts/prepare-platform-binaries.js`、`.github/workflows/package-windows.yml` | 安装包从未在干净机器上完成四项流程冒烟（需求 7.2–7.4） |
| 3.5 | 首启无国内推荐 provider（`components/onboarding/*`；桌面端体验） | leozer534-coder | 已验证 | `7dbada6` | 2026-09-16 | `npx vitest run src/components/onboarding/providerOrdering.test.ts`（`ui/desktop/`，3 passed） | Windows x64（本机） | [产品修复批次验收记录](../reports/PRODUCT-FIXES-20260916-verification.md)、`ui/desktop/src/components/onboarding/providerOrdering.ts` | 首启「推荐」分组标签（需要新文案）未做，记为可选后续 |
| 3.6 | 状态机迁移硬前置：每 step 全量重载会话、thinking 双路径分歧（`state_machine/session.rs:198`、`state_machine/inference.rs:105-121`；= Week 2 Track 1） | leozer534-coder | 未开始 | 无（未开始） | 未验证 | 未定；对照测试由规格任务 7（需求 4）提供 | 未验证 | `crates/goose/src/agents/state_machine/session.rs`、`crates/goose/src/agents/state_machine/mod.rs` | 当前代码里已没有 `state_machine/inference.rs`，行号需在动手前重新定位；默认路径仍是 `agent.rs` |
| 3.7 | 桌面 9 条失败测试（全为上游 PRISTINE 文件，非本 fork 回归）；另有 goose-cli 3 条环境敏感失败（thinking_effort/home-dir，测试读真实用户配置未隔离）（5 个测试文件（desktopFileAccess 等）+ goose-cli session 测试；待 CI 定性） | leozer534-coder | 进行中 | `d992bdd`（6 条负载型超时补 15000ms） | 2026-09-16 | `pnpm exec vitest run`（`ui/desktop/`，948 passed / 0 failed / 17 skipped） | Windows x64（本机） | [产品修复批次验收记录](../reports/PRODUCT-FIXES-20260916-verification.md)、`ui/desktop/src/components/settings/providers/modal/subcomponents/forms/CustomProviderForm.test.tsx` | 桌面端已清零；goose-cli 3 条读真实用户配置的测试仍未隔离 |
| 3.8 | 无 fork 自有 CI（docs:check/check-skills/brand:check 无自动触发）（`.github/workflows/`；建自有远端后） | leozer534-coder | 已完成 | `632b3dc`（规格任务 5.5，见 §6.1 MP-5） | 2026-09-28T15:10:00Z | `node scripts/build-brand-vector.js --check`、`node scripts/docs-check.js --check`、`node scripts/check-skills.js --check`（`ui/desktop/`）；[Gates run 36441357316](https://github.com/HanMarry/modelforge/actions/runs/36441357316) | GitHub Actions：Linux x64 | `.github/workflows/modelforge-gates.yml`、`.github/workflows/ci.yml` | 门禁尚未合入 `modelforge`，目前只在指向 `feat/mathmodel-parity` 的 PR 上运行 |
| 3.9 | 双源码树漂移（robocopy 复制编译）；中文路径 + 缺 MSVC（mklink+BuildTools 方案未落地）（`build-kernel.ps1`；方案就绪待收敛） | leozer534-coder | 未开始 | 无（未开始） | 未验证 | 未定；由规格任务 4.5（`/MIR` 与 dirty 判定）承接 | 未验证 | `build-kernel.ps1` | 开发构建仍可能混入已删除的文件，产物来源不可追溯（需求 3.3、3.4） |

## 4. P2/P3 清单（索引式）

> 来源报告除 PROJECT-AUDIT 与 P0-4 验证记录外都在外层工作区 `docs/reports/`，不在本仓库，所以证据路径指向仓库内的相关代码或文档。

| 编号 | 项（来源） | owner | 状态 | 源码 commit | 验证时间 | 验证命令 | 执行环境 | 证据路径 | 剩余风险 |
|------|------------|-------|------|-------------|----------|----------|----------|----------|----------|
| 4.1 | 前端小项：check_env 双套实现、skillEnablement 路径校验/EXDEV、streaks DST、导入体积上限、extract_errors 偏宽、.TEX 大写替换（代码层审查 §2.5/3/4/5） | leozer534-coder | 未开始 | 无（未开始） | 未验证 | 未定（随修复方案确定） | 未验证 | `ui/desktop/src/utils/skillEnablement.ts`、`crates/goose-mcp/src/modeling/mod.rs` | 均为低频边界问题，暂无用户可见故障报告 |
| 4.2 | AUDIT 批次 2-4（getSnapshot 深拷贝、memo、虚拟化、bundle、取消语义、SQL、瞬时失败固化、CI 等）（PROJECT-AUDIT §9） | leozer534-coder | 未开始 | 无（未开始） | 未验证 | 未定（随修复方案确定） | 未验证 | `PROJECT-AUDIT-20260915.md` | 性能结论来自静态审查，没有实测数据 |
| 4.3 | 待决文案/界面：deeplink 改名、主页样例题文案、102/104、cartopy 模板、catalog i18n、goose 残留路径、.disabled-by-default 死文件（优化审查 4.2/4.3） | leozer534-coder | 未开始 | 无（未开始） | 未验证 | 未定（随修复方案确定） | 未验证 | `ui/desktop/src/components/settings/extensions/deeplink.ts`、`ui/desktop/src/catalog/homePresets.ts` | 主页真题卡片的文案随规格任务 6 调整，其余项待定 |
| 4.4 | 结构债：`include_dir!` 204MB 内容内核耦合、文档重叠失真（本次已部分解决）（优化审查 §2/3.5） | leozer534-coder | 未开始 | 无（未开始） | 未验证 | 未定（随修复方案确定） | 未验证 | `crates/goose/src/skills/builtin.rs` | 赛题移出内核二进制由规格任务 6（MP-6）处理，内容与内核的整体解耦尚未开始 |
| 4.5 | 修复轮遗留：09:29-10:01 无记录开发（已归档溯源）、REPLICATION_PLAN 三待办、clippy -D warnings 不可达、debug shim 误开风险、密钥 raw base64 与易变 id（重审 §3/P2） | leozer534-coder | 未开始 | 无（未开始） | 未验证 | 未定（随修复方案确定） | 未验证 | `REPLICATION_PLAN.md`、`ui/desktop/src/utils/agentKernel.ts` | 密钥 raw base64 由规格需求 2（任务 3）处理，其余项待定 |
| 4.6 | 商业化差距（账号/积分/广场/协作/机器人/回溯/市场）（差距审查 2.3/3，战略未决） | leozer534-coder | 未开始 | 无（战略未决） | 未验证 | 不适用（战略决策项，没有代码验收） | 未验证 | `REPLICATION_PLAN.md` | 战略方向未定，部分能力由规格第 2 阶段覆盖 |
| 4.7 | provider `collect_custom_headers`（`configure.rs`）明文写入 `custom_providers.json`——P0-4 修复时发现的同类项，需对齐 provider 配置的引用机制后处理（P0-4 验证记录 §4） | leozer534-coder | 未开始 | 无（未开始） | 未验证 | 未定；由规格任务 2.14 承接 | 未验证 | [P0-4 验证记录](../reports/P0-4-verification.md)、`crates/goose-cli/src/commands/configure.rs` | CLI 新增的自定义 Provider 认证头仍可能明文写入配置 |

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

## 6.1 规格任务：mathmodel-parity-and-beyond

> 规格与任务清单在工作区 `.kiro/specs/mathmodel-parity-and-beyond/`（不在本仓库）。工作分支 `feat/mathmodel-parity`，经草稿 PR [#1](https://github.com/HanMarry/modelforge/pull/1) 在 CI 验证。条目合入 `modelforge` 前状态最多为"已完成"；合入后 commit 在 `modelforge` 历史中可达，才改为"已验证"（需求 24.2）。字段含义见 §0.1。

| 编号 | 项 | owner | 状态 | 源码 commit | 验证时间 | 验证命令 | 执行环境 | 证据路径 | 剩余风险 |
|------|----|-------|------|-------------|----------|----------|----------|----------|----------|
| MP-1 | 规格任务 1：敏感值掩码与原子写的共享基础（Property 7、10） | leozer534-coder | 已完成 | `113bb32` | 2026-09-28T08:28:42Z | `cargo test --locked -- --skip scenario_tests::scenarios::tests`（`crates/`）；`pnpm run lint:check && pnpm run test:run`（`ui/desktop/`）；[CI run 36395525305](https://github.com/HanMarry/modelforge/actions/runs/36395525305) | GitHub Actions：Rust 为 Linux x64，桌面端为 macOS arm64 | `crates/goose/src/logging/secret_mask.rs`、`crates/goose/src/config/atomic_fs.rs`、`ui/desktop/src/utils/secretMask.test.ts`、`ui/desktop/src/utils/atomicWrite.test.ts`、`fixtures/secret-mask-vectors.json` | CI 中 Windows Rust 编译 job 被跳过，`atomic_fs` 在 Windows 上的 rename 重试路径尚未实跑；尚未合入 `modelforge` |
| MP-2 | 规格任务 2（需求 1 认证请求头安全存储）：2.1–2.16 全部完成。Rust 侧（A）：`secret_headers`、`provider_credentials`、`credential_migration`、`extension_credentials`、日志掩码、CLI 敏感头（Property 1–6）；桌面端（F）：ACP 敏感请求头契约 `sensitive_headers`/`stored_secret_headers`、`SECRET_UNRESOLVED` 错误透传、CustomProviderForm 敏感开关与已保存值掩码 | leozer534-coder | 已完成 | `3cbff48`、`4847053` | 2026-09-29（CI 验证中） | `cargo test --locked -- --skip scenario_tests::scenarios::tests`（`crates/`）；`pnpm run lint:check && pnpm run test:run`（`ui/desktop/`） | GitHub Actions：Linux x64 + macOS arm64 | `crates/goose/src/config/{secret_headers,provider_credentials,credential_migration,extension_credentials}.rs`、`crates/goose/src/logging/redact.rs`、`ui/desktop/src/components/settings/providers/modal/subcomponents/forms/sensitiveHeaders.ts` | 上游测试 `test_extension_manager_tools_available` 在 native-tls job 偶发 flaky（重跑通过），非本任务回归；尚未合入 `modelforge` |
| MP-3 | 规格任务 3（需求 2 桌面端凭据存储）：3.1–3.8 全部完成。`CredentialStore`（加密不可用只存内存、raw 条目逐条迁移、损坏只读）、`credential-*` IPC、设置页状态展示、electron-log 掩码（Property 8/9/11） | leozer534-coder | 已完成 | `b760e7e`、`47e2dc0`、`c299729` | 2026-09-29（CI 验证中） | `pnpm run lint:check && pnpm run test:run`（`ui/desktop/`） | GitHub Actions：macOS arm64 | `ui/desktop/src/utils/credentialStore.ts`、`ui/desktop/src/utils/credentialIpc.ts`、`ui/desktop/src/utils/logRedaction.ts` | 尚未合入 `modelforge` |
| MP-4 | 规格任务 4（需求 3 构建来源可追溯）：4.1–4.6 全部完成。内核内嵌构建信息 + `goose version --json`、`buildManifest` 纯函数与 Property 12、发布流水线 `release:build`、dev 构建 `robocopy /MIR`、构建集成测试 | leozer534-coder | 已完成 | `1a92f8a`、`51e4f2b`、`0b362a2`、`dfa5670` | 2026-09-29（CI 验证中） | `cargo test --locked -- --skip scenario_tests::scenarios::tests`（`crates/`）；`pnpm run test:run`（`ui/desktop/`，含 `buildManifest.test.ts`） | GitHub Actions：Linux x64 + macOS arm64 | `crates/goose-cli/build.rs`、`ui/desktop/src/utils/buildManifest.ts`、`ui/desktop/scripts/release/build-release.mts` | Windows 发布打包未实跑（`build-release.ps1` 依赖 MinGW 环境）；尚未合入 `modelforge` |
| MP-7 | 规格任务 7（需求 4 状态机对照测试集）：7.1–7.5 全部完成。对照框架（ScriptedProvider、双路径 `run_both`）、归一化/比较/报告、Property 13、10 维度用例、默认路径守卫 + JSON 报告 + `parity-history` 累积 | leozer534-coder | 已完成 | `336725f`、`2701294`、`b2b28ef`、`968bc8e`、`38c35e8` | 2026-09-29 | `cargo test --locked -p goose --lib state_machine_parity_report -- --ignored --nocapture` | GitHub Actions：Linux x64 | `crates/goose/src/agents/state_machine/tests/parity/`、`.github/workflows/modelforge-sm-parity.yml` | 对照发现 **107 处真实差异**（legacy 与状态机的 usage/message_usage 事件顺序与用量序列化 `total_tokens` vs `totalTokens` 不一致），属状态机迁移的长期工作、暂缓（需求范围约束）；parity workflow 因此按需求 4.7 失败，作为非阻塞参考信号；尚未合入 `modelforge` |
| MP-5 | 规格任务 5（需求 24 计划与 CI 门禁）：5.1 `docs-check`、`check-skills` 的 `--check` 只读模式（`check-mode.js` 拦截写文件）；5.2 `plan-check`；5.3 Property 53；5.4 本计划统一为 §0.1 的字段格式，其他计划类文档改为指向本计划；5.5 `modelforge-gates` 工作流 | leozer534-coder | 已完成 | `3db06b4`、`c19cf7a`、`b987790`、`b7e65a0`、`800cb10`、`632b3dc` | 2026-09-28T15:10:00Z | `node scripts/build-brand-vector.js --check`、`node scripts/docs-check.js --check`、`node scripts/check-skills.js --check`（`ui/desktop/`）；`pnpm run test:run`（`ui/desktop/`，含 `scripts/plan-check.test.js`、`scripts/strip-safety.test.js`）；[Gates run 36441357316](https://github.com/HanMarry/modelforge/actions/runs/36441357316)、[CI run 36441357705](https://github.com/HanMarry/modelforge/actions/runs/36441357705) | GitHub Actions：门禁为 Linux x64，桌面端测试为 macOS arm64 | `ui/desktop/scripts/plan-check.js`、`ui/desktop/scripts/plan-check.test.js`、`ui/desktop/scripts/check-mode.js`、`.github/workflows/modelforge-gates.yml` | 门禁目前只在指向 `feat/mathmodel-parity` 的 PR 上跑过，push 到 `modelforge` 的触发要等合入后才能观察；冲突计划只扫描 Markdown 文件；尚未合入 `modelforge` |
| MP-6 | 规格任务 6（需求 9.6、7.1 移出随内核分发的授权不明赛题）：6.1 15 个赛题文件移出仓库与安装包，本机副本放在 git 忽略的 `ui/desktop/resources/builtin-examples/`，首页真题卡片找不到副本时显示官方来源与下载指引；6.2 `builtin.rs` 单元测试与 `check-skills` 赛题检测 | leozer534-coder | 已完成 | `04d5e44`、`bbac44f` | 2026-09-28T15:10:00Z | `cargo test --locked -- --skip scenario_tests::scenarios::tests`（`crates/`，含 `skills::builtin::tests`）；`node scripts/check-skills.js --check`（`ui/desktop/`）；[CI run 36441357705](https://github.com/HanMarry/modelforge/actions/runs/36441357705) | GitHub Actions：Rust 为 Linux x64，桌面端为 macOS arm64 | `crates/goose/src/skills/builtin.rs`、`ui/desktop/scripts/check-skills.js`、`ui/desktop/src/components/Hub.tsx`、`ui/desktop/src/catalog/homePresets.ts` | git 历史中仍有这些赛题文件（是否改写历史待用户决定）；华数杯官网链接未确认，卡片显示"待确认"；卡片缺副本时的提示没有组件测试；Windows 打包未重跑；尚未合入 `modelforge` |

## 7. 变更记录

| 日期 | 变更 | 备注 |
|------|------|------|
| 2026-09-16 | 建立本计划 v1；目录清理（顶层 + goose docs 归位）；WEEK2 六合一 | 见 `chore`/`docs` 提交 |
| 2026-09-16 | P0-2 基线固定（4 批提交 + tag `p0-baseline`） | 见 git log |
| 2026-09-16 | **P0-1 修复并验证**（自愈 refresh + 补录引导 + e2e 重放 22.6s 通过）；附带修复 e2e 基建 `17ddb51` | `52d60fc`，见 [验证记录](../reports/P0-1-verification.md) |
| 2026-09-16 | **P0-3 修复并验证**（清旧产物 + 杀进程树实测 + PDF 四重校验，真 latexmk 集成测试通过） | `d0e56ec`，见 [验证记录](../reports/P0-3-verification.md) |
| 2026-09-16 | **P0-4 修复并验证**（自定义认证头识别扩展 + CLI configure 密钥化，测试 37+334 通过） | `072f711`，见 [验证记录](../reports/P0-4-verification.md) |
| 2026-09-16 | **P0-5 独立复验**（静态证据链 + 现场无残留 + 190 回归通过；交互重放受 TTY 限制，步骤文档化） | `1600180` 已修，见 [验证记录](../reports/P0-5-plan-mode-verification.md) |
| 2026-09-16 | **P0 五项全部完成** ✅（P0-1/3/4 修复验证，P0-2 基线，P0-5 复验） | 下一步：按 §5 回到 Week 2 四轨道 / P1 清单 |
| 2026-09-28 | 新增 §6.1，登记规格 mathmodel-parity-and-beyond 的任务进度；MP-1（任务 1）CI 通过，状态"已完成" | `113bb32`，CI run 36395525305 |
| 2026-09-28 | MP-2 登记：任务 2.1–2.4 CI 通过（首轮 `c104da1` 的 fmt 差一行，`e6a7c06` 修正；首轮 rustls-tls job 中 `command_auth` 测试偶发 "Text file busy"，与本改动无关，次轮通过） | CI run 36411008845 |
| 2026-09-28 | 计划 v2：全文条目统一为 §0.1 的字段格式，由 `plan-check` 校验（任务 5.4）；登记 MP-5（任务 5）、MP-6（任务 6），经草稿 PR [#3](https://github.com/HanMarry/modelforge/pull/3) 的 CI 通过，状态"已完成" | Gates run 36441357316，CI run 36441357705 |
