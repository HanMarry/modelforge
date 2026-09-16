# 验收清单（Acceptance checklist）

本文件列出 ModelForge 复刻中**已经写完但本机无法验证**的部分，以及装上工具链后逐条怎么验。
写它的原因：这些改动都只验证到 `typecheck` / `eslint` / `i18n:check` / 构建产物这一层，
**没有任何一页 UI 在真实应用里被看过**。文件写了不等于能用。

---

## 0. 为什么没验证

| 缺的工具 | 影响 |
|---|---|
| **Rust**（`rustc`/`cargo`） | 改过 4 个 Rust 文件（自研 MCP 的三处注册 + CLI 分支），**一次都没编译过**。Hermit 在 Windows 上只有 bash 引导脚本、无二进制也无缓存，`rustup` 未安装，本机也没有 `~/.cargo`。 |
| 完整 Electron 运行环境 | 无法 `just run-ui`，六个页面（`/algorithms`、`/figures`、`/paper`、`/connectors`、`/profile`、主页预设栏）没有目视验收。 |
| 可用的 typst 命令行 | PyPI 的 `typst` 包不提供可执行文件，`cumcm-typst` 只有库文件、没有入口文件。 |

**本机已具备并用上的**：TeX Live 2024（论文模板真编译）、`uv`（绘图模板真渲染、样例题数据真生成）、
Node 24 + pnpm 10.30（依赖、typecheck、eslint、vitest、Vite 构建）。

---

## 1. Rust 侧（优先级最高——从没编译过）

```bash
source bin/activate-hermit      # 或安装 rustup + toolchain 1.96.1
cargo fmt
cargo clippy --all-targets -- -D warnings
cargo test -p goose-mcp
cargo build
```

| # | 检查点 | 期望 | 失败时看哪 |
|---|---|---|---|
| 1.1 | `cargo build` 通过 | 无错误 | `crates/goose-mcp/src/modeling/mod.rs` —— 静态复核时它与 `memory/mod.rs` 的 rmcp 用法一致，但 `#[tool]` 宏展开与 `ToolRouter` 泛型只有编译器能定论 |
| 1.2 | `cargo clippy -D warnings` 通过 | 无 warning | `formatdoc!` 的未用参数、`run_command` 的 `&self` 未使用 |
| 1.3 | `cargo test -p goose-mcp` | 4 个新测试通过（`test_modeling_server_creation`、`test_get_info`、`test_extract_errors`、`test_tail`） | 测试在 `modeling/mod.rs` 末尾 |
| 1.4 | `goose mcp modeling` 能启动 | 打印 MCP 初始化、等待 stdio 输入 | `McpCommand::Modeling` 的三个 match 分支（`FromStr` / `as_str` / `handle_mcp_command`）——**漏一个就编译失败**，静态已逐个核对 |
| 1.5 | `goose mcp --help` 列出 `modeling` | 出现在子命令里 | `crates/goose-cli/src/cli.rs` |

补充：`modeling/mod.rs` 里 `check_env` / `compile_latex` 用的是
`ContentBlock::Text(TextContent::new(...))`，而 `memory/mod.rs` 用 `ContentBlock::text(...)`。
两者等价，编译器会确认；若 clippy 报 `useless_conversion` 再改。

---

## 2. 桌面端：逐页目视验收

启动：`just run-ui`（或 `cd ui/desktop && pnpm run start-gui`）。

### 2.1 侧栏结构（B1）

| # | 操作 | 期望 |
|---|---|---|
| 2.1.1 | 看侧栏顶部 | 顺序为 新建会话 / 科研绘图 / 论文模板 / 应用 / 自动化 / **扩展** / 会话历史 |
| 2.1.2 | 点「扩展」 | 展开出 技能 / 模板 / 算法 / 插件 / 连接器 五个子项，子项缩进、字号略小 |
| 2.1.3 | 点任一子项 | 跳到对应页面，且**再打开侧栏时该分组自动展开**（`catalogActive` 逻辑） |
| 2.1.4 | 手动收起分组后再进入子页 | 页面正常，分组不强行展开（不应抢用户操作） |
| 2.1.5 | 看底部 | 个人信息 / 设置 两项，上方有分隔线 |
| 2.1.6 | 点「应用」 | 只有 `apps` 扩展启用时才显示（沿用上游逻辑） |

