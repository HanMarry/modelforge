# 产品毛病修复批次 — 验收记录（2026-09-16）

> 批次口径：2026-09-16 晚，用户指令「把产品的毛病修好」。执行方式：Claude Code 多智能体小队（team `modelforge-fix`，Manager-Workers 模式，编排思路借鉴用户在用开源项目 AgentTeams）。
> 工作树状态：**已归档**（2026-09-16 晚，8 个提交 `7d25f53..f1553f4`，tag `product-fixes-20260916`）；归档前实测 +541/−162（43 改 + 4 新增）。

## 一句话结论

7 项产品问题全部修复并独立复验：桌面全量测试 **948 通过 / 0 失败 / 17 skipped**（此前基线存在 2 条失败）；tsc、i18n 全语言校验、`cargo fmt --all --check`、clippy 全绿；关闭一处高危安全面（子目录 hints 可读被 gitignore 的 `.env`）。

## 修复清单

| # | 问题 | 改动（file:line） | 验证证据（队长独立复跑） |
|---|------|------------------|--------------------------|
| 1 | 「检查更新」必然 404（占位仓库 `your-org`） | `ui/desktop/src/utils/githubUpdater.ts:460-473`（未配置早退 `status:'not-configured'`，不发请求、不报错）；`branding.ts:25-29` 单点常量；`autoUpdater.ts:78-81/:408-411` 手动/启动路径同处理；`preload.ts` 类型透传；`UpdateSection.tsx:222-346` 友好文案 + 按钮可点；`en/zh-CN.json` 新增 `updateSection.notConfigured`（另补 14 语言译文） | `vitest run githubUpdater.check.test.ts githubUpdater.target.test.ts` → **10/10 passed**；`tsc --noEmit` 0 |
| 2 | 中文模板编译失败（latexmk 硬编码 `-pdf`） | `crates/goose-mcp/src/modeling/mod.rs:323-324` 改 `latexmk_flag(&source)`；新增 `latexmk_flag`/`is_cjk`（:345-373）：magic comment 优先，其次 ctex/xeCJK/fontspec/setCJK/CJK 码点 → `-xelatex`；显式 engine 行为不变 | `cargo test -p goose-mcp modeling --lib` → **11 passed**；真实编译测试（`--ignored`）→ **1 passed / 8.91s**（ctexart 中文正文真出 PDF，过 `validate_pdf` 四重校验）；clippy `-D warnings` 0 告警 |
| 3 | 首启引导无国内模型推荐 | `ProviderSelector.tsx` 排序改走新文件 `providerOrdering.ts`：`custom_deepseek/zhipu/moonshot/alibaba/minimax/iflytek` 置顶（curated 序）→ Preferred → 字母序；新增 3 条单测 | 6 个 provider 名称与 `crates/goose-providers/src/declarative/definitions/*.json` 逐一核对（6/6）；`vitest run providerOrdering.test.ts` → 3 passed |
| 4 | 向量库 PoC 坏提交（编译失败 + 报告失实） | `vector_db/client.rs` 按 qdrant-client 1.19 builder API 全文重写；`embeddings.rs` 改 `TextInitOptions` + `&mut self`；`Cargo.toml:108-109` 补 `features=["serde"]`/`["hf-hub"]`；`vector_db_poc_report.md` 撤回「已准备好合并」，改为诚实状态 | `cargo check -p goose --features vector-db --lib` / 默认 `--lib` / `--features vector-db --tests` **全 exit 0** |
| 5 | 安全：子目录 hints 的 `@` 引用不过滤 .gitignore（高危，fault-surface #1） | `crates/goose/src/hints/load_hints.rs`：`load_new_hints:82` 构建一次 `build_gitignore(working_dir)` 传参；`load_hints_from_directory:120-133` 接收 `&Gitignore`、删 `Gitignore::empty()`；`:260` 全局 hints 同源缺口一并修；新增 2 个对称测试（:407/:1078） | **先复现**（修复前 2 FAILED，均读到 `SECRET_KEY=abc123`）→ 修复后 2 passed；hints 全量 **44/44**（干净 TMP）；关键语义回归 `test_global_agents_md_imports_not_filtered_by_project_gitignore` ok |
| 6 | 桌面测试 6 条负载型超时（上游文件，超时 5000ms 默认值） | `CustomProviderForm.test.tsx` 2 条 + `ExtensionModal.test.tsx` 3 条 + `RecipeFormFields.test.tsx` 1 条：各 `}, 15000)` | 负载复现（16/18 烧进程下 5000ms 超时）→ 修复后同负载单文件 9/9、7/7、57/57 pass；安静全量 **948/948** |
| 7 | 历史 fmt 债 | `cargo fmt --all`：`goose-cli/src/session/mod.rs:1513`、`goose-mcp/tests/latex_validation_test.rs:27`、goose 包 6 个遗留文件（纯格式化） | `cargo fmt --all --check` → **exit 0** |

