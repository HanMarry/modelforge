# ModelForge（建模助手）二改说明

基于 [`aaif-goose/goose`](https://github.com/aaif-goose/goose)（Apache-2.0）白标改造成
「数学建模垂直智能体」的记录与操作手册。品牌名 **ModelForge**，定位为数学建模竞赛助手。

> 上游修改声明与第三方资源归属见 [`NOTICE.md`](NOTICE.md)。
> 对齐目标产品的分阶段复刻计划见 [`REPLICATION_PLAN.md`](REPLICATION_PLAN.md)。
> **装上工具链后的逐条验收步骤见 [`ACCEPTANCE_CHECKLIST.md`](ACCEPTANCE_CHECKLIST.md)**——
> 本文件记录"改了什么"，那份文件记录"怎么确认它真的能用"。

---

## 一、已完成的白标改动（P0）

| 文件 | 改动 |
|---|---|
| `crates/goose/src/prompts/system.md` | 系统提示词开头改为 ModelForge 建模助手人设 + 建模工作规范 |
| `crates/goose/src/prompts/subagent_system.md` | 子代理自述改为 ModelForge 框架 |
| `ui/desktop/package.json` | `name`→`modelforge-app`，`productName`→`ModelForge`，description 更新，bundle 默认名改 ModelForge，新增 `brand:*` 脚本 |
| `ui/desktop/index.html` | `<title>`→`ModelForge` |
| `ui/desktop/forge.config.ts` | 协议 `ModelForgeProtocol`/`modelforge`、各 maker 的 name/bin/maintainer/homepage、flatpak id、publisher 默认 owner/repo |
| `ui/desktop/forge.deb.desktop` / `forge.rpm.desktop` | Linux 桌面入口 `Name`/`Exec`/`Icon`/`MimeType` 去 Goose 化 |
| `ui/desktop/src/app-update.yml` | owner/repo/cacheDirName 改为占位（`your-org`/`modelforge`） |
| `ui/desktop/src/images/*` | 图标全部重生成为 ModelForge 标记：`icon.png`/`icon@2x.png`/`icon-512.png`/`icon.ico`/`icon.icns`/`icon.svg`/`iconTemplate*.png` |
| `ui/desktop/src/branding.ts` | 新增：集中管理应用内文档与仓库外链（`DOCS_URLS`、`REPOSITORY_URL`），换域名只改这一处 |
| `ui/desktop/src/brand-mark.json` | 新增：标记的**唯一真源**（四个面的多边形 + 采样色 + IoU 自检值） |
| `ui/desktop/src/components/icons/ModelForge.tsx` | 新增：由 `brand-mark.json` 生成的矢量标记与字标组件 |
| `ui/desktop/src/components/ModelForgeLogo.tsx` | 新增：应用内头像位标记（替代 `GooseLogo`） |
| 应用内 logo 引用 | `BaseChat`（品牌水印）、`Hub`/`BaseChat`/`ProgressiveMessageList`（加载态）、`suspense-loader`、`RecipeActivities`、`OnboardingGuard`、`CreateEditRecipeModal` 全部改为新组件；删除 `GooseLogo.tsx`、`icons/Goose.tsx`、`icons/Geese.tsx` 及 `goose-icon-*` 动画 CSS |
| `ui/desktop/src/i18n/messages/*.json` | 16 个语言共 ~1100 处用户可见文案去 Goose 化；文案 ID `goosehints*`→`projectHints*`、`askGoose`→`askAssistant` |
| TS 源码 `defaultMessage` 字面量 | 33 个文件 68 处同步改写（否则 `pnpm i18n:check` 会失败） |
| `ui/desktop/src/main.ts` | 菜单/窗口标题/错误框/托盘提示改为 ModelForge（含 zh-CN 菜单翻译表） |
| `ui/desktop/src/utils/{autoUpdater,githubUpdater,winShims}.ts` | 托盘提示、UA、`%LOCALAPPDATA%` 目录名、更新器默认 owner/repo/bundle 名 |
| `crates/goose-cli/src/cli.rs` / `goose-mcp` | 内置 MCP `modeling` 注册（详见第四节） |

### 刻意保持不变（改动会破坏兼容性或需整体改名）

| 保留项 | 原因 |
|---|---|
| `_meta.goose` 及其 TS 类型名（`GooseMessageMeta`、`GooseExtension`…） | ACP **协议线上字段**，前后端与 Rust 内核共同约定 |
| `GOOSE_*` 环境变量（`GOOSE_MODE`、`GOOSE_DISABLE_TELEMETRY`…） | Rust 内核读取的名字，改前端会失效 |
| `.goosehints` / `.goose/skills` / `~/.config/goose` 路径 | 上游兼容，改了两边都不认 |
| `goose://` deeplink scheme | 与 `forge.config.ts` 的协议注册成对出现，要改需同时改注册表与已发布链接 |
| `@aaif/goose-acp-client` 包名 | workspace 包，重命名属独立工程 |

> **遥测**：`crates/goose/src/posthog.rs` 里 `is_telemetry_enabled()` 默认就是 **opt-in 关闭**（用户未明确同意就不上报）。
> 白标发布时仍建议在启动脚本/打包环境里显式加 `GOOSE_TELEMETRY_OFF=1` 双保险。


---

## 二、怎么构建（前置条件）

本机当前缺 Rust 工具链（无 `rustc`/`cargo`/`just`），**Rust 侧本次未实际编译**；桌面端已用
`pnpm 10.30.0` 装依赖并通过 typecheck/lint/单测。

1. **Rust**（见仓库 `rust-toolchain.toml` 的固定版本）
2. **Node ≥ 24.10.0**、**pnpm ≥ 10.30.0**（`ui/desktop/package.json` 的 engines；注意
   pnpm 10.28 会直接 `ERR_PNPM_UNSUPPORTED_ENGINE` 拒绝安装，需升级或用
   `npx pnpm@10.30.0`）
3. **Hermit**：仓库自带 `bin/activate-hermit`，用它进入工具链
4. **just**（命令运行器，见根目录 `Justfile`）

构建命令（先 `source bin/activate-hermit`）：

```bash
# Rust 内核
cargo build

# 桌面端开发模式
just run-ui

# 桌面端打包（Electron Forge）
cd ui/desktop && pnpm install && pnpm run make

# 发布打包时对齐更新器名字
export GITHUB_OWNER="your-org"
export GITHUB_REPO="modelforge"
export GOOSE_BUNDLE_NAME="ModelForge"
```

Windows 侧没有 `source`，使用 Hermit 的 Windows 激活方式（参考 `bin/` 下的脚本），或直接安装
`rustup` + 对应版本 Node + pnpm + `cargo install just`。

### 品牌资产流水线（新增，无需 Rust）

图标与矢量标记全部由脚本生成，**不要手改生成物**：

```bash
cd ui/desktop
pnpm run brand:build    # 从 modelforge-logo.png 重新生成全部品牌资产
pnpm run brand:check    # CI 用：校验 icon.svg / ModelForge.tsx 与 brand-mark.json 一致
```

| 脚本 | 作用 | 产出 |
|---|---|---|
| `scripts/build-brand-icons.js` | 定位标记边界 → 按白底反解透明度 → 生成各尺寸位图 | `icon.png`、`icon@2x.png`、`icon-512.png`、`icon.ico`(6 尺寸)、`icon.icns`(11 项)、`iconTemplate*.png`(托盘) |
| `scripts/build-brand-mark.js` | 连通域分割四个面 → 最小二乘拟合直边 → 求交点 → **IoU 自检（<0.95 报错）** | `src/brand-mark.json`（唯一真源） |
| `scripts/build-brand-vector.js` | 由真源渲染 | `src/images/icon.svg`、`src/components/icons/ModelForge.tsx` |

标记几何要点：源图 1254²，标记位于 `x 85..293 / y 513..709`（209×197），字标在 x>412 处；
按白色-前景色连线拟合可同时得到透明度与色相，避免抗锯齿边缘出现橙色描边。
四个面（primary 顶部 / front 正面 / accent 橙色 / secondary 左侧）各自取实际采样色，
所以左面的浅灰 `#565f66` 被保留。

---

## 三、模型接入（国内中转 / 自建网关）

goose 已内置声明式 provider：`crates/goose-providers/src/declarative/*.json`，含
`deepseek`、`zhipu`、`moonshot`、`minimax`、`alibaba`、`iflytek`、`groq`、`openrouter` 等 48 个。

自建中转网关（OpenAI 兼容）的声明式 provider，放 `~/.config/goose/custom_providers/` 下：

```json
{
  "name": "my_gateway",
  "engine": "openai",
  "display_name": "我的中转网关",
  "description": "OpenAI 兼容的中转端点",
  "api_key_env": "MY_GATEWAY_API_KEY",
  "base_url": "https://your-gateway.example.com/v1/chat/completions",
  "models": [
    { "name": "deepseek-chat", "context_limit": 131072 },
    { "name": "qwen-max", "context_limit": 131072 }
  ],
  "supports_streaming": true,
  "requires_auth": true
}
```

**注意**：官方明确禁止把 API key 预置进安装包。首启应让用户自己填 key（走 OAuth 的 provider
或安装期注入 + MDM 除外）。

---

## 四、技能 / Recipe / 自研 MCP（P1 已落地）

### 内置技能（需要改 Rust 并重编）

内置技能是 `crates/goose/src/skills/builtins/*.md`，通过 `include_dir!` 编进二进制。
每个文件是「YAML frontmatter（`name` + `description`）+ Markdown 正文」，agent 通过
`load_skill(name: "...")` 加载。风格统一：`## Requirements` → 分步骤/示例 → `## Rules`。

已内置 **47 个技能**：**11 个采用参考产品正文**的工具/流程技能 + 32 个本项目编写的方法、
领域、工程与写作技能 + 2 个上游通用技能 + `mathmodel-figure-templates` 与 `skill-creator` 两个
独立技能包。本项目编写的技能描述一律为中文触发式（含"用户说…时使用"的触发条件），
因为 goose 用 description 做技能路由，中文触发词才匹配中文提问。上游自带的
`goose_doc_guide`、`web_search` 保持英文原文以免与 upstream 分叉。

工具类技能：**正文取自参考产品**（按本 fork 的工具名与路径适配，改动逐条列在
`ui/desktop/scripts/adopt-product-skills.js`），脚本与模板也是产品原版：

| 技能 | 文件 | 内容与资产 |
|---|---|---|
| `math-modeling` | `math_modeling.md` | 本项目编写：全流程 + 32 行选型表；带 3 套真题与 3 道自编样例题 |
| `math-paper` | `math_paper.md` | **产品正文**：模板来源判定 → 集中确认模型 → 逐问求解 → 配图路由 → 真实引用 → 编译；17 套真实模板 |
| `math-figure` | `math_figure.md` | **产品正文**：只做路由（数据图表 / 内置模板 / `nature-figure` / `paper-diagram` / TikZ）+ 产物约定 |
| `math-review` | `math_review.md` | **产品正文**：六维 0–10 + 致命项 + 产出 `review.md`，只评不改 |
| `mathmodel-figure-templates` | `mathmodel_figure_templates.md` + 目录 | **产品正文与全套资产**：90 个模板脚本、`render_template.py`、4 篇参考、90 张自带预览、Natural Earth 几何 |
| `paper-search` | `paper_search.md` + `scripts/paper_search.py` | **产品正文与脚本**：OpenAlex+Crossref 双引擎，`search`/`verify`/`bib`，DOI 反查生成 BibTeX |
| `data-search` | `data_search.md` + `scripts/record_source.py` + `references/source-routing.md` | **产品正文与脚本**：按权威度检索公开数据，登记 SHA-256 到 `data/sources.json`（`browser_*` 一节按本 fork 改写） |
| `doctor` | `doctor.md` + `scripts/check_environment.py` + `references/install.md` | **产品正文与脚本**：JSON 环境报告 + 三平台安装方案（含大陆镜像）；install.md 追加了 cartopy/MSVC、中文字体、uv 镜像持久化三项 |
| `metaheuristic-optimization` | `metaheuristic_optimization.md` | **产品正文**：MEALPY / pymoo，先核对版本与官方文档再写可复现实验 |
| `paper-diagram` | `paper_diagram.md` + `assets`/`scripts`/`references` | **产品正文与全套工具**：5 套版式模板（content JSON + 预览）、8 个脚本（渲染/校验/导出/预览）、11 篇参考、Tabler 图标（MIT） |
| `nature-figure` | `nature_figure.md` + `nature_figure/` | 产品内的社区技能，Apache-2.0，**整包合法内置** |
| `skill-creator` | `skill_creator.md` + `skill_creator/` | 产品内的技能编写指南，Apache-2.0（自带 `LICENSE.txt`） |
| `paper-sharing` | `paper_sharing.md` | **产品正文**：脱敏 + 整理公开字段；上传步骤改为本机写 `sharing.json`（本 fork 没有广场后端，它不会假装上传） |

用于「使用此模板」的产品资产（`paper` / `figures` 两页直接读这些元数据）：

- `math_paper/assets/templates/*/template.json`：名称、语言、入口文件、`defaultFor`、封面字段
- `mathmodel_figure_templates/references/figure-catalog.md`：90 个模板的 id、分类与版式说明
- `math_modeling/assets/examples/`：三套真题（题面 PDF + 题面文本 + 附件 + 结果文件）

### 测试版与可分发版

**本树是"测试版"：为了编译结果与产品一致，29 个商业中文字体（118 MB）与三套真题都在树里。**
切成可分发版只需一条命令：

```bash
cd ui/desktop
node scripts/strip-unshippable.js            # 只出清单（177 文件）
node scripts/strip-unshippable.js --write    # 删字体 + 真题 + 许可未声明的 9 套模板
pnpm run papers:catalog && pnpm run docs:check
```

保留 8 套模板（5 套 LPPL + 2 套 MIT + 1 套 Apache-2.0）。剥离后 `wuyi`/`huawei`/`huazhong`/`stats`
会因缺字体编译失败——把类文件里的字体名改成系统字体，或直接下架。逐条依据见 `NOTICE.md`。

32 个方法论技能（仍在英文正文，描述已中文化）：

| 技能 | 文件 | 作用 |
|---|---|---|
| `data-prep` | `data_prep.md` | 数据体检与清洗：缺失分类、离群点定性、泄漏检查、数据质量表 |
| `evaluation-method` | `evaluation_method.md` | 熵权/AHP（含 CR）/TOPSIS/灰色关联、秩聚合与权重扰动 |
| `statistical-testing` | `statistical_testing.md` | 检验选型、前提检查、效应量与置信区间、多重比较校正 |
| `sensitivity-analysis` | `sensitivity_analysis.md` | 弹性、容差区间、Sobol/Morris、蒙特卡洛、基线对比 |
| `time-series` | `time_series.md` | 分解、平稳性、ARIMA/SARIMA/VAR/Prophet、滚动回溯 |
| `optimization-modeling` | `optimization_modeling.md` | 约束族、求解器选型、最优性间隙、Pareto 前沿 |
| `differential-equation-modeling` | `differential_equation_modeling.md` | 机理建模、刚性求解、参数辨识、守恒量校验 |
| `graph-and-network` | `graph_and_network.md` | 图定义、最短路/MST/最大流/匹配/TSP、边级校验 |
| `spatial-analysis` | `spatial_analysis.md` | CRS 与投影、插值与交叉验证、Moran's I、选址覆盖 |
| `queueing-and-simulation` | `queueing_and_simulation.md` | M/M/c、Little's 定律校验、SimPy、预热与重复次数 |
| `cellular-automata` | `cellular_automata.md` | 元胞与邻域、转移规则、标定与 FoM、随机集合 |
| `grey-and-ensemble-prediction` | `grey_and_ensemble_prediction.md` | GM(1,1) 级比检验、C/P 双检验、指数平滑、组合预测 |
| `code-and-reproducibility` | `code_and_reproducibility.md` | 目录布局、uv 锁依赖、种子、参数外置、results/ 产物、环境记录、README |
| `model-comparison` | `model_comparison.md` | 基线、协议对齐、按决策选指标、差异置信区间、不可区分也要如实写 |
| `assumptions-and-notation` | `assumptions_and_notation.md` | 题干逐句形式化、假设三要素、given/assumed/derived、量纲检查、符号表自查 |
| `result-visualization` | `result_visualization.md` | 按信息选图型、零基线、颜色用途、标注结论、多面板、图注三段式 |
| `abstract-and-conclusion` | `abstract_and_conclusion.md` | 摘要五步结构（带数字）、结论量化、优缺点各带改法、推广具体化、投稿前自查 |
| `regression-modeling` | `regression_modeling.md` | 解释 vs 预测、VIF、函数形式、假设诊断四件套、Cook 距离、稳健标准误、正则化 |
| `classification-modeling` | `classification_modeling.md` | 类别平衡、先切分后重采样、PR-AUC vs ROC-AUC、阈值显式选择、概率校准 |
| `clustering-analysis` | `clustering_analysis.md` | 标准化与距离度量、k 的多个判据、按簇形状选算法、稳定性与零模型、簇画像 |
| `paper-structure` | `paper_structure.md` | 逐节写什么与怎么失分、问题分析的方法比选表、检验三件事、附录取舍 |
| `citations-and-references` | `citations_and_references.md` | 不凭记忆写引用、DOI 验证、GB/T 7714 与 IEEE、BibTeX 卫生、引用双向核对 |
| `simulation-optimization` | `simulation_optimization.md` | 公共随机数、可检测差异、样本均值近似与重复数检查、排序与选择、代理模型 |
| `outlier-and-anomaly-detection` | `outlier_and_anomaly_detection.md` | 清洗/建模/检测三种框定、硬约束优先、MAD 修正 z、多变量方法、时序去趋势、处置前后对比 |
| `count-and-ordinal-models` | `count_and_ordinal_models.md` | Poisson 过度离散检验、负二项与零膨胀、率模型 offset、IRR 与 CI、有序 logit 平行线假设、beta/二项 GLM |
| `pde-modeling` | `pde_modeling.md` | 守恒式先行、方程分类、边界条件三类、方法线离散化与收敛检查、**CFL 稳定性**、守恒量漂移、隐式方案取舍 |
| `changepoint-and-regime` | `changepoint_and_regime.md` | 变点类型判定、PELT/BinSeg 惩罚项要显式、CUSUM 检验、马尔可夫切换、**日期的不确定性区间**、安慰剂检验 |
| `facility-location` | `facility_location.md` | p-median / 最大覆盖 / 集合覆盖 / CFLP 选型、需求聚合层级、网络距离、**成本-覆盖权衡曲线**、未覆盖需求与公平性 |
| `experimental-design` | `experimental_design.md` | 因子与响应先行、全因子与部分因子（**分辨率与混杂结构**）、随机化与区组、响应面法与确认实验 |
| `multi-attribute-decision` | `multi_attribute_decision.md` | 排序 vs 决策的区分、偏好获取、加权和的完全补偿假设、ELECTRE 不可比、PROMETHEE 净流、权重扰动与交叉验证 |
| `reliability-and-survival` | `reliability_and_survival.md` | **删失数据**（右删失不能丢）、Kaplan–Meier 基线、Weibull 形状参数的含义（β>1 是磨损期才值得定期更换）、系统可靠度（串/并/k-out-of-n）与独立性假设、年龄更换策略、B10 寿命 |
| `inventory-and-supply-chain` | `inventory_and_supply_chain.md` | EOQ 及其"无缺货"假设的边界、数量折扣要逐段算总成本、**报童模型的临界分位数**（别用均值需求）、安全库存必须用**提前期需求方差**、服务水平两种定义（周期 vs 满足率）、成本分解 |

**其中 32 个是本次复刻新增的**（分八批：方法论 6、领域 5、小样本 1、工程与写作 5、专项与写作 5、补缺 3、分支 5、运营 2），
写法上刻意对齐"可执行 + 可验收"：每条都写明**失败模式**，例如
AHP 不报 CR、评价不提权重、时序不跟朴素基线比、优化不报最优性间隙、统计只报 p 值不报效应量、
GM(1,1) 不做级比检验、元胞自动机用整体精度评价不平衡网格、排队仿真只跑一次、
论文里有数字但追不到 `results/`、比较模型时不给基线、假设不写"错了会怎样"、
摘要里出现无量化断言、不平衡数据只报准确率、聚类不做稳定性检验、凭记忆写参考文献、
仿真优化不用公共随机数、把该检测的异常当错误删掉、计数/有序响应硬套 OLS、
PDE 不算 CFL、变点不给日期区间、选址只给一个解不给权衡曲线、
实验只做单因子却声称研究了交互、偏好型决策方法当成客观结论、
丢掉右删失观测、用均值需求做报童订货、安全库存用日标准差而非提前期需求标准差。

技能由后端经 ACP 动态列出（`listSkillSources`），**新增 `.md` 文件无需在前端注册**；
`include_dir!` 会在编译时把它编进二进制。

`math-paper` 自带可编译的论文模板资产（`math_paper/assets/templates/`，加载技能时会把
skill 目录与全部支撑文件路径打印出来，agent 直接复制使用）：

| 目录 | 引擎 | 赛事 | 入口 | 许可 | 编译 |
|---|---|---|---|---|---|
| `cumcm/` | xelatex | 国赛 CUMCM（产品内置版） | `document.tex` | 见 NOTICE.md | ✅ |
| `mcm/` | xelatex | 美赛 MCM/ICM | `main.tex` | 见 NOTICE.md | ✅ |
| `apmcm/`、`apmcm-en/` | xelatex | 亚太赛（中/英） | `main.tex` | 见 NOTICE.md | ✅ |
| `huashubei/`、`mathorcup/`、`shuweibei/`、`wuyi/` | xelatex | 华数杯 / MathorCup / 数维杯 / 五一杯 | `main.tex` | 见 NOTICE.md | ✅ |
| `diangongbei/`、`dongsansheng/`、`huazhong/`、`changsanjiao/`、`huawei/`、`stats/` | xelatex | 电工杯 / 东三省 / 华中杯 / 长三角 / 华为杯 / 统计建模 | `main.tex` | 见 NOTICE.md | ✅ |
| `cumcm-latex/` | xelatex | 国赛（`cumcmthesis` 类文件版） | `paper.tex` | MIT | ✅ |
| `jxust-latex/` | xelatex | 校赛/通用 | `paper.tex` | MIT | ✅ |
| `cumcm-typst/` | typst | 国赛 Typst 版 | `paper.typ` | Apache-2.0 | ✅（`theorems.typ` 本地实现，编译不需联网） |

共 **17 套，全部实测编译通过**（16 套 xelatex + 1 套 typst），应用里的首页预览就是这些
编译产物的首页。14 套从产品内置模板提取（自带 `template.json`：名称、入口、封面字段），
3 套采购自上游并保留 `LICENSE`。构建前提与逐套字段清单记录在
`assets/templates/README.md`。

### 桌面端「使用模板」入口（本轮新增）

两处目录页都能把模板**真的用起来**，而不是只展示：

| 页面 | 入口 | 行为 |
|---|---|---|
| 科研绘图 `/figures` | 详情栏「使用此模板」 | 把"用该模板出图"的完整请求（模板路径、渲染方式、产物与图注要求）写进首页输入框 |
| 论文模板 `/paper` | 详情栏封面信息表单 +「使用此模板写论文」/「基于此模板自定义」 | 表单字段来自各模板自己的 `template.json`（题号/队号/年份/作品编号 + 学校/队员/指导教师/电话/邮箱），随请求一起写入输入框；「自定义」填一个名称后生成"在项目内建副本并改造"的请求 |

实现方式：`ui/desktop/src/utils/composerSeed.ts` 提供一次性种子槽，
Hub 挂载时取走并交给 `ChatInput` 的 `presetPrompt` 入口；目录页不需要任何全局状态。
`pnpm run figures:catalog` / `papers:catalog` 生成的目录文件里已带 `script`、
`fields`、`profileFields`、`defaultFor`、`kind`，所以加模板只需往磁盘放目录，无需改组件。

### 「扩展」五类与个人信息页对齐（本轮新增）

侧栏「扩展」展开的技能/模板/算法/插件/连接器，以及个人信息页，本轮按参考产品逐项补齐
（逐条对照表见 `REPLICATION_PLAN.md` 的 A10）：

| 页面 | 本轮新增的能力 |
|---|---|
| 技能 `/skills` | 重写：**已启用 / 已停用分组**、详情渲染 SKILL.md 正文（去 frontmatter）、来源与路径、**启用/停用开关**、新建/编辑/删除/导出/导入 JSON、导入 Skill 文件夹、总数与搜索 |
| 模板 `/paper` | 「默认用于」、内置/上游两组标题、「基于此模板自定义」 |
| 算法 `/algorithms` | 「在测试中使用」：建会话并带上方法、调用入口、依赖与"先检查依赖"的要求 |
| 连接器 `/connectors` | 「添加自定义连接器」：复用扩展编辑器，任何 MCP 服务器都能接 |
| 个人信息 `/profile` | 当前/最长连续天数、模型使用占比条 |

**技能启停是怎么实现的（重要，别当成 UI 状态）**：goose 内核没有技能的启用/停用概念，
发现逻辑只扫固定根目录。因此「停用」是把技能目录**移出**这些根目录，存进应用数据目录下的
`skills-disabled/`（带一份记录原始路径的索引），「启用」再移回原处——与参考产品的做法一致。
逻辑在 `ui/desktop/src/utils/skillEnablement.ts`（纯 fs，可单测），IPC 在 `main.ts`
（`skills-set-enabled` / `skills-disabled-list` / `import-skill-folder` / `select-skill-import-file`），
preload 暴露为 `window.electron.*`。**内置技能不给开关**：它们是 `builtin://` 合成路径、
随应用更新，界面上如实写明原因而不是放一个点不动的按钮。

技能的新建/编辑/删除/导出/导入走 ACP 的 `sourcesCreate/Update/Delete/Export/Import`，
`SourceEntry.content` 本身带完整正文，所以详情面板不需要额外的读文件调用。

### 用户技能（无需改 Rust）

用户级技能目录：`~/.agents/skills/`、`.agents/skills/`、`.goose/skills/`、`.claude/skills/`。
每个技能是 `SKILL.md` + 可选 `scripts/`、`references/`、`assets/`（会递归收集，用
`load_skill(name:"skill/scripts/x")` 按需加载）。

### Recipe（无需改 Rust）

Recipe 是参数化工作流（YAML），可无人值守跑、可被调度器定时执行。已内置 4 个：

- `workflow_recipes/math_modeling/recipe.yaml` — 通用建模全流程
- `workflow_recipes/cumcm/recipe.yaml` — 国赛（CUMCM）全流程，中文论文
- `workflow_recipes/mcm/recipe.yaml` — 美赛（MCM/ICM）全流程，英文论文 + 摘要页
- `workflow_recipes/daily_paper_digest/recipe.yaml` — 每日论文抓取（可定时调度）

三个论文类 Recipe 的 `extensions` 里已显式声明 `builtin: modeling`，保证 CLI/无人值守
场景下 `compile_latex`、`check_env` 一定可用（桌面端另由 `bundled-extensions.json` 默认开启）。

分发方式：本地路径 / GitHub repo / deeplink。

### 自研 MCP（`crates/goose-mcp/src/modeling/`）
新增内置 MCP 服务 `ModelingServer`（server 名 `goose-modeling`），提供两个工具：

- `check_env`：检测 Python（python3/python/py）、uv、LaTeX/Typst 编译器（latexmk/pdflatex/
  xelatex/lualatex/tectonic/typst）并报告版本；`install_uv=true` 时按平台安装 uv。
- `compile_latex`：编译 `.tex`/`.typ` 文档（默认 latexmk，可指定引擎），成功返回 PDF 路径，
  失败解析并返回错误行（`!` / `l.<n>` / `error`）。

Rust 侧注册在三处（缺一处就会编译失败或工具不可用）：

1. `crates/goose-mcp/src/lib.rs` — `pub use modeling::ModelingServer;` + `BUILTIN_EXTENSIONS`
   里加 `builtin!(modeling, ModelingServer)`（这是 **CLI/内核侧的解析名字表**）
2. `crates/goose-mcp/src/mcp_server_runner.rs` — `McpCommand::Modeling` 及其 `FromStr`/`as_str`
3. `crates/goose-cli/src/cli.rs` — `handle_mcp_command` 的分支

**桌面端还需要第 4 处**（容易漏）：`ui/desktop/src/components/settings/extensions/bundled-extensions.json`。
UI 的扩展列表由这个 JSON 通过 `syncBundledExtensions()` 写入 `config.yaml`；只改 Rust 的话
桌面版**看不到也调不到**该扩展，只有 `goose mcp modeling` 命令能跑。现已加入并默认 `enabled: true`。

---

## 五、还差什么（后续路线）

### P0 收尾（白标完整化）

- [x] 替换图标 `icon.png`/`icon@2x.png`/`icon-512.png`/`icon.ico`（带 alpha 通道，已实测）
- [x] `icon.icns`（PNG 载荷，11 项，含 16/32/64/128/256/512/1024）与 `icon.svg`（由
      `brand-mark.json` 生成，非逐行近似）
- [x] `iconTemplate*.png`（macOS 托盘模板图，纯黑 + alpha，系统可自适应明暗）
- [x] 替换 UI 内 Logo：新 `ModelForgeLogo`/`ModelForgeMark` 组件，删除 `GooseLogo.tsx`、
      `icons/Goose.tsx`、`icons/Geese.tsx` 与 `goose-icon-*` 动画 CSS
- [x] i18n 16 语言 ~1100 处去 Goose 化 + TS 源码 68 处 `defaultMessage` 同步 + `main.ts`
      菜单/标题/托盘文案
- [ ] 首启引导/隐私/遥测弹窗**人工过一遍**（文案已替换，但界面观感未逐一目视验收）
- [ ] 把 `app-update.yml` / `githubUpdater.ts` 的 `your-org`/`modelforge` 换成真实 GitHub 仓库
- [ ] `goose://` deeplink 是否改名为 `modelforge://`：需同时改 `forge.config.ts` 协议注册、
      `createSession` 解析与已发布链接，属独立决策
- [ ] `main.ts` 里的中文菜单翻译表只覆盖 zh-CN，其他语言菜单仍走英文原文

### P1 领域可用（已完成）

- [x] 6 个核心 SKILL.md（总流程/论文/绘图/评审/文献检索/数据集检索），全部中文并带路由
- [x] 32 个方法论技能（描述中文化）+ 4 个工具技能（doctor / 智能优化 / draw.io / nature-figure）
- [x] 3 个 Recipe（国赛/美赛/每日论文抓取）+ 1 个通用流程，均指向内置真实模板
- [x] 自研 MCP：`compile_latex` + `check_env`，并已在桌面端注册
- [x] 自研脚本：文献检索与 BibTeX 生成、数据集来源登记（均实测通过）

### P2 产品化（1–2 月）

- [x] 图表模板库：**90 个产品内置模板（已提取）+ 14 个自建模板**，图库 104 条目录
      （其中 **102 条可用**；2 条 cartopy 模板为「模板待补充」，需 MSVC 构建工具——见 A14 的说明）
- [x] 其余赛事模板：已从已安装产品提取 14 套真实模板（许可状态见 NOTICE.md，其中 7 套未声明许可）
- [x] `doctor`：以技能形式落地（检测走 `modeling__check_env`，安装方案含大陆镜像）
- [x] 工具技能补齐：`paper-search` / `data-search` 带自研脚本，`metaheuristic-optimization`、
      `paper-diagram`、`nature-figure` 已内置
- [ ] 安装包签名/公证 + 自动更新流水线

### P3 商业化（可选，数月）

- [ ] 自建后端：账号/计费/技能市场/论文社区/协作（goose 本身不含这些）

---

## 六、合规红线（务必遵守）

1. **不打包 `claude.exe` / Claude Code**，不用 TS 版 `@anthropic-ai/claude-agent-sdk`（非 MIT）。
   运行时用 goose 自带的 Rust 内核（Apache-2.0）。
2. **不预置 API key**。
3. **不改 Rust 内核大逻辑**（避免 fork 漂移丢安全更新）；定制尽量隔离在
   config / skills / recipes / 自研 MCP 扩展。
4. **商标**：保留 Apache-2.0 license 与版权声明、标注修改、不得暗示官方背书、
   产品名别用 "Goose"。
5. 上游 `jihe520/MathModelAgent` **无 LICENSE 且禁商用**，其代码与技能正文不可照抄，
   只能参考「结构」；正文请用 MIT 的 `Lupynow/math-modeling-skills`、
   `mathmodel-studio` 等起步并自行重写。
6. 引入的第三方模板资产必须在 `NOTICE.md` 登记来源与许可；仓库内保留其原始 `LICENSE`。

---

## 七、验证状态（本机实测）

已装 `pnpm 10.30.0` 依赖并跑通：

| 检查 | 命令 | 结果 |
|---|---|---|
| TS 类型 | `pnpm run typecheck` | ✅ 通过 |
| ESLint | `eslint src/**/*.{ts,tsx} --max-warnings 0` | ✅ 通过 |
| i18n 与源码一致 | `pnpm run i18n:check` | ✅ 通过（1673 条） |
| i18n 各语言完整 | `pnpm run i18n:validate-locale` | ✅ 15 个语言通过 |
| 品牌矢量与真源一致 | `pnpm run brand:check` | ✅ 通过 |
| 文档数字与文件系统一致 | `pnpm run docs:check` | ✅ 通过（技能/模板/连接器/算法/i18n 计数跨四个文档核对） |
| **技能引用的资产真实存在** | `pnpm run docs:check` | ✅ 通过（**本轮新增**：技能正文、目录文件、主页预设指向的模板/脚本/入口文件逐个核对） |
| 连接器 MCP 握手 | `pnpm run connectors:check` | ✅ **8/8 通过**（真实 initialize + tools/list，非仅命令解析） |
| 内置技能 frontmatter | `node scripts/check-skills.js` | ✅ 47/47 |
| 自研脚本实测 | `paper_search.py` / `record_source.py` | ✅ 检索、DOI 交叉验证、BibTeX 生成、伪 DOI 拒绝、来源登记与去重全部实测通过 |
| renderer 生产构建 | `vite build --config vite.renderer.config.mts` | ✅ 2.5s，14 张绘图 + 17 张论文预览全部产出 |
| 绘图模板端到端 | `pnpm run figures:build` | ✅ 14/14 出图（图库 104 条目录，102 条可用） |
| 论文模板端到端 | `pnpm run papers:build` | ✅ **17/17 编译通过**（16 套 xelatex + 1 套 typst），全部为真实竞赛模板 |
| 绘图模板端到端 | `pnpm run figures:mathmodel` | ✅ **88/90 渲染**（2 个 cartopy 模板需 MSVC 构建工具） |
| 连接器安装路径 | 人工核实（见 REPLICATION_PLAN A5） | ✅ 包名/许可/命令逐条核实，命令实测可解析 |
| 样例题数据可复现 | `python generate_data.py` ×3 | ✅ 生成成功，重生成哈希一致 |
| 单测（并行） | `vitest run` | 788 通过 / 34 失败 |
| 单测（串行） | `vitest run --no-file-parallelism` | **834 通过 / 4 失败**（含目录页与技能页新增的 12 条测试） |

**单测请以串行结果为准**：并行下失败数在 8–34 之间波动（`userEvent` 超时对 CPU 竞争敏感），
串行稳定为 4 个失败、每次同样 2 个文件，且均为既有环境问题：

- `desktopFileAccess.test.ts` 2 项：Windows 临时目录大小写差异
  （期望 `C:\WINDOWS\TEMP`，实际 `C:\Windows\Temp`）。
- `CustomProviderForm.test.tsx` 2 项：`userEvent` 5s 超时；**已实测排除本改动**
  （临时移除 modeling 扩展后仍失败，单文件运行通过）。

**已不在"未验证"之列**：Rust 侧已按 `build-kernel.ps1` 用 GNU 目标编译成功（见
`REPLICATION_PLAN.md` 的 A13），桌面端已实跑；**复刻新增页面已在真实应用内逐页验收**
（见下面的 A14）。仍未验证的只剩 `electron-forge make`——安装包外观与 icns 在 macOS 上的
实际显示，需要打包机器才能确认。

### A14：桌面端实跑 + 七页逐个验收（本轮）

用自编译内核把桌面端真正跑起来，并逐页核对渲染结果。启动方式（两条命令，与 A13 一致）：

```powershell
.\build-kernel.ps1            # 需要重编内核时才跑
# 带远程调试端口启动，便于逐页抓 DOM 与截图：
$env:GOOSE_BINARY = 'E:\goose-build\target\debug\goose.exe'
$env:GOOSE_TELEMETRY_OFF = '1'
Set-Location ui\desktop
node ..\node_modules\@electron-forge\cli\dist\electron-forge.js start -- --remote-debugging-port=9222
```

> **不要用 `npx pnpm exec electron-forge start -- --remote-debugging-port=…`**：`npx` 会吞掉
> `--` 分隔符，electron-forge 收到裸选项后直接报 `unknown option` 退出。

#### 阻断级缺陷（已修）：Vite 只绑 IPv6，Electron 走 IPv4 → 全窗口白屏

| 项 | 内容 |
|---|---|
| 现象 | 窗口停在 `chrome-error://chromewebdata/`，`document.body.innerText` 长度为 0，逐路由截图全部是同一张白图 |
| 根因 | 本机 `localhost` 解析到 **`::1`**，Vite 默认 `server.host = 'localhost'` 于是**只监听 IPv6**；Chromium 解析 `localhost` 走 IPv4 `127.0.0.1` → `net::ERR_CONNECTION_REFUSED`。用 CDP 分别导航 `[::1]:5173`（`ERR_NETWORK_ACCESS_DENIED`）与 `127.0.0.1:5988`（`ERR_INVALID_HTTP_RESPONSE`，即确实连上了内核端口）对照确认：不是 Chromium 禁回环，就是没人在 IPv4 上监听 |
| 修法 | `ui/desktop/vite.renderer.config.mts` 增加 `server: { host: '127.0.0.1' }`（仍只监听回环，安全面不变） |
| 验证 | 重启后主进程日志出现 `React ready event received`，7 个路由全部渲染出真实内容 |

这个坑值得单独记：**它不是"页面写错了"，而是开发服务器压根没被访问到**——只看截图会误判成
"前端组件坏了"，从 DOM 文本长度为 0、`href` 是 `chrome-error://` 才定位到网络层。

#### 逐页验收结果（7/7 渲染成功，数据均来自真实数据源）

| 路由 | 渲染出的关键内容 | 判定 |
|---|---|---|
| `/`（主页） | 品牌头「数学建模助手」、工作流预设（写论文/建模报告/出图/排版）、赛事预设（国赛 CUMCM、国赛 Typst、美赛、华数杯、MathorCup、亚太赛、自定义）、3 张示例卡片、侧栏「扩展」可展开为技能/模板/算法/插件/连接器 | ✅ |
| `/skills` | 「共 47 个技能」+「已启用 47」分组；每条含中文触发式描述与「内置」来源；新建技能/导入文件夹/导入文件 | ✅ |
| `/algorithms` | 23 条方法卡片 + 8 个分类筛选；详情面板含依赖、许可、调用入口、适合什么时候用/需要什么数据/会得到什么/不适合的情况；「在测试中使用」 | ✅ |
| `/figures` | 104 条目录 + 16 个分类；详情栏含缩略图与「使用此模板」 | ✅（计数问题见下） |
| `/paper` | 17 套（内置 · 赛事模板 14 + 上游开源模板 3）；详情栏含编译首页预览、语言/来源/许可、模板文件夹与入口文件、封面信息表单、「使用此模板写论文」/「基于此模板自定义」 | ✅ |
| `/connectors` | 内置 5（modeling/developer/computercontroller/autovisualiser/memory）+ 可连接 8（arXiv、Web Fetch、Zotero、GitHub、Context7、draw.io、引用真实性校验、FRED）；「添加自定义连接器」 | ✅ |
| `/profile` | 会话数/提示词/活跃天数/当前与最长连续天数/项目数、活跃度热力图、最常用供应商/模型/项目、模型占比；并如实写明「Token 与费用……此处尚未做汇总」 | ✅ |

验收方式说明：本机当前模型不支持读图，所以**视觉终检交给上面的截图**，本轮做的是
**DOM 级功能验收**（逐路由提取渲染后的正文，核对条数、分类、按钮与详情字段），
截图存于 `E:\桌面\智能体\screenshots\`（`01-hub` … `07-profile`）。

#### 本轮发现的两处"界面与内容不一致"（未修，待决）

1. **`/figures` 同一个页面两个数字**：筛选条写「全部 104」，页脚写「共 102 个模板」。
   差的那 2 条是 `available: false`（依赖 cartopy，需 MSVC 构建工具，见 `figures:mathmodel`
   的 88/90），界面上显示为「模板待补充」。**因此本文档此前写的「图库 104 条零占位」是错的**
   ——占位确实还有 2 条，只是它们被 `availableCount` 从页脚计数里排除了（104 是目录总数，
   102 是可用数）。要么把页脚改成「102 可用 / 共 104」，要么补齐这两个模板。
2. **主页卡片把真实赛题称作「样例题」**：`src/catalog/homePresets.ts` 现在指向的是从产品提取的
   **真实赛题**（2023 国赛 A 题、2023 华数杯 C 题、2024 高教社杯 C 题，官方题面 PDF 在
   `math_modeling/assets/examples/`），但界面标题仍是「试试这些数模样例题」、徽标仍是
   「已附带样例题数据」（i18n `hub.examplesTitle` / `hub.exampleReady`）。这是 A6 的
   "自编样例题"决策被 A11/A12 的"提取真实赛题"取代后**文案没跟上**；而且它还牵连到
   分发口径——`strip-unshippable.js` 会把真题删掉，删掉之后这两句文案才重新成立。

#### 一处开发模式的正常运行噪音（不是回归，但要知道）

启动日志有 3 条 `Failed to copy shim uv.exe / uvx.exe / npx.cmd`（`ensureWinShims` ，
ENOENT）。开发模式下 `resources/bin` 没有填充（打包时才由
`prepare-platform-binaries.js` 按哈希放入），所以 shim 拷不出来。含义是**开发模式下
依赖 `uvx` / `npx` 的连接器解析不到命令**——`connectors:check` 是单独跑通的，
两者不要混为一谈。

**反过来，本机可用的工具已用上**：装有 TeX Live 2024
（`E:\texlive2024\texlive\2024\bin\windows`，含 `xelatex`/`latexmk`/`pdftoppm`/`pdfinfo`），
所以 6 套论文模板是**真的编译验证过**的；绘图模板也是真的渲染过并逐张检查输出。
`uv` 也已用于解析 matplotlib。

仍未验证的部分：
1. ~~页面在真实应用内的展示需要跑起来才能确认~~ → 已做（见 A14）：DOM 级逐页通过，
   缩略图裁切比例等纯视觉项需人工看 `screenshots\` 里的图。
2. ~~Typst：本机没有可用命令行，`cumcm-typst` 只内置库文件、未写入入口文件~~ → 已解决
   （见 `REPLICATION_PLAN.md` 的 A2：取得 typst 0.15.1 预编译二进制、补写 `paper.typ`、
   并改为本地 `theorems.typ` 免联网，17/17 编译通过）。
3. 各赛事**当年度**格式规范会变，骨架不等于合规保证。

`App.test.tsx` 曾因文案断言陈旧失败，已随去 Goose 化同步修正。

---

## 八、本次改动清单（git 视角）

### 外壳层复刻（对齐目标产品信息架构）

```
ui/desktop/src/catalog/{algorithms,figures,papers,connectors,homePresets}.ts   新增：内容数据源
ui/desktop/src/components/AlgorithmsView.tsx              新增：/algorithms
ui/desktop/src/components/FigureTemplatesView.tsx         新增：/figures
ui/desktop/src/components/PaperTemplatesView.tsx          新增：/paper
ui/desktop/src/components/ConnectorsView.tsx              新增：/connectors
ui/desktop/src/components/ProfileView.tsx                 新增：/profile
ui/desktop/src/hooks/useNavigationItems.ts                重写：NavItem / NavGroup / CATALOG_SUB_ITEMS
ui/desktop/src/components/Layout/NavigationPanel.tsx      扩展分组 + 子项行
ui/desktop/src/components/Hub.tsx                         主页品牌头 + 预设栏 + 真题卡片
ui/desktop/src/components/ChatInput.tsx                   新增 presetPrompt 入口
ui/desktop/src/App.tsx                                    新增五个路由
ui/desktop/scripts/i18n-translations.js                   新增：新文案的翻译/补齐/清理
REPLICATION_PLAN.md                                       新增：分阶段复刻计划与验证记录
```

### 能力层（论文模板 + 科研绘图模板 + 算法库）

```
crates/.../math_paper/assets/templates/cumcm-latex/**        新增：MIT 类 + paper.tex 骨架（编译通过）
crates/.../math_paper/assets/templates/jxust-latex/**        新增：MIT 类 + paper.tex 适配（编译通过）
crates/.../math_paper/assets/templates/mcm-icm-latex/paper.tex   新增：自写 Summary Sheet 骨架（编译通过）
crates/.../math_paper/assets/templates/{apmcm,mathorcup,shuweibei,huashubei,wuyi,diangongbei,dongsansheng,huazhong}-latex/paper.tex
                                                             改写：内置真实竞赛模板目录（17 套，全部编译通过）
crates/.../math_paper/assets/templates/README.md             改写：模板清单、构建前提、未内置原因
crates/goose/src/skills/builtins/math_paper.md               改写：列出 6 套模板与编译前提
crates/.../math_figure/assets/templates/_style.py            新增：共享风格、CJK 字体探测、流程图元
crates/.../templates/flowchart/five_band_roadmap.py          新增：五阶段技术路线图
crates/.../templates/flowchart/three_stage_pipeline.py       新增：三阶段问题驱动路线图
crates/.../templates/flowchart/three_column_framework.py     新增：三栏研究框架图
crates/.../templates/model-evaluation/roc_cross_validation.py      新增：交叉验证 ROC
crates/.../templates/model-evaluation/sensitivity_curves.py        新增：灵敏度分析 + 容差区间
crates/.../templates/model-evaluation/model_radar.py               新增：多模型 × 多指标雷达
crates/.../templates/model-evaluation/metric_heatmap.py            新增：模型 × 指标热力图
crates/.../templates/distribution/data_overview.py                 新增：数据体检四联图
crates/.../templates/flowchart/hierarchical_structure.py           新增：层次结构图
crates/.../templates/flowchart/horizontal_pipeline.py              新增：横版流水线图
crates/.../templates/_style.py                                     新增：enable_utf8_stdout() 修 Windows 控制台编码崩溃
crates/.../templates/combination/correlation_combined.py           新增：相关性组合图
crates/.../templates/distribution/paired_distributions.py          新增：半小提琴+箱线+散点
crates/.../templates/machine-learning/feature_importance_beeswarm.py 新增：重要性+蜂群图
crates/.../templates/spatial/response_surface_3d.py                新增：响应面 3D + 等高线
crates/goose/src/skills/builtins/math_figure.md              改写：列出 9 个绘图模板与图元用法
ui/desktop/src/catalog/papers.ts                             改写：6 套可用（含编译首页预览）
ui/desktop/src/catalog/algorithms.ts                         扩写：14 → 23 条，新增时间序列/降维分类
ui/desktop/src/catalog/figures.ts                            改写：9 条真实模板（含预览图引用）
ui/desktop/src/catalog/connectors.ts                         改写：核实包名/许可/入口，加 install 配置与凭据定义
ui/desktop/src/catalog/homePresets.ts                        改写：三张示例卡片指向自编样例题
crates/.../math_modeling/assets/samples/**                   新增：3 个自编样例题（题面 + 生成脚本 + 合成数据）
crates/goose/src/skills/builtins/math_modeling.md            改写：加样例题清单 + 新技能指引
crates/goose/src/skills/builtins/{code_and_reproducibility,model_comparison,assumptions_and_notation,result_visualization,abstract_and_conclusion}.md  新增：工程与写作技能
ui/desktop/src/components/PaperTemplatesView.tsx             新增：编译首页预览展示
ui/desktop/src/components/ConnectorsView.tsx                 改写：真实安装动作 + 凭据对话框 + 已装状态
ui/desktop/scripts/build-figures.js                          新增：可复现地重建全部绘图预览
ui/desktop/scripts/build-paper-templates.js                  新增：生成三套中文骨架
ui/desktop/scripts/build-paper-previews.js                   新增：编译全部论文模板并出首页预览
ui/desktop/scripts/vendor-paper-templates.js                 新增：从上游拉取内置类文件
ui/desktop/src/assets/{figures,papers}/**                    新增：15 张图库缩略图（生成物）
ui/desktop/package.json                                      新增 figures:* / papers:* / templates:vendor
```

### 白标（P0，前一轮）

```
crates/goose/src/prompts/system.md                        (改写)
crates/goose/src/prompts/subagent_system.md               (改写)
crates/goose/src/skills/builtins/math_modeling.md         (新增)
crates/goose/src/skills/builtins/math_paper.md            (改写：引用模板资产)
crates/goose/src/skills/builtins/math_figure.md           (新增)
crates/goose/src/skills/builtins/math_review.md           (新增)
crates/goose/src/skills/builtins/paper_search.md          (新增)
crates/goose/src/skills/builtins/data_search.md           (新增)
crates/goose/src/skills/builtins/math_paper/assets/templates/**  (新增：国赛 LaTeX/Typst 模板)
crates/goose-mcp/src/modeling/mod.rs                      (新增，自研 MCP)
crates/goose-mcp/src/lib.rs                               (注册 modeling MCP)
crates/goose-mcp/src/mcp_server_runner.rs                 (新增 McpCommand::Modeling)
crates/goose-cli/src/cli.rs                               (注册 modeling 命令)
workflow_recipes/{math_modeling,cumcm,mcm}/recipe.yaml    (新增；补 builtin modeling)
workflow_recipes/daily_paper_digest/recipe.yaml           (新增)
ui/desktop/package.json                                   (改写 + brand:* 脚本)
ui/desktop/index.html / forge.config.ts / forge.*.desktop  (改写)
ui/desktop/src/app-update.yml                             (改写)
ui/desktop/src/branding.ts                                (新增：外链集中管理)
ui/desktop/src/brand-mark.json                            (新增：标记唯一真源)
ui/desktop/src/images/*                                   (全部重生成 + modelforge-logo.png)
ui/desktop/src/components/icons/ModelForge.tsx            (新增，生成物)
ui/desktop/src/components/ModelForgeLogo.tsx              (新增)
ui/desktop/src/components/{GooseLogo.tsx,icons/Goose.tsx,icons/Geese.tsx}   (删除)
ui/desktop/src/{main.ts,suspense-loader.tsx}              (改写)
ui/desktop/src/i18n/messages/*.json                       (16 语言去 Goose 化 + 新文案)
ui/desktop/src/utils/{autoUpdater,githubUpdater,winShims}.ts (改写)
ui/desktop/src/styles/main.css                            (删除失效动画 CSS)
ui/desktop/scripts/build-brand-{icons,mark,vector}.js     (新增)
ui/desktop/scripts/{rebrand-i18n,rebrand-source,rename-hints-message-ids,sort-i18n,check-skills}.js (新增)
NOTICE.md                                                 (新增)
MODELFORGE_CUSTOMIZATION.md                               (本文件)
```

### 工具技能层与一致性修复（本轮）

```
crates/goose/src/skills/builtins/math_figure.md            重写：配图路由（自带模板/内置模板/nature-figure/paper-diagram/TikZ）
crates/goose/src/skills/builtins/math_paper.md             重写：模板来源→确认模型→逐问求解→配图→真实引用→编译→自评
crates/goose/src/skills/builtins/math_review.md            重写：六维 0–10 + 致命项 + review.md 产物
crates/goose/src/skills/builtins/math_modeling.md          重写：中文全流程；选型表 32 行并接入新技能
crates/goose/src/skills/builtins/paper_search.md           重写：改用自研脚本，禁止凭记忆写引用
crates/goose/src/skills/builtins/paper_search/scripts/paper_search.py        新增：双引擎检索/verify/bib（纯标准库）
crates/goose/src/skills/builtins/data_search.md            重写：来源评估表 + 溯源登记
crates/goose/src/skills/builtins/data_search/scripts/record_source.py        新增：data/sources.json（SHA-256/许可/日期）
crates/goose/src/skills/builtins/data_search/references/source-routing.md    新增：按权威度排列的国内外数据来源
crates/goose/src/skills/builtins/doctor.md + doctor/references/install.md    新增：环境检查与安装向导（含大陆镜像）
crates/goose/src/skills/builtins/metaheuristic_optimization.md               新增：MEALPY / pymoo 智能优化
crates/goose/src/skills/builtins/paper_diagram.md                           新增：draw.io 示意图（可编辑 .drawio）
crates/goose/src/skills/builtins/nature_figure.md + nature_figure/**         新增：Apache-2.0 技能整包内置
crates/goose/src/skills/builtins/*.md（31 个方法论技能）                     描述改为中文触发式
crates/.../math_paper/assets/templates/README.md           重写：17 套模板的真实清单与字体剥离说明
ui/desktop/src/utils/composerSeed.ts                       新增：目录页→首页输入框的一次性种子槽
ui/desktop/src/components/FigureTemplatesView.tsx          新增「使用此模板」+ 分类中文标签
ui/desktop/src/components/PaperTemplatesView.tsx           新增封面信息表单 +「使用此模板写论文」
ui/desktop/src/components/catalogTemplateActions.test.tsx  新增：两条「使用此模板」路径的自动化测试（4 条）
ui/desktop/src/catalog/homePresets.ts                      修正：赛事预设指向已内置的真实模板
ui/desktop/src/catalog/{papers,figures}.ts                 重新生成：带封面字段 / 统一 script 基准 / 补齐分类标签
ui/desktop/scripts/generate-papers-catalog.js              扩展：输出 fields 与 profileFields
ui/desktop/scripts/generate-figures-catalog.js             修正：script 统一相对 assets/，补 4 个分类中文标签
ui/desktop/scripts/docs-check.js                           扩展：校验技能正文/目录/预设引用的资产是否存在
ui/desktop/scripts/build-paper-previews.js                 修正：改为在临时副本里编译，模板目录不再留编译产物
ui/desktop/scripts/check-connectors.js                     修正：Windows 上经 npx-cli.js 启动 npx；spawn 失败不再整体崩溃
ui/desktop/src/components/skills/SkillsView.tsx            重写：分组/详情/启停/增删改导入导出
ui/desktop/src/utils/skillEnablement.ts                    新增：技能目录移入移出停用库（纯 fs，可单测）
ui/desktop/src/acp/sources.ts                              扩展：技能 CRUD 与导入导出的 ACP 封装
ui/desktop/src/main.ts + src/preload.ts                    新增 4 个 IPC：启停、停用列表、导入文件夹、读取导入文件
ui/desktop/src/components/AlgorithmsView.tsx               新增「在测试中使用」建会话
ui/desktop/src/components/PaperTemplatesView.tsx           新增分组、默认用于、基于此模板自定义
ui/desktop/src/components/ConnectorsView.tsx               新增「添加自定义连接器」
ui/desktop/src/components/ProfileView.tsx                  新增连续天数与模型占比
ui/desktop/src/components/skills/SkillsView.test.tsx       新增 4 条技能页测试
ui/desktop/src/utils/skillEnablement.test.ts               新增 8 条启停逻辑测试
workflow_recipes/{cumcm,mcm}/recipe.yaml                   指向内置真实模板与 paper-search
crates/goose/src/skills/builtins/math_paper/assets/templates/{changsanjiao,diangongbei,shuweibei}/fonts/  删除空目录
```

---

## 九、Agent 内核（Claude Code / Codex 作为可选智能体循环）

目标：用户在软件里配置一次 API（现有 provider 设置），就能选择用**成熟 CLI 的智能体循环**跑会话，
不需要装 CLI、不需要中转、不碰用户全局配置。默认仍是内置内核，行为逐字节不变。

### 9.1 为什么需要"形态转换"

| 内核 | 它只会说的 API | 用户配的 API（DeepSeek 等） |
|---|---|---|
| 内置内核（goose） | OpenAI Chat Completions | ✅ 直接可用 |
| Claude Code | Anthropic `/v1/messages` | ❌ 形态不同 |
| Codex 0.146+ | OpenAI **Responses**（`wire_api="chat"` 已被官方移除） | ❌ 形态不同 |

因此 App 内自带两个 localhost 转换代理（**它们的代码在本仓库里**，不依赖外部 router）：

- `ui/desktop/src/utils/anthropicShim.ts`：Anthropic `/v1/messages` ⇄ Chat Completions
  （文本、tool_use/tool_result、工具定义、SSE 流式、usage、模型名强制覆盖）
- `ui/desktop/src/utils/responsesShim.ts`：Responses `/v1/responses` ⇄ Chat Completions
  （含 `response.created`/`output_item.added`/`output_text.delta`/`function_call_arguments.delta`/`response.completed` 事件序列）

实测踩到的四个必须处理的点（已固化在代码里）：Claude Code 忽略进程环境变量、只认自己的配置目录
（必须 `CLAUDE_CONFIG_DIR` 隔离）；Codex 用 Responses 专有角色 `developer`（要映射成 `system`）；
两个内核都会请求 `claude-*` / `gpt-*` 模型名（代理侧强制覆盖为用户所选模型）；
客户端只带占位 token，真 key 只存在 App 主进程侧。

### 9.2 装配（M2，已完成）

```
用户设置页（设置 → 应用 → 智能体内核）
  runtime = builtin | claude-code | codex
        │
        ├─ 主进程 utils/agentKernel.ts：解析用户 provider（base_url/model/key）
        │     · provider 解析顺序：设置里显式指定 → 内置内核记住的 provider → goose 当前 provider
        │       → 第一个自带 endpoint 的自定义 provider（跳过 claude-acp/codex-acp 这类内核自身 provider）
        │     · 密钥：内核专用密钥（safeStorage 加密）→ provider 设置里保存的密钥（safeStorage 加密）
        │       → 环境变量 → goose 的 secrets.yaml（若启用了文件存储）
        │     · 起对应 shim（127.0.0.1 随机端口）+ 生成隔离配置目录
        │       ~/.config/ModelForge/agent-runtimes/agent-runtime-{claude,codex}/
        │
        ├─ gooseServe.ts：把上述环境变量并在 goose serve 的 spawn 环境里
        │     （goose 再用同样的环境拉起 claude-agent-acp / codex-acp 适配器）
        │
        └─ 渲染层 acp/agentKernelDefaults.ts：把会话默认 provider 指向 claude-acp / codex-acp
              （goose 只接受"已配置"的 provider，因此先 providersConfigSave 启用适配器；
                切回内置内核时恢复原来的 provider/model）
```

新增/改动文件：

| 文件 | 作用 |
|---|---|
| `ui/desktop/src/utils/anthropicShim.ts` | Anthropic ⇄ Chat 转换（可独立运行：`SHIM_UPSTREAM_*` 环境变量） |
| `ui/desktop/src/utils/responsesShim.ts` | Responses ⇄ Chat 转换（同上） |
| `ui/desktop/src/utils/agentRuntime.ts` | 给定 `{runtime, baseUrl, apiKey, model}` → 起 shim + 写隔离配置目录 + 返回要注入的环境 + `dispose()` |
| `ui/desktop/src/utils/agentKernel.ts` | 内核总装：provider/密钥解析、状态、密钥库、生命周期 |
| `ui/desktop/src/utils/gooseProviderState.ts` | 直接读 goose 的 `config.yaml` / `custom_providers/*.json` 得到用户的 endpoint 与 key 变量名 |
| `ui/desktop/src/utils/agentKernelCapture.ts` | 在 App 里保存 provider key 时同步留一份（goose 经 ACP 不回传密钥） |
| `ui/desktop/src/acp/agentKernelDefaults.ts` | 启用内核 provider 并把会话默认 provider 指过去；切回时恢复 |
| `ui/desktop/src/components/settings/app/AgentKernelSection.tsx` | 设置页「智能体内核」：三选一 + 就绪自检 + 密钥 + 重启 |
| `ui/desktop/src/gooseServe.ts` | `setAgentRuntimeEnv()` 注入钩子（默认空对象，惰性） |
| `ui/desktop/src/main.ts` / `src/preload.ts` | 启动时 provision、退出时 dispose、5 个 IPC |
| `ui/desktop/scripts/verify-agent-kernel.js` | CDP 验收脚本（设置页断言 + 真实发消息 + 截图） |

### 9.3 实测证据（2026-09-13，三种内核各跑一遍）

启动方式（本机）：

```powershell
$env:GOOSE_BINARY = 'E:\goose-build\target\debug\goose.exe'
$env:ENABLE_PLAYWRIGHT = '1'; $env:PLAYWRIGHT_DEBUG_PORT = '9222'
$env:DEEPSEEK_API_KEY = '<你的 key>'   # 仅用于本次验证；正式使用在软件里填
Set-Location ui\desktop; npx --yes pnpm@10.30.0 exec electron-forge start
node scripts/verify-agent-kernel.js     # 另开一个终端
```

| 内核 | 设置值 | UI 断言 | 真实回包 | 主进程日志（证明走了代理） |
|---|---|---|---|---|
| 内置（回归） | `builtin` | 全部 PASS | `BUILTINOK`（模型 deepseek-flash） | 无 shim，`agent kernel: built-in`，`active_provider` 恢复 `custom_deepseek` |
| Claude Code | `claude-code` | 全部 PASS | `KERNELOK`（模型 `current`） | `[shim] → upstream model=deepseek-flash messages=3 tools=25 stream=true` / `← stream done stop=end_turn out=5` |
| Codex | `codex` | 全部 PASS | `CODEXOK`（模型 `current`） | `[shim] → upstream model=deepseek-flash messages=4 tools=7 stream=true` / `← stream done items=1 out=4` |

截图：`screenshots/08-agent-kernel-settings.png`、`09-agent-kernel-chat.png`、`10-agent-kernel-status.png`；
验收报告：`ui/desktop/test-results/verify-kernel/report.txt`。

**结论**：软件内配好 API → 设置里选内核 → 重启 → 会话即跑在该内核上，全程不碰用户全局 CLI 配置，
也不需要任何中转。

### 9.4 还没做（M3：随包分发）

- 把 `@agentclientprotocol/claude-agent-acp`、`@agentclientprotocol/codex-acp` 与 Claude Code / Codex CLI
  作为依赖打进安装包，并按平台注入 PATH（用户机器上没有 npm 全局包也能用）；
- 首启向导里的"内核就绪"检查（复用本节的状态接口）+ 失败可诊断提示；
- 打包体积与许可清单更新（`NOTICE.md`），以及随包分发的许可取舍（见 REPLICATION_PLAN 的合规红线）。

---

## 十、个人信息与设置合并（对齐参考产品的设置页格式）

参考产品（本机 `@mathmodeldesktop`）的设置是**整窗页面**：左侧是「返回应用 + 搜索设置 + 分区列表」，
右侧是分区内容，`个人资料` 是列表第一项；首页左下角只有一个账号入口 + 齿轮。本轮把我们的
「个人信息」页与「设置」页按同样的格式合并成一页。

### 10.1 结构

| 位置 | 之前 | 现在 |
|---|---|---|
| 首页左下角 | 两行：个人信息 / 设置 | 一行账号入口（头像 + 个人资料）+ 齿轮图标；两者都打开同一个设置页（账号入口直接定位到「个人资料」） |
| 设置页 | 顶部横向标签（模型/聊天/外部后端/提示词/键盘/身份验证/应用） | 整窗页：左侧竖向分区列表（**个人资料** / 模型 / 聊天 / 提示词 / 外部后端 / 键盘 / 身份验证 / 应用）+ 返回应用 + 搜索设置；设置页内隐藏全局导航 |
| 个人信息 | 独立页面 `/profile` | 设置页内的第一个分区；`/profile` 仍可用（自动跳转到设置页的个人资料） |

实现要点：

- `ui/desktop/src/components/Layout/AppLayout.tsx`：`/settings` 路径下隐藏全局导航与折叠按钮（整窗效果），
  ChatSessionsContainer 仍常驻，会话连接不断。
- `ui/desktop/src/components/settings/SettingsView.tsx`：分区定义表（图标 + 文案 + 内容组件）+
  搜索过滤 + 记忆上次分区（齿轮再次打开时回到上次位置）；旧的分区别名（`update`/`sharing`/`modes`…）
  仍映射到新分区，深链不受影响。
- `ui/desktop/src/components/settings/profile/ProfileSection.tsx`：由原 `ProfileView` 主体迁移而来
  （去掉页面外壳与重复标题，保留统计/活跃度/排行榜与刷新按钮）；`ProfileView.tsx` 已删除。
- `NavigationPanel.tsx` + `useNavigationSessions.ts`：底部单账号入口 + 齿轮，导航支持带 state 跳转
  （`handleNavClick(path, state)`）。
- i18n：新增 `settingsView.backToApp`、`settingsView.searchSettings`；`navigation.itemProfile` 复用作
  「个人资料」分区标题（zh-CN/zh-TW 已同步为「个人资料」），其余 13 个语言回退英文。

### 10.2 实测（CDP 走查，2026-09-13）

| 检查 | 结果 |
|---|---|
| 侧栏出现单一账号入口 | ✅ |
| 点击账号入口进入 `/settings` 并落在「个人资料」 | ✅ |
| 分区列表 = 个人资料/模型/聊天/提示词/外部后端/键盘/身份验证/应用 | ✅ |
| 个人资料统计（会话数/提示词/活跃度/排行）在设置页内渲染 | ✅ |
| 返回应用按钮、搜索设置输入框存在 | ✅ |
| 搜索「模型」→ 分区列表只剩「模型」 | ✅ |
| 设置页内全局导航隐藏（整窗） | ✅ |
| 返回应用后恢复全局导航 | ✅ |
| 「应用」分区里智能体内核仍然可用（回归） | ✅ |

截图：`screenshots/11-nav-account-entry.png`、`12-settings-profile-merged.png`、
`13-settings-models.png`、`14-settings-kernel.png`。

质量门：`typecheck` ✅、`eslint --max-warnings 0` ✅、`i18n:check` ✅、
`i18n:validate-locale` ✅（1882 条）、`docs:check` ✅、`App.test.tsx` 7/7 ✅、
`src/components/settings` + `src/hooks` 110/112 ✅（2 项失败为既有的 `CustomProviderForm` userEvent 超时，
与本次改动无关，已在 REPLICATION_PLAN 记录）。

---

## 十一、内核模式下的模型选择（适配用户的全部模型）

问题：切到外部内核后，goose 的默认 provider 变成 `claude-acp` / `codex-acp`，模型位只有一个
`current`，于是「模型」分区只显示 `current / Claude Code ACP`，用户自己那些模型（deepseek-flash、
deepseek-v4-pro…）全都选不到了。

关键约束（本轮实测）：**内核的模型位不能塞用户模型名**。实测把 `claude-acp` 的默认模型改成
`deepseek-flash` 后，会话直接报
`Failed to set ACP model option: invalid value for config option model: deepseek-flash` ——
Claude Code 适配器只接受它自己认识的模型。所以正确做法是：内核模型位保持 `current`，
**用户选的模型作用在「上游」**（也就是本地适配器转发出去的那一次请求）。

### 11.1 实现

| 层 | 改动 |
|---|---|
| 两个 shim | 新增 `setModel(model)`：模型在请求时读取，因此改完**下一条请求即生效**，不用重启内核、不用重启应用 |
| `agentRuntime.ts` | `ProvisionedAgentRuntime.setModel` 透传 shim 的 setter |
| `agentKernel.ts` | 新增 `setModel(model)`：仅当内核在运行时切换（更新状态 + 日志），否则明确报「内核未运行，无法切换模型」 |
| 主进程 / preload | 新增 IPC `agent-kernel-set-model` → `window.electron.setAgentKernelModel(model)` |
| `settings/models/KernelModelCard.tsx` | 新增「内核模型」卡片（仅外部内核时显示）：列出该 provider 的**全部模型**，选中即切换并 toast 提示 |
| `ModelsSection.tsx` | 内置内核时保持原样；外部内核时插入该卡片，并在旧卡片下加一行说明「内核自身固定使用 current 模型位，真正调用的模型见下方」 |
| i18n | 新增 `kernelModel.*`（9 条）与 `modelsSection.kernelSlotNote`，zh-CN/zh-TW 已翻译，其余语言回退英文 |

选择会写进 `settings.json → agentKernel.model`，重启后自动沿用（实测重启仍然生效）。

### 11.2 实测（2026-09-13）

| 检查 | 结果 |
|---|---|
| 「模型」分区出现「内核模型」卡片 | ✅ |
| 下拉列出用户 provider 的全部模型 | ✅ `["deepseek-flash","deepseek-v4-pro"]` |
| 选中 `deepseek-v4-pro` 后内核状态与设置同步 | ✅ `status.model = deepseek-v4-pro` |
| **不重启即生效** | ✅ 主进程日志：`[shim] upstream model switched to deepseek-v4-pro`（同一端口 10737，未重启） |
| 下一次对话真的用了新模型 | ✅ `[shim] → upstream model=deepseek-v4-pro messages=3 tools=25 stream=true` |
| 切换后对话正常回包 | ✅ |
| 重启应用后仍沿用所选模型 | ✅ 启动日志 `agent kernel: claude-code → … (model=deepseek-v4-pro)` |

截图：`screenshots/15-kernel-model-picker.png`、`16-kernel-model-dropdown.png`。
单测：`agentKernel.test.ts` 17 条（新增「热切换不重启」「内核未运行时报错」两条）全绿。

---

## 十二、内核模式下的上下文与压缩（细节打磨）

本轮把「引入内核」之后暴露的一批细节问题逐条修掉，全部在本机实测。

### 12.1 上下文窗口：内核报的是它自己的，不是你的模型的

问题：内核会话里上下文进度条显示的是 **Claude Code 自己的窗口**（实测见过 `18k / 1M`、`7k / 258k`），
而真正接请求的是用户的模型（例如 deepseek 128k）。于是进度条严重偏乐观，告警也不会在真正危险时触发。

修复：
- `utils/gooseProviderState.ts` 读取 provider 声明的每个模型的 `context_limit`；
- `agentKernel.ts` 把它放进内核状态（`contextLimit`，实测 `128000`）；
- `ChatInput.tsx` 把内核上报的窗口与上游窗口取 `Math.min`，进度条、告警阈值都按真实窗口算
  （实测会话里显示 `19k / 128k`，重启后依旧）。

### 12.2 压缩：goose 拒绝 → 交给内核，并说清谁负责

问题：内核模式下点「压缩」，goose 直接报
`/compact is not available for provider 'claude-acp' because it manages its own conversation context`。

两层修复：
1. **内核补丁**（`crates/goose/src/agents/execute_commands.rs`）：对 `manages_own_context()` 的 provider，
   `/compact` 与 `/clear` 不再报错，而是返回 `Ok(None)` 把命令**透传给内核**（内核自己认识这两个命令）。
   已用 `build-kernel.ps1` 重新编译（6 分 24 秒，47 个内置技能校验通过）。
   注：`check_if_compaction_needed` 本来就会跳过这类 provider，所以 goose 的自动压缩不会污染内核会话。
2. **实测结论**：Claude Code 通过 ACP 收到 `/compact` 时并不会当作本地命令执行（它把命令当普通提问回答：
   「上下文压缩是终端内置命令，由程序自动处理」）。因此 app 侧改成**不再提供误导性的按钮**：
   内核模式下隐藏「立即压缩」与 goose 的「自动压缩阈值」（两者对内核都无效），
   改成在进度条上方说明「上下文由 X 内核自行管理，接近上限时会自动压缩；进度条按你所用模型的窗口计算」。

### 12.3 上游错误翻译（让内核与用户都看得懂）

`utils/shimErrors.ts`（新）：把上游错误转成可执行的中文提示，并按内核期望的**错误类型**返回：

| 上游 | 转换后 |
|---|---|
| 401/403 | `authentication_error` + 指出去哪里重填密钥 |
| 404 | `invalid_request_error` + 提示检查 API 地址与模型名 |
| 429 / 402 | `rate_limit_error` / 余额不足提示 |
| 400 且含 context/too long | `prompt is too long: <原始信息>` + 中文提示，**保留原始措辞**（内核靠它触发反应式压缩），Responses 侧附 `code: context_length_exceeded` |
| 400 且含 tool/function | 提示该模型可能不支持 function calling，并建议可用的模型 |
| 5xx | 明确「上游服务异常，可重试」 |

### 12.4 其他细节

- **底部栏模型名**：内核模式下显示真正被调用的模型（`deepseek-v4-pro`），菜单里另有一段
  「内核模型」说明它在哪切换，不再只显示无意义的 `current`。
- **压缩入口可见性**：`Alert` 新增 `showAutoCompactThreshold`，AlertBox 在进度条形态下也会渲染 `message`
  （新增 2 条单测覆盖）。

### 12.5 本轮验证

| 检查 | 结果 |
|---|---|
| 内核状态带上游窗口 | ✅ `contextLimit: 128000` |
| 进度条按上游窗口 | ✅ 会话内 `19k / 128k`（内核自报为 1M） |
| 底部栏显示真实模型 | ✅ `deepseek-v4-pro` |
| `/compact` 不再被 goose 拒绝 | ✅ 已用重编内核实测 |
| 内核是否执行 /compact | ⚠️ 实测不会（CLI 视作普通文本）→ 已改为隐藏按钮 + 说明 |
| 内核模式下隐藏 goose 阈值/压缩按钮 | ✅ 单测 2 条 + 代码路径 |
| 上游错误翻译 | ✅ 类型与措辞按 Anthropic/Responses 规范 |
| 质量门 | `typecheck` / `eslint --max-warnings 0` / `i18n:check` / `i18n:validate-locale`(1895) / `docs:check` / `AlertBox` 18 条 / `agentKernel` 17 条 全绿 |

---

## 十三、内核会话的费用估算与上下文预警（本轮）

### 13.1 内核会话的费用估算

问题：内核会话底部一直显示 `$0.00`——因为 goose 认为 provider 是 `claude-acp`、模型是 `current`，
拿不到任何价格；而真正花钱的是用户的模型。

做法（不改 Rust、不动 ACP 协议）：

| 层 | 改动 |
|---|---|
| 设置 | `agentKernel` 新增 `inputTokenCost` / `outputTokenCost` / `currency`；「应用 → 智能体内核」多一张「模型计价（可选）」卡片（输入/输出每百万 token 单价 + 货币符号） |
| 计算 | 新增 `utils/kernelCost.ts`（纯函数：`estimateKernelCost` / `formatKernelCost`，含 4 条单测） |
| 展示 | `CostTracker` 检测到外部内核时改用「用户单价 × 内核上报 token」估算，显示 `≈ ¥0.04`，悬浮说明「按你填写的单价估算 + 内核/token 明细」；未填单价时明确提示去哪里填，而不是显示误导性的 `$0.00` |

实测：填入 输入 ¥2 / 输出 ¥8（每百万），跑一轮后底部显示 `≈ ¥0.04`（19k token 量级，数值与手算一致）。

### 13.2 上下文接近上限的主动提醒

问题：以前只有进度条颜色变化（≤75% 普通、≤90% 橙、>90% 红），很容易被忽略；而这轮已经把
进度条按**用户模型的真实窗口**计算，所以阈值本身是有意义的。

做法：`ChatInput` 在 80% / 95% 两个阈值各触发一次（每个会话只报一次，可升级不可重复）：

- 80%：警告 toast「上下文快满了 · 已用 93%（18,543 / 20,000 tokens）」+ 建议开新会话；
- 95%：错误级 toast「上下文即将占满 · 请立刻开始新会话」；
- 内核模式下文案会说明「{内核} 会自行压缩历史，但开新会话能让细节更可靠」；
- 窗口不在前台且用户开启了通知时，同时发一条系统通知（复用现有 `enableNotifications` + `isAnyWindowFocused` 逻辑）；
- 阈值判定抽成纯函数 `utils/contextWarning.ts`（`contextWarningLevel` / `shouldAnnounce`，5 条单测）。

实测（把 provider 声明的窗口临时改成 20k 以便触发，验完已还原为 128k）：一轮对话后弹出
「上下文快满了 · 已用 93%（18,543 / 20,000 tokens）。Claude Code 内核会自行压缩历史，但开新会话能让细节更可靠。」
截图：`screenshots/17-context-warning.png`。

### 13.3 质量门（本轮）

`typecheck` ✅ · `eslint --max-warnings 0` ✅ · `i18n:check` ✅ · `i18n:validate-locale` ✅（1910 条）·
`docs:check` ✅ · 单测：`kernelCost` 4 条 + `contextWarning` 5 条 + `agentKernel` 17 条 +
`AlertBox` 18 条 全绿。

---

## 十四、上下文窗口是「按模型」的：来源链、手动覆盖与热更新

### 14.1 现状（回答"窗口是不是固定的"）

窗口**不是固定的，也不是一个全局值**：它是每个模型各自的属性，代码按模型名解析。

解析顺序（`agentKernel.ts` + `acp/kernelContextLimit.ts`）：

1. **用户为这个模型手填的窗口**（`agentKernel.contextLimits[模型名]`，设置页「{模型} 的上下文窗口」）；
2. **provider 为该模型声明的窗口**（`custom_providers/<id>.json` 里的 `models[].context_limit`）；
3. **goose 的模型目录**（canonical model info，适用于内置 provider，如 deepseek/openai）；
4. **provider 清单**（ACP inventory 返回的 `contextLimit`）；
5. 都没有 → **未知**：这时不猜、不 clamp，进度条退回内核自报值，并在设置页明确提示"建议你填一个"。

例：你现在的 `custom_deepseek` 里两个模型都声明了 128000，所以切换 deepseek-flash / deepseek-v4-pro
都显示 128k；如果哪天某个模型声明 64000，它会自动按 64k 算，无需改代码。

### 14.2 本轮补的两件事

**① 手填覆盖 + 来源提示**：设置页新增「{模型} 的上下文窗口」卡片，并明确写出当前值来自哪里
（你填的 / provider 声明 / provider 没声明需要你填）。未知时不再默默用内核那个偏大的窗口。

**② 热更新（顺带修掉一个隐患）**：之前设置页保存后调用的是 `applyAgentKernel()`，它会
**销毁并重建 shim（换端口）**——而 goose serve 是在启动时把 shim 的 URL 写进环境变量的，
换端口会让正在运行的内核指向一个已经关闭的代理。现在改成：

| 变更 | 生效方式 |
|---|---|
| 模型 / 密钥 / 窗口 / 单价 | `refreshAgentKernel()`：就地更新（模型与密钥直接推给运行中的 shim），**端口不变**，立即生效 |
| 切换内核（内置 ⇄ Claude Code ⇄ Codex） | 只标记 `restartRequired`，设置页提示「内核已更改——重启 ModelForge 完成装配」，不再偷偷换端口 |
| shim 端口 | 仅在应用启动装配时确定，运行期间保持不变 |

主进程因此新增 IPC `agent-kernel-refresh`，并新增事件 `AppEvents.AGENT_KERNEL_CHANGED`：
设置页保存后广播，聊天输入框（进度条 + 预警）与费用估算会立即重新解析，不需要刷新页面。

### 14.3 实测（2026-09-13）

| 检查 | 结果 |
|---|---|
| 默认取 provider 声明 | ✅ `contextLimit: 128000, source: provider` |
| 手填覆盖优先 | ✅ 填 64000 → `contextLimit: 64000, source: override` |
| **端口不变**（不再重建 shim） | ✅ 改窗口前后都是 `http://127.0.0.1:4037` |
| 进度条热更新 | ✅ 会话内 `0 / 128k` → `0 / 64k`，无需刷新 |
| 切换内核 → 提示重启而非换端口 | ✅ `restartRequired: true`，shim 仍在运行 |
| 清空覆盖 → 回落到 provider 值 | ✅ `contextLimit: 128000, source: provider` |
| 单测 | ✅ `agentKernel.test.ts` 20 条（新增"按模型取 provider 值""覆盖优先""未知不猜"3 条） |

质量门：`typecheck` ✅ · `eslint --max-warnings 0` ✅ · `i18n:check` ✅ ·
`i18n:validate-locale` ✅（1916 条）· `docs:check` ✅ · `src/utils` 220 条单测全绿。
