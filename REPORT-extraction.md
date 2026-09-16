# 从已安装产品提取资产（REPORT-extraction.md）

你给的是 `mathmodel.lnk`，解析后指向已安装的原产品：

```
C:\Users\韩正阳\AppData\Local\Programs\@mathmodeldesktop\mathmodel.exe
resources\
  builtin-skills\       197 MB  ← 技能与模板资产（本次提取来源）
  builtin-examples\       2 MB  ← 真题题目与附件（本次刻意不提取）
  claude-code\          272 MB
  bin\                   65 MB
```

按你的要求"能不要自己写就先不要自己写"，本轮把**产品内置的真实模板**提取进来，替换了我之前手写的等价物。
下面分三部分：提取了什么、**哪些必须先跟你确认**、以及为什么。

---

## 一、提取了什么（可复现）

脚本：`ui/desktop/scripts/extract-product-assets.js`

| 来源 | 目标 | 文件数 | 大小 |
|---|---|---|---|
| `builtin-skills/mathmodel-figure-templates` | `math_figure/assets/mathmodel/` | 105 | 11.5 MB |
| `builtin-skills/mma-paper/assets/template` | `math_paper/assets/templates/`（14 套） | 177 | 0.9 MB |

**刻意没有提取**：

| 内容 | 原因 |
|---|---|
| `builtin-examples/**`（2023 国赛 A 题、2023 华数杯 C 题、2024 高教社杯 C 题） | 含竞赛官方题面 PDF、附件与**结果文件**。这是赛事方的版权material，没有任何许可允许我们随产品再分发 |
| **29 个嵌入字体**（KaiTi / SimSun / SimHei / LiSu / 方正书宋 / YaHei.Consolas / MONACO / Fira Code） | 约 118 MB 的**专有中文字体**，许可不允许再分发 |
| `assets/previews/*.webp`（90 张） | 我们自己在本地渲染预览，图库展示的是**本构建的真实产物** |

### 替换结果

| 项目 | 之前（我手写） | 现在 |
|---|---|---|
| 论文模板 | 13 套（10 套我自己写的 `ctexart` 骨架 + 3 套上游采购） | **17 套全部真实模板并全部编译通过**（16 xelatex + 1 typst） |
| 绘图模板 | 14 个我写的脚本 | **104 个**（90 个产品自带 + 保留我自建的 14 个） |

**我手写的 11 个论文骨架已全部删除**（10 套赛题骨架 + `mcm-icm-latex`）。你说得对：手写的和真实情况有差别——
真实模板带竞赛指定的封面、承诺书、编号栏、章节文件拆分与写作指引，这些我仿不出来。

### 真实模板的编译验证

```
apmcm OK   apmcm-en OK   changsanjiao OK   cumcm OK (document.tex)
diangongbei OK   dongsansheng OK   huashubei OK   huawei OK
huazhong OK   mathorcup OK   mcm OK   shuweibei OK
stats OK   wuyi OK   cumcm-latex OK   jxust-latex OK   cumcm-typst OK
17 template(s) compiled, 0 failed
```

`wuyi` 一开始失败（依赖 `YaHei.Consolas` 等被剥离的字体），我把字体引用改为系统 `Consolas` 并加注释说明，
之后编译通过。这是剥离字体的必然代价，也是把专有字体换掉的正确做法。

### 绘图模板的渲染验证

```
88 rendered, 0 skipped, 2 failed
```

失败的 2 个（`sr_weather_downscaling_map`、`sr_weather_model_evaluation_map`）需要 `cartopy`，
而本机缺 MSVC C++ 构建工具，`cartopy` 装不上。**这是环境问题，不是模板问题**；
目录里它们标为不可用，装好构建工具后跑 `pnpm run figures:mathmodel` 即可补齐。

---

## 二、必须先跟你确认的三件事

### 1. 这些 `.cls` 的许可状态并不干净

产品的模板目录里**没有任何 LICENSE 文件**，也没有来源声明。我逐个读了类文件头部：