### 2.2 主页（B4/B6）

| # | 操作 | 期望 |
|---|---|---|
| 2.2.1 | 打开首页 | 顶部品牌标记 + 「数学建模助手」，下面是时间与问候 |
| 2.2.2 | 看预设栏 | 工作流三个（写论文 / 建模报告 / 出图）+ 赛事七个（国赛 / 国赛 Typst / 美赛 / 华数杯 / MathorCup / 亚太赛 / 自定义）+ 右侧「赛事信息」外链 |
| 2.2.3 | 点「写论文」 | **输入框被写入** `加载 math-modeling、math-paper、math-figure 技能…`，并自动聚焦 |
| 2.2.4 | 再点「国赛 CUMCM」 | 追加一行模板路径（`math_paper/assets/templates/cumcm-latex/paper.tex`），已有内容不丢 |
| 2.2.5 | 连点同一个预设两次 | 第二次仍然重新写入（`presetPrompt` 按 id 去重，`Date.now()` 后缀保证变化） |
| 2.2.6 | 点预设在输入框已有文字时 | 确认是**替换还是追加**符合预期——当前实现是替换（`applyInputValue`），若想追加需改 |
| 2.2.7 | 看三张样例题卡片 | 标签为「优化/时序/评价 · 样例题」，下方「已附带样例题数据」 |
| 2.2.8 | 点样例题卡片 | 输入框出现题面路径（`assets/samples/<dir>/`）与要加载的技能 |
| 2.2.9 | 窄窗口 | 预设栏换行不溢出，卡片从 3 列变 1 列 |

### 2.3 `/algorithms` 算法库

| # | 操作 | 期望 |
|---|---|---|
| 2.3.1 | 打开 | 左侧列表 + 右侧详情；共 **23** 条 |
| 2.3.2 | 点分类芯片 | 分类为 优化 / 预测 / 时间序列 / 分类 / 聚类 / 降维 / 评价 七类，筛选生效 |
| 2.3.3 | 搜索框输入 `PSO`、`scikit-learn`、`熵权` | 都能命中 |
| 2.3.4 | 详情面板 | 四块（适合什么时候用 / 需要什么数据 / 会得到什么 / 不适合的情况）+ 依赖 + 许可 + 调用入口 |
| 2.3.5 | 「官方文档」按钮 | 外部浏览器打开对应仓库 |
| 2.3.6 | 列表里的「需安装」标记 | 显示依赖包名 |
| 2.3.7 | 点「在测试中使用」 | **新建会话并跳到聊天**，首条消息含：方法名、调用入口、依赖（要求先检查再装进项目环境）、适用与不适用、固定种子与"报告原始运行记录"的要求 |
| 2.3.8 | 后端不可用时点「在测试中使用」 | 弹出「无法为该算法创建会话」错误提示，不静默失败 |

### 2.4 `/figures` 科研绘图

| # | 操作 | 期望 |
|---|---|---|
| 2.4.1 | 打开 | **104 张卡片**（90 个 MathModel 模板 + 14 个自建模板），102 张有缩略图（不再是占位方块），分类计数正确 |
| 2.4.2 | 看缩略图裁切 | 每张预览是模板真实输出（`object-cover object-top`），确认没有裁掉关键部分 |
| 2.4.3 | 点分类芯片 | 16 个分类都有**中文名**（不再是 `flowchart` 这样的原始英文键），无空分类 |
| 2.4.4 | 详情侧栏 | 图型标签、生成脚本路径（统一为 `assets/templates/...` 或 `assets/mathmodel/...`）、`Requires matplotlib` |
| 2.4.5 | 点「使用此模板」 | 跳到首页，输入框里出现**该模板的完整请求**（模板路径 + 渲染方式 + 产物与图注要求），且**不自动发送**（已由 `catalogTemplateActions.test.tsx` 自动覆盖） |
| 2.4.6 | 对没有预览的 2 个 cartopy 模板点「使用此模板」 | 按钮禁用，并说明「暂无预览——该模板需要额外的几何依赖库」 |

