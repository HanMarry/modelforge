# Goosey

Put `goosey` in your $PATH if you want to launch via:

```
goosey .
```

This will open goose GUI from any path you specify

# Unregister Deeplink Protocols (macos only)

`unregister-deeplink-protocols.js` is a script to unregister the deeplink protocol used by goose like `goose://`.
This is handy when you want to test deeplinks with the development version of Goose.

# Usage

To unregister the deeplink protocols, run the following command in your terminal:
Then launch Goose again and your deeplinks should work from the latest launched goose application as it is registered on startup.

```bash
node scripts/unregister-deeplink-protocols.js
```

---

# ModelForge 脚本索引

本仓库自有的脚本（其余为上游 goose 原有）。都通过 `pnpm run <name>` 调用；
**本机 pnpm 若低于 `package.json` 要求的 10.30，`pnpm run` 会直接拒绝执行**，
此时用 `npx pnpm@10.30.0 run <name>`。

## 品牌

| 脚本 | 作用 |
|---|---|
| `build-brand-mark.js` | 从 `modelforge-logo.png` 拟合标记几何 → `src/brand-mark.json`（唯一真源，带 IoU 自检） |
| `build-brand-icons.js` | 生成各尺寸位图：`icon.png`/`@2x`/`-512`/`.ico`/`.icns`/托盘模板图 |
| `build-brand-vector.js` | 由真源渲染 `icon.svg` 与 `ModelForge.tsx`（`--check` 用于 CI 比对） |
| `rebrand-i18n.js` / `rebrand-source.js` / `rename-hints-message-ids.js` / `sort-i18n.js` | 去 Goose 化与文案维护的批处理工具 |

## 论文模板（`papers:*`）

| 脚本 | 作用 |
|---|---|
| `assets:extract` | **从本机已安装的 MathModel 产品提取全部内容资产**（论文模板、图库模板与 90 张预览、draw.io 工具包、doctor/paper-search/data-search 脚本、skill-creator、PDF.js）；`--include-fonts` 取 29 个商业字体（测试必需，发布前要剥离），`--include-examples` 取三套真题 |
| `strip-unshippable` | **测试版 ↔ 可分发版开关**：默认只列清单，`--write` 删除字体 + 真题 + 许可未声明的 9 套模板（当前 177 文件），并保留 8 套许可清晰的模板 |
| `adopt-product-skills` | **采用产品的 12 个 SKILL.md 正文**，并把本 fork 需要的全部替换（技能名、目录、提问方式、品牌、`~/.claude/skills`、`data-search` 的浏览器一节）统一施加——替换表就在脚本里，改动可逐条复核 |
| `patch-extracted-scripts` | 给取来的 9 个 Python 脚本加 UTF-8 控制台守卫（幂等）。**这是真 bug 修复**：Windows 控制台是 GBK 时它们打印中文会崩，`roadmap_5band.py` 更是在写 `.drawio` 之前就崩，渲染成功看起来像失败 |
| `papers:templates` | 生成/校对模板骨架（与预览脚本共用同一份目录清单） |
| `build-paper-previews.js` | **在系统临时目录里**编译每套模板并渲染首页预览 → `src/assets/papers/<dir>.png`；产物不落回技能目录 |
| `papers:catalog` | 从各模板的 `template.json` 生成 `src/catalog/papers.ts`（含封面字段与 `defaultFor`） |
| `vendor-paper-templates.js` | 重新拉取 MIT/Apache 的上游模板文件 |

## 科研绘图（`figures:*`）

| 脚本 | 作用 |
|---|---|
| `build-figures.js` | 跑 14 个自建模板出图（PDF + PNG）并同步到应用侧 |
| `build-mathmodel-figures.js` | 渲染 `mathmodel_figure_templates` 技能里 90 个模板的预览（cartopy 缺失时**跳过**而不是报错） |
| `generate-figures-catalog.js` | 生成 `src/catalog/figures.ts`（两个系列，每条带 `skill` + 相对该技能目录的 `script`，以及分类标签） |

## 校验（每次改动都要跑）

| 脚本 | 作用 |
|---|---|
| `check-skills.js` | 内置技能 frontmatter 与 agentskills 规范（名称模式、描述 ≤1024 字符） |
| `docs-check.js` | ① 从文件系统推导计数并与四份文档核对；② **校验技能正文、目录文件、主页预设引用的资产是否真实存在**——包括"技能让 agent 去跑的脚本"与"正文链接的参考文档" |
| `check-connectors.js` | 对每条连接器发真实 MCP `initialize` + `tools/list`（`node scripts/check-connectors.js arxiv` 可单测一条） |
| `i18n-check.js` / `i18n-validate-locale.js` / `i18n-translations.js` | 文案与源码一致、各语言完整、新文案补翻译 |
| `verify-mac-update-resources.js` / `generate-mac-update-manifest.js` | 打包前的 macOS 更新资源核对 |

> `check-connectors.js` 有两个 Windows 坑，都已修：① 必须**直接 spawn**（经 `cmd.exe` 时
> `--with mcp<2` 的 `<` 会被当成重定向）；② Node 20.12+ 拒绝无 shell 地 spawn `.cmd`，
> 所以 `npx` 改为经 npm 的 `npx-cli.js` 启动，且单个连接器启动失败不再让整体崩溃。