## 最终基线（安静环境实测，2026-09-16 晚）

- 桌面单测：**948 passed / 0 failed / 17 skipped（965）**；Test Files 113 passed / 1 skipped（114）
- `pnpm exec tsc --noEmit` → 0（输出为空）
- i18n：`node scripts/i18n-check.js` → 0；`node scripts/i18n-validate-locale.js` → **15 locale × 1963 条全通过**
- Rust：`cargo fmt --all --check` → 0；`cargo clippy -p goose-mcp --lib -- -D warnings` → 0 告警；`cargo clippy -p goose --lib` → 仅 2 条既有告警（dead_code/unused_imports，与本次无关）
- Rust 测试：goose-mcp modeling 11 + 1（真编译）；goose hints 44/44（干净 TMP）

## 本机环境注意（新增一条）

- **hints 2 条测试在默认 TMP 下失败**：本机 bash TMP 映射到 `E:\cc-haha\.cache\tmp`，其祖先 `E:\cc-haha` 含 `.git`，`find_git_root` 从 TempDir 向上误判并放大 import 边界 → `test_hints_without_git_import_boundary`、`test_nested_goosehints_without_git_root` 失败。**非本批次引入**（对 HEAD `git stash` 复验同样失败）。跑法：`TMP=E:/mftmp TEMP=E:/mftmp cargo test -p goose hints --lib` → 44/44。建议记入《环境修复操作清单》。
- 既有约定不变：Rust 编译走 gnu 工具链 + `/e/goose-en` junction；桌面脚本用 `pnpm exec`（engines 门禁）。

## 未验证 / 遗留

- vector_db **运行时未验证**（未起 Qdrant 实例、未下载模型）；报告已如实标注「编译通过、运行时未验证」。
- 更新通道真机验证需待有真实发布仓库（设 `GITHUB_OWNER`/`GITHUB_REPO` 即自动启用真实检查）。
- 首启「推荐」分组标签（UI 增强，需新 i18n 文案）未做，记为可选后续。
- P1 清单其余项（fault-surface #2-7、交付链路打包、自有 CI、其他 UX 项）不在本批次范围。
- 归档提交建议：本批次与上游 diff 扩大到 ~46 文件，建议按「TS 修复 / Rust 修复 / i18n / 测试超时 / 文档」分 4-5 个语义化提交。

## 执行记录（agent teams）

Manager-Workers 模式：队长（team-lead）拆解、派活、独立复验；4 名队员并行执行：
- **updater**：T1 更新器 + T7 多语言补齐 + T9/T10 测试超时
- **latex**：T2 中文模板引擎 + T8 hints 安全修复
- **vectordb**：T3 向量库 PoC 治理
- **onboarding**：T4 首启推荐（含纯函数重构 + 单测）+ T6 测试定性 + T10 交叉

验收纪律：所有条目以「队长独立复跑原始输出」为准，队员报告仅作线索；未实测项一律显式标注。