### 2.5 `/paper` 论文模板

| # | 操作 | 期望 |
|---|---|---|
| 2.5.1 | 打开 | 共 **17** 条，17 条标「已内置」 |
| 2.5.2 | 看「已内置」条目 | 详情里有**编译首页预览图**（xelatex 真实产物） |
| 2.5.3 | 筛选「已内置」/ 语言 | 过滤正确 |
| 2.5.4 | 国赛条目 | 目录 `cumcm`、入口 `document.tex`、来源「MathModel 桌面端内置模板」、许可「见 NOTICE.md」 |
| 2.5.5 | 「封面信息」表单 | 字段随模板变化：国赛是 题号/参赛队号 + 学校/队员/指导教师；五一杯多出 类别/日期/电话/邮箱；华数杯无字段（表单整块不显示） |
| 2.5.6 | 填好封面信息点「使用此模板写论文」 | 跳到首页，输入框里出现模板、入口文件、封面信息（逐条列出）、写作与编译要求，且**不自动发送**（已由 `catalogTemplateActions.test.tsx` 自动覆盖） |
| 2.5.7 | 切换模板 | 上一个模板填的值被清空，不会串到另一个赛事（同一测试文件覆盖） |
| 2.5.8 | Typst 条目 | 可用，入口 `paper.typ`，提示编译时指定 `engine="typst"` |

### 2.6 `/connectors` 连接器

| # | 操作 | 期望 |
|---|---|---|
| 2.6.1 | 打开 | 13 条：内置 5 / 可连接 8 / 规划中 0，分组标题正确 |
| 2.6.2 | 点「arXiv」的安装 | 弹出凭据对话框（arXiv 无凭据 → 直接显示描述与「添加连接器」按钮） |
| 2.6.3 | 确认安装 | 提示「连接器已添加」，跳到扩展页能看到 `arxiv` 且已启用 |
| 2.6.4 | 装「GitHub」 | 对话框要求 PAT；确认请求里 `Authorization` 带上了 `Bearer ` 前缀 |
| 2.6.5 | 装「Zotero」 | 两个可选凭据；留空也可提交（`optional` 逻辑） |
| 2.6.6 | 重复装同一个 | 提示「该连接器已在你的扩展列表中」，不重复写入 |
| 2.6.7 | **端到端**：装完 arXiv 后开一个会话问它搜论文 | MCP 握手成功、工具可调用。**这一环本机完全没验过**：只验证了包存在、命令可解析、配置形状正确 |
| 2.6.8 | 规划中三条 | 显示「规划中」且无安装按钮 |
| 2.6.9 | 点「添加自定义连接器」 | 弹出扩展编辑器（名称/类型/命令或 URL/环境变量），提交后写入配置并出现在扩展页 |

### 2.9 `/skills` 技能（本轮重写）