| 模板 | 类文件头部声明的许可 | 可否随产品再分发 |
|---|---|---|
| `changsanjiao`（yrdmcm.cls） | LPPL 1.3+ | ✅ |
| `diangongbei`（neepumcm.cls） | LPPL 1.3+ | ✅ |
| `dongsansheng`（nemcmthesis.cls） | LPPL 1.3+（含作者邮箱） | ✅ |
| `mcm`（mcmthesis.cls） | LPPL 1.3+ | ✅ |
| `shuweibei`（nmmcm.cls） | LPPL 1.3+ | ✅ |
| `huashubei`（JXUSTmodeling.cls） | 标注 github 来源 | ⚠️ 与已采购的 `jxust-latex` 同源，但我采购的是 `sikouhjw` 仓库版本 |
| `mathorcup`（MathorCupmodeling.cls） | 标注 `github:sikouhjw/MathorCupmodeling` + 作者 | ⚠️ **该仓库此前查证无 LICENSE** |
| `cumcm`（cumcmthesis.cls） | 头部无许可声明 | ❓ 与已采购的 MIT 版**不是同一版本**（哈希不同） |
| `apmcm` / `apmcm-en` | 只写 `latexstudio.net`，无许可 | ❓ |
| `huawei` / `huazhong` / `wuyi` | 头部无许可声明 | ❓ |
| `stats` | 无类文件（纯 main.tex） | ❓ |

**我的处理**：全部提取进来了，因为这是你自己机器上、你自己在用的产品里的文件，你要求提取。
但**我没有把它们登记成"MIT/Apache/LPPL"**——`NOTICE.md` 里标的是"见 NOTICE.md"，因为对其中 6 套我无法确认。

**需要你决定**：
- 如果这个 fork 只是你自己用，那没问题；
- 如果要对外分发，建议**只保留 LPPL 那 5 套 + 已采购的 3 套**，其余从目录里下架。我可以改个开关。

### 2. 90 个绘图模板与整个 skill 是产品自带内容

`mathmodel-figure-templates`、`nature-figure`、`mma-paper` 等**都是原产品自己的资产**。
`nature-figure` 与 `skill-creator` 目录里**带 Apache-2.0 的 LICENSE.txt**（这暗示它们源自第三方开源项目），
`paper-diagram` 带 `ATTRIBUTION.md` 说明其 Tabler 图标为 MIT。但 `mathmodel-figure-templates` **没有任何许可文件**。

我按你的要求提取了。同样地：**自用没问题，对外分发前需要确认原产品对这些资产的授权**。

### 3. 嵌入字体我已主动剥离，但这会让模板与产品不完全一致

29 个字体里包括：
- **Ubuntu Mono**（`shuweibei`）——Ubuntu Font Licence，**可以**再分发；
- **Fira Code**（`wuyi`）——SIL OFL，**可以**；
- **KaiTi / SimSun / SimHei / LiSu**（`huawei`、`huazhong`、`wuyi`）——微软/中易专有字体，**不可以**；
- **方正书宋 `fzxbsongti.TTF`**（`stats`）——方正商业字体，**不可以**；
- **YaHei.Consolas / MONACO**（`wuyi`）——专有，**不可以**。

我目前**全部剥离**了（包括那两个可以分发的），保守但一致。如果你希望恢复 Ubuntu Mono 与 Fira Code
（它们能让 `shuweibei`/`wuyi` 的代码块与产品完全一致），告诉我，我按许可逐个加回来。

---

## 三、还发现的两件事

1. **我原来的图库注释在撒谎**。`figures.ts` 头部写着"每个模板都是从零为本项目写的，未再分发任何第三方图形资产"——
   提取之后这句话不成立了。已改成生成文件并说明两个来源。
2. **`apmcm` 与 `apmcm-en` 的首页预览完全相同**（PDF 首页都是中文承诺书，来自同一个类文件），
   英文差异在正文。这不是 bug，但图库里两张卡片会长得一样，属于真实模板的固有现象。

---

## 四、复现命令

```bash
cd ui/desktop

# 从已安装产品提取（需产品安装在本机）
pnpm run assets:extract -- --app "C:\Users\<你>\AppData\Local\Programs\@mathmodeldesktop"

# 渲染 90 个产品的绘图模板 + 重新生成图库目录
pnpm run figures:mathmodel
pnpm run figures:catalog

# 编译 17 套论文模板 + 重新生成论文目录（需 TeX Live；Typst 模板另需 typst CLI）
pnpm run papers:build

# 一致性核对（文档数字 vs 文件系统）
pnpm run docs:check
```

