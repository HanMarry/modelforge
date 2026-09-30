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

> 规格与任务清单在工作区 `.kiro/specs/mathmodel-parity-and-beyond/`（不在本仓库）。工作分支 `feat/mathmodel-parity`，第 0 阶段经草稿 PR [#1](https://github.com/HanMarry/modelforge/pull/1)、第 1 阶段经 PR [#8](https://github.com/HanMarry/modelforge/pull/8) 在 CI 验证；第 2 阶段分层并行，经 PR #9–#15、#17–#27 逐个验证后合入，合入后的整体由跟踪 PR [#16](https://github.com/HanMarry/modelforge/pull/16) 验证。条目合入 `modelforge` 前状态最多为"已完成"；合入后 commit 在 `modelforge` 历史中可达，才改为"已验证"（需求 24.2）。字段含义见 §0.1。

| 编号 | 项 | owner | 状态 | 源码 commit | 验证时间 | 验证命令 | 执行环境 | 证据路径 | 剩余风险 |
|------|----|-------|------|-------------|----------|----------|----------|----------|----------|
| MP-1 | 规格任务 1：敏感值掩码与原子写的共享基础（Property 7、10） | leozer534-coder | 已验证 | `113bb32` | 2026-09-28T08:28:42Z | `cargo test --locked -- --skip scenario_tests::scenarios::tests`（`crates/`）；`pnpm run lint:check && pnpm run test:run`（`ui/desktop/`）；[CI run 36395525305](https://github.com/HanMarry/modelforge/actions/runs/36395525305) | GitHub Actions：Rust 为 Linux x64，桌面端为 macOS arm64 | `crates/goose/src/logging/secret_mask.rs`、`crates/goose/src/config/atomic_fs.rs`、`ui/desktop/src/utils/secretMask.test.ts`、`ui/desktop/src/utils/atomicWrite.test.ts`、`fixtures/secret-mask-vectors.json` | CI 中 Windows Rust 编译 job 被跳过，`atomic_fs` 在 Windows 上的 rename 重试路径尚未实跑 |
| MP-2 | 规格任务 2（需求 1 认证请求头安全存储）：2.1–2.16 全部完成。Rust 侧（A）：`secret_headers`、`provider_credentials`、`credential_migration`、`extension_credentials`、日志掩码、CLI 敏感头（Property 1–6）；桌面端（F）：ACP 敏感请求头契约 `sensitive_headers`/`stored_secret_headers`、`SECRET_UNRESOLVED` 错误透传、CustomProviderForm 敏感开关与已保存值掩码 | leozer534-coder | 已验证 | `3cbff48`、`4847053` | 2026-09-29T03:06:29Z | `cargo test --locked -- --skip scenario_tests::scenarios::tests`（`crates/`）；`pnpm run lint:check && pnpm run test:run`（`ui/desktop/`） | GitHub Actions：Linux x64 + macOS arm64 | `crates/goose/src/config/secret_headers.rs`、`crates/goose/src/config/credential_migration.rs`、`crates/goose/src/config/extension_credentials.rs`、`crates/goose/src/logging/redact.rs`、`ui/desktop/src/components/settings/providers/modal/subcomponents/forms/sensitiveHeaders.ts` | 上游测试 `test_extension_manager_tools_available` 在 native-tls job 偶发 flaky（重跑通过），非本任务回归 |
| MP-3 | 规格任务 3（需求 2 桌面端凭据存储）：3.1–3.8 全部完成。`CredentialStore`（加密不可用只存内存、raw 条目逐条迁移、损坏只读）、`credential-*` IPC、设置页状态展示、electron-log 掩码（Property 8/9/11） | leozer534-coder | 已验证 | `b760e7e`、`47e2dc0`、`c299729` | 2026-09-29T03:06:29Z | `pnpm run lint:check && pnpm run test:run`（`ui/desktop/`） | GitHub Actions：macOS arm64 | `ui/desktop/src/utils/credentialStore.ts`、`ui/desktop/src/utils/credentialIpc.ts`、`ui/desktop/src/utils/logRedaction.ts` | 桌面端 CI 仅在 macOS arm64 上验证，Windows 上 safeStorage 加密路径未实跑 |
| MP-4 | 规格任务 4（需求 3 构建来源可追溯）：4.1–4.6 全部完成。内核内嵌构建信息 + `goose version --json`、`buildManifest` 纯函数与 Property 12、发布流水线 `release:build`、dev 构建 `robocopy /MIR`、构建集成测试 | leozer534-coder | 已验证 | `1a92f8a`、`51e4f2b`、`0b362a2`、`dfa5670` | 2026-09-29T03:06:29Z | `cargo test --locked -- --skip scenario_tests::scenarios::tests`（`crates/`）；`pnpm run test:run`（`ui/desktop/`，含 `buildManifest.test.ts`） | GitHub Actions：Linux x64 + macOS arm64 | `crates/goose-cli/build.rs`、`ui/desktop/src/utils/buildManifest.ts`、`ui/desktop/scripts/release/build-release.mts` | Windows 发布打包未实跑（`build-release.ps1` 依赖 MinGW 环境） |
| MP-7 | 规格任务 7（需求 4 状态机对照测试集）：7.1–7.5 全部完成。对照框架（ScriptedProvider、双路径 `run_both`）、归一化/比较/报告、Property 13、10 维度用例、默认路径守卫 + JSON 报告 + `parity-history` 累积 | leozer534-coder | 已验证 | `336725f`、`2701294`、`b2b28ef`、`968bc8e`、`38c35e8` | 2026-09-29T03:06:29Z | `cargo test --locked -p goose --lib state_machine_parity_report -- --ignored --nocapture` | GitHub Actions：Linux x64 | `crates/goose/src/agents/state_machine/tests/parity/`、`.github/workflows/modelforge-sm-parity.yml` | 对照发现 **107 处真实差异**（legacy 与状态机的 usage/message_usage 事件顺序与用量序列化 `total_tokens` vs `totalTokens` 不一致），属状态机迁移的长期工作、暂缓（需求范围约束）；parity workflow 因此按需求 4.7 失败，作为非阻塞参考信号 |
| MP-5 | 规格任务 5（需求 24 计划与 CI 门禁）：5.1 `docs-check`、`check-skills` 的 `--check` 只读模式（`check-mode.js` 拦截写文件）；5.2 `plan-check`；5.3 Property 53；5.4 本计划统一为 §0.1 的字段格式，其他计划类文档改为指向本计划；5.5 `modelforge-gates` 工作流 | leozer534-coder | 已验证 | `3db06b4`、`c19cf7a`、`b987790`、`b7e65a0`、`800cb10`、`632b3dc` | 2026-09-28T15:10:00Z | `node scripts/build-brand-vector.js --check`、`node scripts/docs-check.js --check`、`node scripts/check-skills.js --check`（`ui/desktop/`）；`pnpm run test:run`（`ui/desktop/`，含 `scripts/plan-check.test.js`、`scripts/strip-safety.test.js`）；[Gates run 36441357316](https://github.com/HanMarry/modelforge/actions/runs/36441357316)、[CI run 36441357705](https://github.com/HanMarry/modelforge/actions/runs/36441357705) | GitHub Actions：门禁为 Linux x64，桌面端测试为 macOS arm64 | `ui/desktop/scripts/plan-check.js`、`ui/desktop/scripts/plan-check.test.js`、`ui/desktop/scripts/check-mode.js`、`.github/workflows/modelforge-gates.yml` | 门禁目前只在指向 `feat/mathmodel-parity` 的 PR 上跑过，push 到 `modelforge` 的触发要等合入后才能观察；冲突计划只扫描 Markdown 文件 |
| MP-9 | 规格任务 9（需求 6 诊断中心）：9.1–9.9 全部完成。四类探测并行（单类 60 秒上限，Property 15）、构建来源、报告导出（掩码 + 原子写）、`/diagnostics` 页面；另显示自动快照使用的 git 来源 | leozer534-coder | 已完成 | `13363ae`（合入）、`4f5ca9a`、`e8b5c0f` | 2026-09-29T10:49:20Z | `pnpm run lint:check && pnpm run test:run`（`ui/desktop/`）；[CI run 36556145900](https://github.com/HanMarry/modelforge/actions/runs/36556145900) | GitHub Actions：macOS arm64 | `ui/desktop/src/utils/diagnostics/diagnosticsService.ts`、`ui/desktop/src/components/diagnostics/DiagnosticsView.tsx` | 未合入 `modelforge`；只在 macOS 上跑过，Windows 上的 Python/LaTeX 探测未实跑 |
| MP-10 | 规格任务 10（需求 8 赛事页）：10.1–10.10 完成（10.11 可选组件测试未写）。赛事数据与排序筛选（Property 16、17）、URL 白名单（Property 27）、事务式创建 Project（Property 18）；创建后直接在项目面板打开 | leozer534-coder | 已完成 | `d192a37`（合入）、`15688a6`、`e8b5c0f` | 2026-09-29T10:49:20Z | `pnpm run lint:check && pnpm run test:run`（`ui/desktop/`）；[CI run 36556145900](https://github.com/HanMarry/modelforge/actions/runs/36556145900) | GitHub Actions：macOS arm64 | `ui/desktop/src/catalog/competitions.json`、`ui/desktop/src/catalog/competitionRules.ts`、`ui/desktop/src/utils/projects/projectService.ts` | 未合入 `modelforge`；8 项赛事的日期与官网未逐一对照官方来源核实，4 项官网为空 |
| MP-11 | 规格任务 11（需求 9 示例题库）：11.1–11.10 全部完成。清单加载与打包过滤（Property 19）、3 道原创题与 3 份真题清单、目录名去重（Property 21）、复制完整性（Property 20）；首页真题卡片改为跳转示例题库并删除 `copy-builtin-example` | leozer534-coder | 已完成 | `d192a37`（合入）、`15688a6`、`e8b5c0f`、`ea0e0bf` | 2026-09-29T11:52:00Z | `pnpm run lint:check && pnpm run test:run`（`ui/desktop/`）；[CI run 36567811027](https://github.com/HanMarry/modelforge/actions/runs/36567811027) | GitHub Actions：macOS arm64 | `ui/desktop/src/utils/examples/exampleCatalog.ts`、`ui/desktop/resources/examples`、`ui/desktop/src/components/examples/ExamplesView.tsx`、`ui/desktop/src/catalog/homePresets.ts` | 未合入 `modelforge`；11.11 可选组件测试未写；真题的题面与附件不随包，本机副本的导入要用户自己放进项目目录 |
| MP-12 | 规格任务 12（需求 5 首启向导）：12.1–12.6 全部完成。四步流转与密钥校验（Property 14）、连通测试、环境检测、第 4 步示例题 → 创建 Project → 首页打开 | leozer534-coder | 已完成 | `13363ae`（合入）、`4f5ca9a`、`e8b5c0f` | 2026-09-29T10:49:20Z | `pnpm run lint:check && pnpm run test:run`（`ui/desktop/`）；[CI run 36556145900](https://github.com/HanMarry/modelforge/actions/runs/36556145900) | GitHub Actions：macOS arm64 | `ui/desktop/src/components/onboarding/OnboardingWizard.tsx`、`ui/desktop/src/components/onboarding/wizardMachine.ts` | 未合入 `modelforge`；第 4 步没有组件测试 |
| MP-13 | 规格任务 13（需求 7 Windows 安装包）：13.1–13.5、13.7–13.12 完成（NSIS 安装包、随包 MinGit 与 Codex 运行时、发布方元数据、打包内容校验、卸载时询问是否保留数据、缺失运行时提示）；13.6 严格冒烟现已覆盖 7.2–7.5、7.10：中文带空格路径安装、首次配置（严格模式，配置由向导自己写进内核）、普通对话、Python 执行、论文编译、phase-2 入口、升级保留数据、静默/保留/删除三种卸载，以及新建中文带空格的本地用户整轮；四个主场景 primary/upgrade/uninstall/cn-user 均零失败 | leozer534-coder | 进行中 | `0357faaee`（`feat/mathmodel-parity` 当前头部） | 2026-10-01T05:22:00Z | `gh workflow run package-windows.yml --ref feat/mathmodel-parity`；`gh workflow run modelforge-windows-smoke.yml --ref feat/mathmodel-parity -f package_run_id=<打包 run id>` | GitHub Actions：windows-latest | `.github/workflows/modelforge-windows-smoke.yml`、`ui/desktop/tests/e2e/windows-installed-smoke.spec.ts`、`ui/desktop/tests/e2e/windows-smoke/`、打包 run 36758684946、冒烟 run 36774508039 | 13.6 仍未收口：cn-user 拆出的卸载场景里「交互式卸载选删除数据」一条会让 Playwright worker 以 0xC0000409 退出（跨 4 轮 5/5 次尝试稳定复现，分进程与重试都无效，Windows 事件日志无 Application Error、node 也没写致命错误报告），而同一条产品路径在 runneradmin 的卸载场景 3/3 通过，判定为测试基础设施/宿主环境问题；按现状勾 13.6、缩小 cn-user 的卸载覆盖还是继续在 Windows 上排障，待用户决定。安装器曾在早期轮次出现两次 0xC0000005 崩溃（已加一次重试，其后未再现）；MinGit 2.56.0 的运行时目录名变了，已改为在 mingw64/ucrt64/clang64 中探测 |
| MP-14 | 规格任务 14（需求 10 数据集页）：14.1–14.6 完成；14.7 部分完成 | leozer534-coder | 进行中 | `d192a37`（合入）、`15688a6`、`e8b5c0f` | 2026-09-29T10:49:20Z | `pnpm run lint:check && pnpm run test:run`（`ui/desktop/`）；[CI run 36556145900](https://github.com/HanMarry/modelforge/actions/runs/36556145900) | GitHub Actions：macOS arm64 | `ui/desktop/src/utils/datasets/selectDataFiles.ts`、`ui/desktop/src/utils/datasetIpc.ts`、`ui/desktop/src/components/datasets/DatasetsView.tsx` | “生成数据说明”只预填输入框，不直接发往当前会话、没有执行状态与重试（14.7）；14.8 可选组件测试未写；`fs.watch` 递归监听在 Linux 上依赖 Node 的实现，未在 Windows 上实跑 |
| MP-15 | 规格任务 15（需求 11 项目版本回溯）：15.1–15.8 全部完成。影子仓库自动快照、Kernel 写前守卫 `_goose/unstable/session/checkpoint/ensure`、恢复与回滚、版本面板“自动快照”页签（Property 24–26） | leozer534-coder | 已完成 | `574e8e4`（合入）、`5bf41ed`、`15688a6`、`e8b5c0f` | 2026-09-29T10:49:20Z | `cargo test --locked -- --skip scenario_tests::scenarios::tests`（`crates/`）；`pnpm run lint:check && pnpm run test:run`（`ui/desktop/`）；[CI run 36556145900](https://github.com/HanMarry/modelforge/actions/runs/36556145900) | GitHub Actions：Rust 为 Linux x64，桌面端为 macOS arm64 | `ui/desktop/src/utils/checkpoints/checkpointService.ts`、`crates/goose/src/acp/server/checkpoint.rs`、`ui/desktop/src/components/workspace/AutoCheckpointsTab.tsx` | 未合入 `modelforge`；超过 100 个快照后每轮都要重写 100 个提交并 gc，Windows 上可能逼近 Kernel 等待快照的 10 秒上限；快照 id 每次裁剪后都会变 |
| MP-16 | 规格任务 16（需求 12 内置浏览器面板）：16.1–16.6 全部完成。文本截断（Property 28）、`WebContentsView` 面板、仅回环 + 随机 token + Host 校验的浏览器 MCP 服务、点击与输入逐次审批 | leozer534-coder | 已完成 | `30a64bf`（合入） | 2026-09-29T10:49:20Z | `pnpm run lint:check && pnpm run test:run`（`ui/desktop/`）；[CI run 36556145900](https://github.com/HanMarry/modelforge/actions/runs/36556145900) | GitHub Actions：macOS arm64 | `ui/desktop/src/utils/textTruncate.ts`、`ui/desktop/src/utils/browser/browserPanelHost.ts`、`ui/desktop/src/utils/browser/browserMcpServer.ts` | 未合入 `modelforge`；浏览器 MCP 服务与 Kernel 的端到端调用没有自动化测试 |
| MP-17 | 规格任务 17（需求 13 本地作品展示）：17.1–17.7 全部完成。分享包排除规则与元数据校验（Property 29、30）、导出导入、远程只读作品源 | leozer534-coder | 已完成 | `30a64bf`（合入） | 2026-09-29T10:49:20Z | `pnpm run lint:check && pnpm run test:run`（`ui/desktop/`）；[CI run 36556145900](https://github.com/HanMarry/modelforge/actions/runs/36556145900) | GitHub Actions：macOS arm64 | `ui/desktop/src/utils/gallery/shareFilter.ts`、`ui/desktop/src/utils/gallery/galleryService.ts`、`ui/desktop/src/components/gallery/GalleryView.tsx` | 未合入 `modelforge`；作品判定仍是“有论文 PDF 即作品”的临时规则，待第 2 阶段 22.10 切换 |
| MP-18 | 规格任务 18（需求 14 局域网协作）：18.1–18.8 完成（18.9 可选集成测试未写）。邀请码、访问控制、批注同步（Property 31–33）、房主从当前 Project 选共享文件、写回限定在 Project 根目录 | leozer534-coder | 已完成 | `399d792`（合入）、`15688a6`、`e8b5c0f` | 2026-09-29T10:49:20Z | `pnpm run lint:check && pnpm run test:run`（`ui/desktop/`）；[CI run 36556145900](https://github.com/HanMarry/modelforge/actions/runs/36556145900) | GitHub Actions：macOS arm64 | `ui/desktop/src/utils/collab/collabService.ts`、`ui/desktop/src/utils/collab/collabDoc.ts`、`ui/desktop/src/components/collab/CollabHostPanel.tsx` | 未合入 `modelforge`；两台机器之间的真实局域网连接（TLS 指纹核对、bonjour 发现）未实测 |
| MP-19 | 规格任务 19（需求 15 飞书入口）：19.1–19.4、19.7 完成；19.5、19.6 未接线 | leozer534-coder | 进行中 | `399d792`（合入）、`e8b5c0f` | 2026-09-29T10:49:20Z | `pnpm run lint:check && pnpm run test:run`（`ui/desktop/`，含 routing/progressThrottle/replyFormat 测试）；[CI run 36556145900](https://github.com/HanMarry/modelforge/actions/runs/36556145900) | GitHub Actions：macOS arm64 | `ui/desktop/src/connectors/feishu/feishuConnector.ts`、`ui/desktop/src/connectors/feishu/feishuSdkAdapter.ts` | 飞书长连接为空实现、主进程 ACP 连接直接抛错、权限请求未转发、Kernel 侧不读拒绝原因，飞书入口目前不可用；19.8 可选集成测试未写 |
| MP-6 | 规格任务 6（需求 9.6、7.1 移出随内核分发的授权不明赛题）：6.1 15 个赛题文件移出仓库与安装包，本机副本放在 git 忽略的 `ui/desktop/resources/builtin-examples/`，首页真题卡片找不到副本时显示官方来源与下载指引；6.2 `builtin.rs` 单元测试与 `check-skills` 赛题检测 | leozer534-coder | 已验证 | `04d5e44`、`bbac44f` | 2026-09-28T15:10:00Z | `cargo test --locked -- --skip scenario_tests::scenarios::tests`（`crates/`，含 `skills::builtin::tests`）；`node scripts/check-skills.js --check`（`ui/desktop/`）；[CI run 36441357705](https://github.com/HanMarry/modelforge/actions/runs/36441357705) | GitHub Actions：Rust 为 Linux x64，桌面端为 macOS arm64 | `crates/goose/src/skills/builtin.rs`、`ui/desktop/scripts/check-skills.js`、`ui/desktop/src/components/Hub.tsx`、`ui/desktop/src/catalog/homePresets.ts` | git 历史中仍有这些赛题文件（是否改写历史待用户决定）；华数杯官网链接未确认，卡片显示"待确认"；卡片缺副本时的提示没有组件测试；Windows 打包未重跑 |
| MP-21 | 规格任务 21（需求 16 结构化运行记录）：21.1–21.8 全部完成。共享 schema 与双侧 fixture（Property 36–38）、独立 crate `goose-run-record`（原子写、凭据替换）、modeling `run_script` 与 RunRecorder（Property 51）、developer shell 记录 python/Rscript/matlab 命令、运行开始与结束的 ACP 通知、桌面端 `runs-list` | leozer534-coder | 已完成 | `97a0fb3`（#9）、`93460fc`（#12）、`dec64e8`（#18）、`c4738ac`（#19）、`2fc8626`（#24）、`90ccc89`（#25） | 2026-09-29T23:22:44Z | `cargo test --locked -- --skip scenario_tests::scenarios::tests`（`crates/`）；`pnpm run lint:check && pnpm run test:run`（`ui/desktop/`）；[PR #25](https://github.com/HanMarry/modelforge/pull/25) 的 CI | GitHub Actions：Rust 为 Linux x64，桌面端为 macOS arm64 | `schemas/run-record.schema.json`、`crates/goose-run-record/src/run_record.rs`、`crates/goose-run-record/src/run_recorder.rs`、`crates/goose-mcp/src/modeling/run_script.rs`、`crates/goose/src/agents/platform_extensions/developer/shell_run_record.rs`、`crates/goose/src/acp/server/runs.rs`、`ui/desktop/src/utils/runRecord.ts` | 凭据来源尚未接入（`SecretValues` 默认不提供）；`compile_latex` 不写 Run_Record；modeling 未做路径 NFC 规范化；developer shell 只识别单条计算命令 |
| MP-22 | 规格任务 22（需求 17 产物状态与过期检测）：22.1–22.11 全部完成。状态转换、标记已验证、过期检测纯函数（Property 39–42）；按 (size, mtime) 缓存的哈希快照、`artifacts.json` 原子写与文件监听；Project 面板状态徽标与详情；广场改用 Artifact_Status | leozer534-coder | 已完成 | `59fa7e7`（#10）、`90ccc89`（#25） | 2026-09-29T23:22:44Z | `pnpm run lint:check && pnpm run test:run`（`ui/desktop/`）；[PR #25](https://github.com/HanMarry/modelforge/pull/25) 的 CI | GitHub Actions：macOS arm64 | `ui/desktop/src/utils/artifactStatus.ts`、`ui/desktop/src/utils/runs/artifactStore.ts`、`ui/desktop/src/components/workspace/ProjectPanel.tsx` | 论文 PDF 只有经 `run_script` 编译才会"已生成"，广场可能为空；记录写入时换了后缀或损坏时，对应条目停在"执行中" |
| MP-23 | 规格任务 23（需求 18 论文交付检查）：23.1–23.11 全部完成。问题编号覆盖、数值四舍五入比较、PDF 新鲜度（含本地模板）、图表标注、参考文献（Crossref）、匿名性（Property 43–46）；只读运行器与检查面板 | leozer534-coder | 已完成 | `a16b05c`（#13）、`4ecad58`（#20） | 2026-09-29T22:00:17Z | `pnpm run lint:check && pnpm run test:run`（`ui/desktop/`）；[PR #20](https://github.com/HanMarry/modelforge/pull/20) 的 CI | GitHub Actions：macOS arm64 | `ui/desktop/src/utils/paperCheck/paperCheckRunner.ts`、`ui/desktop/src/components/workspace/PaperCheckPanel.tsx` | 位图图表列为"无法检查"；Crossref 请求不走系统代理；pdfjs 在 utilityProcess 中的打包运行未在安装包上验证 |
| MP-24 | 规格任务 24（需求 21 方案对比）：24.1–24.4 全部完成。对比表纯函数（Property 49）、`runs-compare` IPC、对比面板与"生成对比段落"（120 秒超时） | leozer534-coder | 已完成 | `6eb0e16`（#11）、`09b1b96`（#21） | 2026-09-29T21:11:48Z | `pnpm run lint:check && pnpm run test:run`（`ui/desktop/`）；[PR #21](https://github.com/HanMarry/modelforge/pull/21) 的 CI | GitHub Actions：macOS arm64 | `ui/desktop/src/utils/runCompare.ts`、`ui/desktop/src/components/workspace/RunComparePanel.tsx` | 发送对比任务的逻辑复制自对话输入框，那边改动时要同步 |
| MP-25 | 规格任务 25（需求 22 中断恢复）：25.1–25.5 全部完成。恢复规划纯函数（Property 50）、步骤记录耐中断（Property 51）、modeling 任务计划工具、Kernel 恢复流程与覆盖确认、桌面端恢复提示 | leozer534-coder | 已完成 | `6eb0e16`（#11）、`93460fc`（#12）、`c4738ac`（#19）、`264fa00`（#26） | 2026-09-29T22:00:38Z | `cargo test --locked -- --skip scenario_tests::scenarios::tests`（`crates/`）；`pnpm run lint:check && pnpm run test:run`（`ui/desktop/`）；[PR #26](https://github.com/HanMarry/modelforge/pull/26) 的 CI | GitHub Actions：Rust 为 Linux x64，桌面端为 macOS arm64 | `ui/desktop/src/utils/resumePlanner.ts`、`crates/goose-run-record/src/task_plan.rs`、`crates/goose-mcp/src/modeling/task_plan.rs`、`crates/goose/src/acp/server/task_resume.rs`、`ui/desktop/src/components/resume/TaskResumePrompt.tsx` | Kernel 用结构体字面量复制 `GooseAcpAgent`，新增字段时要同步；"记录缺失"一类原因尚未把产物置为过期；每次恢复新建一个会话 |
| MP-26 | 规格任务 26（需求 19 模拟评审）：26.1–26.6 全部完成。内置技能 `mathmodel_mock_review`、评审校验与对比（Property 47）、评审记录原子写入、评审面板（免责声明固定可见） | leozer534-coder | 已完成 | `ae9dcf6`（#14）、`6fa9e53`（#22） | 2026-09-29T22:00:26Z | `node scripts/check-skills.js --check`、`pnpm run lint:check && pnpm run test:run`（`ui/desktop/`）；[PR #22](https://github.com/HanMarry/modelforge/pull/22) 的 CI | GitHub Actions：macOS arm64 | `crates/goose/src/skills/builtins/mathmodel_mock_review.md`、`ui/desktop/src/utils/review/reviewModel.ts`、`ui/desktop/src/components/workspace/ReviewPanel.tsx` | 国赛与 COMAP 的评分细则未核实原文；Kernel 请求工具授权时面板无法批准，评审会失败；每次评审在会话列表里留下一条会话 |
| MP-27 | 规格任务 27（需求 20 学习路径）：27.1–27.7 全部完成。课程数据与关联技能校验、练习完成判定与进度（Property 48）、确定性与主观检查、学习模式（会话 `extension_data` 与系统提示）、学习页面 | leozer534-coder | 已完成 | `ae9dcf6`（#14）、`c4738ac`（#19）、`30474b5`（#27） | 2026-09-29T21:13:21Z | `cargo test --locked -- --skip scenario_tests::scenarios::tests`（`crates/`）；`pnpm run lint:check && pnpm run test:run`（`ui/desktop/`）；[PR #27](https://github.com/HanMarry/modelforge/pull/27) 的 CI | GitHub Actions：Rust 为 Linux x64，桌面端为 macOS arm64 | `ui/desktop/src/catalog/learning-path.json`、`ui/desktop/src/utils/learning/progress.ts`、`crates/goose/src/acp/server/learning_mode.rs`、`ui/desktop/src/components/learning/LearningView.tsx` | 学习模式是提示词软约束，只能靠评测抽样衡量；主观项评阅会在会话列表里短暂出现临时会话 |
| MP-28 | 规格任务 28（需求 23 建模评测集）：28.1–28.5 全部完成。3 道原创题的 task、checks、baseline，评测汇总与预算门（Property 52），运行器 `run.mts`（确认、预算、结果附 Build_Manifest），学习模式抽样检测 | leozer534-coder | 已完成 | `fbf210f`（#15）、`0b02b1d`（#23） | 2026-09-29T21:37:08Z | `pnpm run lint:check && pnpm run test:run`（`ui/desktop/`）；[PR #23](https://github.com/HanMarry/modelforge/pull/23) 的 CI | GitHub Actions：macOS arm64 | `evals/modeling/run.mts`、`ui/desktop/src/utils/evals/evalSummary.ts` | 共享单车题有 3 项参考值取决于作答口径，为 null；学习模式样例自带规则副本，应改为读取 Kernel 的提示词文件 |
| MP-29 | 规格任务 29（第 2 阶段验收）：跟踪 PR 全量 CI 通过；首次真实评测在 GitHub 上完成并把结果入库 | leozer534-coder | 已完成 | `248fc9b64`（合入 `61bbe989b`）；评测 run `36742998780` | 2026-10-01T02:26:52Z | `gh pr checks 40 --repo HanMarry/modelforge`；`gh run view 36742998780 --repo HanMarry/modelforge` | GitHub Actions：CI 为 Linux x64 与 macOS arm64，评测为 ubuntu-latest | `evals/modeling/results/20260930T173512Z.json` | 3 道题共通过 13 项、无「未通过」项，另有 14 项 `method: manual` 的「待人工」需人工对照 PDF 判定；只跑了 `deepseek-v4-pro` 一个模型（未跑 `deepseek-flash`）；未合入 `modelforge` 前最多标「已完成」 |
| MP-30 | PR #40 的四项产品修复与两项配置修正：① 默认关闭 playwright 扩展并锁定 `@playwright/mcp@0.0.83`（全新机器上它要先下载 Node，把新建会话卡住）；② `initial_session_extensions` 总是连接客户端传入的 `mcpServers`，内置浏览器工具由此真正进入会话；③ 浏览器 MCP 服务每个请求用独立的 server 与 transport（无状态传输复用会抛错）；④ 解压内置技能资源前先建目标目录（全新机器上脚本与模板从未解压出来）；另把 DeepSeek 模型列表改成 `deepseek-flash`/`deepseek-v4-pro`/`deepseek-v4-flash`，冒烟脚本新增「浏览器工具确实送达模型」断言、恢复提示用例不再被启动清理关掉、安装程序崩溃时重跑一次 | leozer534-coder | 已完成 | `248fc9b64`（合入 `61bbe989b`） | 2026-10-01T02:26:52Z | `gh pr checks 40 --repo HanMarry/modelforge`；`cargo test --locked -- --skip scenario_tests::scenarios::tests`（`crates/`，即 CI 的 Build and Test Rust Project）；`pnpm run test:run`（`ui/desktop/`，即 CI 的 Test and Lint Electron Desktop App） | GitHub Actions：Rust 为 Linux x64，桌面端为 macOS arm64 | `crates/goose/src/acp/server.rs`、`crates/goose/src/skills/builtin.rs`、`ui/desktop/src/utils/browser/browserMcpServer.ts`、`ui/desktop/src/components/settings/extensions/bundled-extensions.json`、`crates/goose-providers/src/declarative/definitions/deepseek.json`、`ui/desktop/tests/e2e/windows-installed-smoke.spec.ts` | 浏览器工具是否真的送达模型、以及实机安装/升级/卸载/中文用户场景，要靠 13.6 的 Windows 冒烟实跑确认；状态机对照仍按需求 4.7 预期失败 |

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
| 2026-09-29 | 第 0 阶段完成：6 条并行分支（D/C/B/F/A/E）全部合入 `feat/mathmodel-parity`，主 CI 全绿（含 flaky 测试确定性修复 `0b09e38`），Gates 门禁通过；`feat/mathmodel-parity` 合入 `modelforge`，MP-1~7 状态改为"已验证" | 主 CI run 36514484061 |
| 2026-09-29 | 第 1 阶段：6 条 S1 分支合入 `feat/mathmodel-parity`（PR #8），修复合并后的锁文件、i18n、类型、eslint 与 vitest 失败及其暴露的实现缺陷，并补齐审计出的功能缺口；主 CI 全绿。登记 MP-9～MP-19：9、10、12、15～18 为"已完成"，11、13、14、19 仍有未完成子任务为"进行中" | 主 CI run 36556145900（`e8b5c0f`） |
| 2026-09-29 | 第 1 阶段续：首页真题卡片改为跳转示例题库并删除 `copy-builtin-example`（MP-11 转"已完成"）；卸载询问是否保留数据、运行环境面板提示缺失的可选运行时、修复 MinGit 2.56.0 运行时目录探测（MP-13 除冒烟场景外完成）。Windows 打包 workflow 首次在本分支跑通 | 主 CI run 36567811027（`1e0b443`）、打包 run 36563188235 |
| 2026-09-30 | 第 2 阶段：层 A（Run_Record 契约）、层 B（6 条纯逻辑分支）、层 C（C0 骨架 3 条 + C1 功能 8 条）共 18 个 PR 逐个经 CI 验证后合入 `feat/mathmodel-parity`；登记 MP-21～MP-28 为"已完成"，MP-29（第 2 阶段验收）为"进行中"，首次评测待用户提供模型与预算 | 跟踪 PR #16 |
| 2026-10-01 | PR #40 合入 `feat/mathmodel-parity`（`61bbe989b`）：新建会话不再被 playwright 扩展拖住、内置浏览器工具真正进入会话、浏览器 MCP 服务每请求独立处理、全新机器能解压技能资源、DeepSeek 模型名更新；登记 MP-30 | CI run 36743006209（除状态机对照外全绿） |
| 2026-10-01 | 首次真实评测完成并入库：`evals/modeling/results/20260930T173512Z.json`（3 道题共通过 13 项、0 项未通过、14 项待人工；预算 4,059,890/40,000,000；commit `248fc9b64`、dirty=false、traceable=true；学习模式 3 个样例 0 标记）；MP-29 转"已完成" | 评测 run 36742998780；独立复核报告另存工作区 `.scratch/verify-36742998780/VERIFY.md` |
| 2026-10-01 | Windows 冒烟：从 `feat` 打包（run 36758684946）并跑严格冒烟，四个主场景 primary/upgrade/uninstall/cn-user 全部零失败，内置浏览器工具送达模型、phase-2「未完成的任务」恢复提示、新建中文带空格用户整轮三项确认；修掉冒烟的遥测弹窗竞态与 flaky 判定 bug，cn-user 改为每个 spec 一个 node 进程并补 node 致命错误报告；MP-13 更新为当前状态，13.6 仍未收口（见该条剩余风险） | 冒烟 run 36774508039、PR #42（`0357faaee`） |