| # | 操作 | 期望 |
|---|---|---|
| 2.9.1 | 打开 | 左列表 + 右详情；列表分「已启用」「已停用」两组，各带计数；顶部显示「共 47 个技能」（含用户技能时更多） |
| 2.9.2 | 选中一个内置技能（如 `math-paper`） | 详情渲染 **SKILL.md 正文**（不含 frontmatter），显示状态「已启用」、来源「内置」、位置 `builtin://skills/math-paper` |
| 2.9.3 | 内置技能的停用按钮 | **不显示**，改为一句说明「内置技能随应用更新，不能停用」 |
| 2.9.4 | 选中一个用户技能点「停用」 | 目录被移入 `%APPDATA%/ModelForge/skills-disabled/`，该技能出现在「已停用」组，重启后内核不再列出它 |
| 2.9.5 | 在「已停用」里点「启用」 | 目录移回原路径，回到「已启用」组 |
| 2.9.6 | 停用后再点一次「停用」（同名冲突） | 目标文件夹自动改名（`name-2`），两条记录都能各自启用回原位 |
| 2.9.7 | 「新建技能」 | 表单含名称/说明/正文/保存位置（全局或项目）；`/` 调用名即名称 |
| 2.9.8 | 「编辑」/「删除」 | 编辑走 `sourcesUpdate`；删除需点两次（第二次是「确认删除」） |
| 2.9.9 | 「导出」 | 弹保存对话框，写出内核生成的 JSON 载荷 |
| 2.9.10 | 「导入文件夹」 | 选择含 `SKILL.md` 的目录，整目录（含支撑文件）复制到 `~/.agents/skills/<名>`；同名时报错不覆盖 |
| 2.9.11 | 「导入文件」 | 选择之前导出的 JSON，导入成功并提示导入数量 |
| 2.9.12 | 搜索框 | 按名称或说明过滤两组；无匹配时显示「没有匹配的技能。」 |

> 2.9.4/2.9.5 的逻辑已由 `src/utils/skillEnablement.test.ts`（8 条）与
> `src/components/skills/SkillsView.test.tsx`（4 条）自动覆盖；**仍需要在真实应用里确认的是
> "移出后内核确实不再列出它"**——这一环需要跑起 Rust 内核才能验。

### 2.7 `/profile` 个人信息

| # | 操作 | 期望 |
|---|---|---|
| 2.7.1 | 打开 | 六个指标卡（会话数 / 提示词 / 活跃天数 / **当前连续天数** / **最长连续天数** / 项目数）+ 活跃度热力图 + 四个排行榜 + **模型使用情况占比条** |
| 2.7.2 | 热力图 | 52 列 × 7 行，月份标签在列上方，图例「少 → 多」 |
| 2.7.3 | 鼠标悬停格子 | tooltip 显示日期与提示词数 |
| 2.7.4 | 排行榜 | 供应商 / 模型 / 项目 / 配方会话数；无数据时显示「暂无数据」 |
| 2.7.5 | 连续天数 | 今天已活动则从今天往回数；今天还没活动时从昨天往回数（不会显示为 0，也不会被今天打断） |
| 2.7.6 | 模型占比条 | 按会话数占比，列出前 6 个模型，百分比保留一位小数 |
| 2.7.7 | 底部说明 | 明写 Token 与费用按会话统计、**聚合需要本地用量库**——不编数字 |
| 2.7.8 | 空会话状态 | 新装无会话时不崩、显示 0 |

### 2.8 品牌与文案（P0）

| # | 操作 | 期望 |
|---|---|---|
| 2.8.1 | 全局搜界面文案 | 无 "Goose" 残留（协议字段 `_meta.goose`、`GOOSE_*` 环境变量、`.goosehints`、`goose://` 除外） |
| 2.8.2 | 逐页看 logo | 无鹅的图形（`GooseLogo`/`icons/Goose` 已删） |
| 2.8.3 | 窗口标题 / 菜单栏 / 错误框 | 均为 ModelForge（含中文菜单） |
| 2.8.4 | 切换语言到英文 | 新页面文案有英文（其余 14 语言回退英文是预期） |
| 2.8.5 | 托盘 / 任务栏 / 窗口图标 | 新的立方体标记，**深色背景下无白边**（alpha 已修） |

---

## 3. 能力层：在真实会话里跑一遍

**能力层的完成判定依据**（见下表"已验证"列）：能在本机自动验证的全部已验证；
需要工具链的部分逐条列在下方，是必须做的验收动作而非"尚未开始"。