`TYPST=<path to typst.exe>` 用于指定 Typst 可执行文件，缺失时该模板会被跳过而不是整体失败。

---

# 第二轮：把内容本体也取过来

上一轮只取了**资产**（论文模板、绘图脚本），技能**正文**是我自己重写的等价物。
你说"我要的不是壳，是内容核心"，这一轮把产品的内容本体全部取了过来。

## 一、这轮取了什么

| 内容 | 落地位置 | 文件数 |
|---|---|---|
| **10 个 SKILL.md 正文**（mma-paper / mma-figure / mma-review / mathmodel-figure-templates / paper-search / data-search / doctor / metaheuristic-optimization / paper-diagram / skill-creator） | 同名顶层技能文件（名字按本 fork 改） | 10 |
| **paper-diagram 全套** | `paper_diagram/`：5 套版式模板（含 content JSON 与预览 PNG）、8 个 Python 脚本、11 篇参考、Tabler 图标 | 131 |
| **doctor / paper-search / data-search 的真实脚本** | `doctor/scripts/check_environment.py`、`paper_search/scripts/paper_search.py`、`data_search/scripts/record_source.py` + `references/source-routing.md` + `agents/openai.yaml` | 6 |
| **skill-creator 技能包** | `skill_creator/`（含它自带的 Apache-2.0 `LICENSE.txt`） | 6 |
| **90 张图库预览**（产品自带的无损 WebP） | `mathmodel_figure_templates/assets/previews/` | 90 |
| **三套真题**（2023 国赛 A 题、2023 华数杯 C 题、2024 高教社杯 C 题） | `math_modeling/assets/examples/`：官方题面 PDF + 题面文本 + 附件 + 结果文件 | 15 |
| metaheuristic-optimization 的 agent 清单 | `metaheuristic_optimization/agents/` | 1 |

合计 530 个文件、46.7 MB。字体与真题当时按"再分发风险"跳过了——第三轮（见文末）为了
测试准确把它们全部取回，并配了一个剥离脚本。`.disabled-by-default` 标记与 `paper-sharing`
技能也在第三轮补齐：标记文件现在就在技能目录里，`paper-sharing` 的上传步骤改成本机写
`sharing.json`（这里没有广场后端，它不会假装上传）。

## 二、正文不是照抄：所有改动都可追溯

产品正文里写着它自己的工具名、路径与 App 界面，直接抄过来在 goose 上跑不通。
改动用 `ui/desktop/scripts/adopt-product-skills.js` 统一施加，每条替换都在这个脚本里列着：

| 改动 | 原因 |
|---|---|
| `mma-paper`/`mma-figure`/`mma-review` → `math-paper`/`math-figure`/`math-review` | 本 fork 的技能名 |
| `assets/template/` → `assets/templates/`、`.mathmodel/` → `.modelforge/` | 本 fork 的目录布局 |
| `AskUserQuestion` → 直接在回复里提问 | 那是 Claude Code 的工具，goose 没有 |
| `MathModel` → `ModelForge`、`Claude` → the agent、`~/.claude/skills/` → `~/.agents/skills/` | 品牌与 goose 的技能目录 |
| `data-search` 的 `browser_*` 一节重写 | 本 fork 没有内置浏览器，改为 fetch/搜索工具降级，并如实说明 |
| `paper-sharing` 不采用 | 它依赖产品的上传后端，这里没有广场可传 |

## 三、脚本修掉一个真 crash

`ui/desktop/scripts/patch-extracted-scripts.js` 给 9 个会打印中文或 ✓ 的脚本加了
UTF-8 控制台守卫。这不是美化：

- `paper_search.py` 打印带重音的作者名时直接 `UnicodeEncodeError` 崩掉（本机控制台是 GBK）；
- `roadmap_5band.py` 打印 `✓ 容量检查通过` 的时机在**写 .drawio 之前**，
  于是"渲染成功"看起来像"渲染失败"——测试时第一个 .drawio 就是这么没生成的。

守卫只重设 stdout/stderr 的编码，不动任何布局逻辑与输出文字。

## 四、复现命令（第二轮）

```bash
cd ui/desktop

# 1. 提取内容资产（不含字体与真题）
node scripts/extract-product-assets.js --app "C:\Users\<你>\AppData\Local\Programs\@mathmodeldesktop" --include-examples

# 2. 采用产品技能正文（含全部适配替换）
node scripts/adopt-product-skills.js --app "C:\Users\<你>\AppData\Local\Programs\@mathmodeldesktop"

# 3. 给取来的脚本加 UTF-8 控制台守卫（幂等）
node scripts/patch-extracted-scripts.js

# 4. 重新生成图库目录并核对
pnpm run figures:catalog
pnpm run docs:check
```

---

# 第三轮：把测试需要的核心内容补齐（含字体与真题）

你的要求是"测试要准，核心不能丢"。前两轮出于再分发风险跳过的东西，这一轮全部取回，
并配了一个把树从"测试版"切回"可分发版"的脚本。

## 一、这轮补了什么

| 内容 | 数量 | 为什么必须取 |
|---|---|---|
| **29 个嵌入字体** | 118 MB | `wuyi` / `huawei` / `huazhong` 的类文件按**文件名**引用它们（`YaHei.Consolas.1.11b.ttf`、`MONACO.TTF`、`KaiTi`…），`stats` 用方正书宋。缺字体就静默回退到系统字体，**版面与产品不一致，测试结论就不可信** |
| **`.disabled-by-default` 标记** | 2 | 产品默认停用 `data-search` 与 `metaheuristic-optimization`；文件在技能目录里（含义的局限见 `NOTICE.md`） |
| **`paper-sharing` 正文** | 1 | 补齐产品 12/12 技能。上传步骤改成本机写 `sharing.json`——这里没有广场后端，它不会假装上传 |
| **PDF.js（`pdfjs/`）** | 185 文件 / 1.9 MB | 产品用它做论文 PDF 预览；Apache-2.0，可分发。库已就位（`ui/desktop/vendor/pdfjs/`），**查看器 UI 尚未接线** |
| **重新编译 17 套论文模板** | — | 字体到位后 `wuyi` 等模板回到产品原始字体引用（不再是我上轮改的 `Consolas`），17/17 编译通过 |

**没有取的两项，原因不是"风险"而是"没用"**：
- `claude-code/claude.exe`（272 MB）：那是 Anthropic 的专有 CLI，本 fork 的运行时是 goose 的
  Rust 内核，**应用根本不会调用它**——取来只是 272 MB 死重量；
- `bin/uv.exe`（65 MB）：我们自己的打包流水线（`prepare-platform-binaries.js`）已按哈希
  固定 `uv.exe` / `uvx.exe`，重复一份没有意义。

## 二、测试版 ↔ 可分发版：一条命令切换

```bash
cd ui/desktop
node scripts/strip-unshippable.js            # 只列清单，不删任何东西
node scripts/strip-unshippable.js --write    # 删字体 + 真题 + 许可未声明的模板
pnpm run papers:catalog && pnpm run docs:check
```

当前清单：**177 个文件**——29 个字体、15 个真题文件、109 个"无许可声明"模板文件、
24 个"上游仓库无许可"模板文件；**保留 8 套**（5 套 LPPL + `cumcm-latex` / `jxust-latex` MIT
+ `cumcm-typst` Apache-2.0）。剥离后 `wuyi` / `huawei` / `huazhong` / `stats` 会因为找不到
字体而编译失败，需要改指系统字体或直接下架——这是剥离专有字体的必然代价，脚本会提示。

## 三、复现命令（第三轮）

```bash
cd ui/desktop

# 提取全部内容（含字体、真题、标记、pdfjs）
node scripts/extract-product-assets.js --app "C:\Users\<你>\AppData\Local\Programs\@mathmodeldesktop" --include-fonts --include-examples

# 采用产品 12 个技能正文
node scripts/adopt-product-skills.js --app "C:\Users\<你>\AppData\Local\Programs\@mathmodeldesktop"

# 脚本 UTF-8 守卫（幂等）
node scripts/patch-extracted-scripts.js

# 用真实字体重新编译论文模板并刷新预览
pnpm run papers:build
```