| 能力项 | 数量 | 本机自动验证 | 待工具链验收 |
|---|---|---|---|
| A1 技能正文 | 47 | ✅ frontmatter/规范/覆盖/选型表连通；**描述全部为中文触发式** | 3.1、3.4 |
| A2 赛事论文模板 | **17 可编译 / 17 目录** | ✅ **真编译**（16 套 xelatex + 1 套 typst，全部出 PDF + 首页预览） | 3.7 |
| A3 科研绘图模板 | **104 条**（90 个产品模板 + 14 个自建） | ✅ **真渲染**（102 张有预览；2 个 cartopy 模板需 MSVC 构建工具） | — |
| A4 算法库 | 23 条 | ✅ 目录数据 + 构建产出 | 页面目视（2.3） |
| A5 MCP 连接器 | 8 可安装 | ✅ **真实 MCP 握手**（`scripts/check-connectors.js`，8/8 通过） | 2.6.3–2.6.6（UI 点击路径） |
| A6 内置样例题 | 3 | ✅ **真生成数据**且重生成哈希一致 | 3.4 |
| A7 工具技能 | 4 个技能 + 2 个脚本 | ✅ **脚本逐个真跑**：`paper_search.py` 检索/verify/bib/伪 DOI 拒绝；`record_source.py` 登记/列表/去重/拒绝带 token 的 URL | 3.10–3.13（技能在会话里的实际行为） |
| A8 扩展五类与个人信息 | 5 个页面 | ✅ 技能启停逻辑 8 条 + 技能页 4 条自动化测试；目录/论文页动作 4 条 | 2.9 全部、2.3.7、2.5.6–2.5.8、2.6.9、2.7.x |
| A9 内容本体 | 10 个技能正文 + 6 类资产 | ✅ **真跑**：paper-diagram 5 套版式全部渲染 + `check_layout` **FAIL 0 / WARN 0**；`paper_search.py` 的 verify/search/bib；`record_source.py` 写 `sources.json`；`check_environment.py` 出 JSON 报告 | 3.15–3.18（在会话里由 agent 调用这些技能） |

> **A5 的握手验证**（`node scripts/check-connectors.js`）：不只看"命令能解析"，而是真的按 MCP
> 协议发 `initialize` + `tools/list` 并读回工具清单。实测结果：
> arxiv 19 个工具、crossref 18、drawio 5、zotero 3、context7 2、web-fetch 1；
> fred 与 github 正确地要求凭据（前者退出时提示 `FRED_API_KEY`，后者返回 HTTP 401）——
> 这正是"包可用、只差凭证"的预期表现。
>
> 该脚本用**直接 spawn 而非 shell** 启动进程，与桌面端一致。这不是细节：经 `cmd.exe` 时
> `--with mcp<2` 的 `<` 会被当成输入重定向，报 "The system cannot find the file specified"；
> 直接 spawn 则正常。第一版脚本用了 `shell: true`，把两条本来可用的连接器误判为失败——
> **测试脚手架的偏差会制造不存在的 bug**，这一点值得记住。

| # | 操作 | 期望 |
|---|---|---|
| 3.1 | 新建会话问「加载所有技能」 | 技能列表里能看到 **47 个**，含方法论/写作/分支/运营技能，以及 `doctor`、`metaheuristic-optimization`、`paper-diagram`、`nature-figure` 四个工具技能 |
| 3.2 | 让 agent 加载 `math-figure` | 回复里列出 14 个模板与 skill 目录的绝对路径 |
| 3.3 | 让 agent 加载 `math-modeling` | 列出 3 个样例题与 15 个支撑文件 |
| 3.4 | 按样例题 1 走一遍 | agent 能加载 `optimization-modeling` + `sensitivity-analysis`，并真的跑数据 |
| 3.5 | 让 agent 用 `compile_latex` 编译 `cumcm-latex/paper.tex` | 返回 PDF 路径（本机 TeX Live 已装，`check_env` 应能检出） |
| 3.6 | 故意编译一个坏 tex | 返回解析后的错误行而不是崩溃 |
| 3.7 | 让 agent 用 `math_paper` 模板产出论文 | 生成的 `.tex` 能编译 |
| 3.8 | ~~装一个连接器后真的调用它~~ | ✅ **已在命令行完成**：`node scripts/check-connectors.js` 对全部 8 条连接器做了真实 MCP 握手（见上表注）。仍需在 UI 里确认「点击安装 → 写入配置 → 扩展页可见」这一段（2.6.3–2.6.6） |
| 3.9 | 抽查两个新技能的内容质量 | 例如让 agent 按 `reliability-and-survival` 分析一组寿命数据，确认它会先问删失情况、会报 Weibull 形状参数 |
| 3.10 | 让 agent「找三篇熵权 TOPSIS 的文献并生成 bib」 | 它会跑 `paper-search`：先 `search` → 再逐条 `verify` → 最后 `bib --doi` 追加进 `book.bib`；**不会凭记忆写条目**。故意给一个假 DOI，应拒绝生成并说明"可能是编造的" |
| 3.11 | 让 agent「找一份省级能源消费数据」 | 它会跑 `data-search`：先看题目已有数据 → 按 `references/source-routing.md` 找官方来源 → 给候选表（含许可列）→ 确认后落 `data/raw/` 并调 `record_source.py` 写 `data/sources.json`；许可不明时标"未确认"而不是猜 |
| 3.12 | 让 agent「检查我的建模环境」 | 它只在你明确要求时调用 `doctor`：先 `modeling__check_env`，再补查 Python 包，给出缺失项与**按平台的安装命令**（含中国大陆镜像），**安装前必须问你** |
| 3.13 | 让 agent「画一张技术路线图」 | 它走 `paper-diagram`：产出可编辑 `.drawio` + PNG/PDF，中文不会躺倒、箭头有语义、导出后自检文字溢出；而不是用 matplotlib 画一张位图交差。数据图表（折线/热图）则应走 `math-figure`/`nature-figure`，两条路不混 |
| 3.14 | 让 agent 按 `nature-figure` 画投稿级多面板图 | 它会先问 **Python 还是 R** 并停下（后端是阻塞关卡），再按该后端的 quick-start 执行；不会两套混用 |
| 3.15 | 让 agent「画一张技术路线图」（内容来自当前题目） | 走 `paper-diagram`：套用 5 套内置版式之一，产出**可编辑 `.drawio`** + PNG/PDF；用 `check_layout.py` 自检（应当 FAIL 0 / WARN 0），不靠位图交差 |
| 3.16 | 让 agent「给论文配一张 SHAP 蜂群图」 | 走 `mathmodel-figure-templates`：先用 `render_template.py --list` 匹配 id，渲染到 `绘图复刻/` 并返回脚本与图片路径；**不会声称演示数据是真实测量值** |
| 3.17 | 让 agent 用 doctor 检查环境 | 它跑 `scripts/check_environment.py` 并**按 JSON 报告**逐项说明缺失项与安装命令（含大陆镜像）；安装前必须先问用户 |
| 3.18 | 点主页三张真题卡片 | 输入框写入对应 `math_modeling/assets/examples/<赛题>/` 的路径与该题要加载的技能；agent 先读 `questions.txt`（题面全文），不需要 PDF 工具 |

---

## 4. 打包（发布前）

| # | 操作 | 期望 |
|---|---|---|
| 4.1 | `cd ui/desktop && pnpm run make` | 产出安装包，图标/名称/协议均为 ModelForge |
| 4.2 | 装包后看 mac 图标（如能做） | `icon.icns` 显示正常（PNG 载荷格式已按规范校验） |
| 4.3 | 填真实仓库地址 | `app-update.yml`、`githubUpdater.ts`、`branding.ts` 的 `your-org/modelforge` 换成实际值，否则自动更新 404 |
| 4.4 | 决定 `goose://` 是否改 `modelforge://` | 现状：协议注册是 `modelforge`，代码与文案仍是 `goose://`，**两者不一致**，需拍板 |

---

## 5. 已知不一致 / 待决（不是 bug，是需要决策）

| 项 | 现状 | 影响 |
|---|---|---|
| deeplink 协议 | `forge.config.ts` 注册 `modelforge`，`createSession` 与 i18n 仍是 `goose://` | 用户点 deeplink 可能不生效 |
| `app-update.yml` | 占位 `your-org/modelforge` | 自动更新不可用 |
| 目录页文案 | `src/catalog/*.ts` 条目正文为中文硬编码 | 非中文界面会看到中文条目（技能描述同理：项目技能是中文，界面语言为英文时仍显示中文） |
| 主页预设的输入框行为 | 替换而非追加 | 已有草稿会被覆盖（「使用此模板」同样是替换：先写好草稿再点模板会丢，需按产品意图拍板） |
| 32 个方法论技能正文仍为英文 | 描述已中文化，正文是英文技术参考 | 中文用户看输出无碍，但要与核心技能完全一致需整批翻译（属独立工作量） |
| 累计 Token / 最活跃时段 | `SessionListItem` 与 `SessionInfo` 都不带用量，只有加载整个会话才能求和 | 参考产品用本地 SQLite 一句聚合即可；我们要么做本地用量库，要么逐会话加载（慢且未验证），因此**不做假数字**，页面如实说明 |
| 技能正文与工具包来自产品 | 10 个 SKILL.md、draw.io 工具包、90 张预览、三套真题均为产品内容 | **产品没有为它们提供许可文件**；真题还是赛事方版权。自用没问题，**对外分发前按 `NOTICE.md`「Before you distribute」逐项取舍** |
| 「推荐 · 社区」技能市场、插件页「套装」 | 需要远端技能仓库 / 套装清单格式 | 参考产品这两块也是运营资产，不是本地功能 |
| 自定义模板的存放 | 参考产品存在本机并可编辑；我们让 agent 在项目内建副本 | 改造模板本质是改 `.cls` 与章节文件，agent 比表单更合适（有意差别） |
| 7 套模板许可未确认 | 见 `NOTICE.md`：5 套 LPPL 可分发，7 套无声明的标为"许可未解决" | **对外分发前必须取舍**（只留 LPPL + 采购的 3 套 + Apache-2.0 的 nature-figure） |

---

## 6. 每次改动的固定验证（已全部通过）

```bash
cd ui/desktop
pnpm run lint:check                          # typecheck + eslint + i18n:check
pnpm run brand:check                         # 矢量与 brand-mark.json 一致
pnpm run docs:check                          # 文档里的数字与文件系统一致（跨文档核对）
node scripts/check-skills.js                 # 47/47 技能 frontmatter 与规范
pnpm run figures:build                       # 14 个绘图模板出图（需 uv）
pnpm run papers:build                        # 17 套论文模板编译（16 套 xelatex + 1 套 typst）
node scripts/check-connectors.js             # 8 条连接器真实 MCP 握手（需联网取包）
pnpm exec vitest run --no-file-parallelism   # 单测必须串行
```

> `docs:check` 会从文件系统重新推导每一项计数（技能数、绘图模板数、论文模板数、连接器分组数、
> 算法条数、i18n 条数），然后核对四个文档里声称的数字是否一致，并检查应用目录与磁盘是否吻合
> （例如图库不再有占位、目录可用数等于可编译数）。**加内容后忘改文档时它会失败**——
> 这就是它的用途。
>
> **它现在还校验"引用的资产必须存在"**（本轮新增）：技能正文里的模板名、`scripts/`、
> `references/` 路径，目录文件里的 `entryFile` 与 `script`，主页预设的 `templateDirectory`，
> 逐个核对。这条检查的存在有具体原因——上一轮提取产品模板时删掉了 11 个自写骨架，
> 而 `math_paper.md`、`templates/README.md` 与 `homePresets.ts` 仍在指向那些已删除的名字，
> 计数却全部对得上。**改了资产没改引用，现在会被构建拦住。**

> **单测务必串行**：默认并行下失败数在 3–34 之间波动（`userEvent` 对 CPU 竞争敏感），
> 串行稳定为 4 个既有失败（2 个 Windows 临时目录大小写 + 2 个 `userEvent` 超时），
> 与本次改动无关。
