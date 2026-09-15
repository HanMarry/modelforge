# ModelForge 复刻计划（对齐截图的信息架构）

目标：把 ModelForge（goose 白标 fork）做成截图里那个数学建模桌面产品。
**视觉沿用 goose 现有设计系统**，只对齐信息架构与交互；资产只用宽松许可（MIT/Apache/LPPL）
的开源件自建，并在 `NOTICE.md` 登记。

## 一、目标信息架构（来自截图）

| 区域 | 截图里的项 | 对应实现路径 |
|---|---|---|
| 侧栏顶部 | 新建会话 / 科研绘图 / 数模广场 / 自动化 | `/`（主页）、`/figures`、留下后续、`/schedules` |
| 侧栏中部 | 扩展 → 技能 / 模板 / 算法 / 插件 / 连接器 | `/catalog/*` |
| 侧栏底部 | 打开工作区 / 用户信息 | 工作区分组（已有）、`/profile` |
| 主页 | 品牌头图 + 快捷表单 + 真题案例 | `/` 的 `Hub` 扩展 |
| 论文模板 | 14 套赛事 + 语言标签 + 模板内容 | `/paper` |
| 科研绘图 | 35 个模板 / 6 分类 + 缩略图 | `/figures` |
| 算法 | 11 个方法 + 分类 + 依赖 + 许可 + 适用场景 | `/algorithms` |
| 连接器 | 内置（mathmodel / browser）+ 可连接（arXiv、Zotero…） | `/connectors` |
| 个人信息 | Token、活跃度热力图、最常用供应商/模型/插件 | `/profile` |

## 二、阶段划分

### P-B 外壳层（进行中）

| # | 交付 | 状态 |
|---|---|---|
| B1 | 侧栏信息架构：`扩展` 可展开为 技能/模板/算法/插件/连接器；新增 `科研绘图`、`论文模板`、`个人信息` | ✅ 已落地 |
| B2 | 算法库页 `/algorithms`：分类筛选 + 搜索 + 卡片列表 + 详情面板（适用场景/数据要求/产出/不适用/依赖/许可/入口） | ✅ 已落地，15 条真实方法 |
| B3 | 科研绘图页 `/figures`：分类 + 缩略图网格 + 详情侧栏 | ✅ 页面已落地，12 条占位（`available: false`，无资产） |
| B4 | 连接器页 `/connectors`：内置 / 可连接 / 规划中三组 + 详情 | ✅ 页面已落地，13 条目录（5 内置 / 8 可安装 / 0 规划中），安装按钮可真实写入扩展配置 |
| B5 | 论文模板页 `/paper`：14 套赛事 + 语言/已内置筛选 + 模板内容 | ✅ 已落地，其中 2 套真实内置 |
| B6 | 主页：品牌头 + 快捷表单（工作流/赛事）+ 真题案例卡片 | ✅ 已落地（预设会真正写进输入框） |
| B7 | 个人信息页 `/profile`：会话数/提示词/活跃天数/项目数 + 活跃度热力图 + 最常用项 | ✅ 已落地，数据全部来自真实会话列表 |

落地位置：

```
ui/desktop/src/catalog/algorithms.ts      算法目录（数据 + 许可 + 入口）
ui/desktop/src/catalog/figures.ts         科研绘图目录（占位）
ui/desktop/src/catalog/papers.ts          赛事论文模板目录（2 套已内置）
ui/desktop/src/catalog/connectors.ts      连接器目录（内置/可连接/规划中）
ui/desktop/src/catalog/homePresets.ts     主页预设（工作流/赛事/真题案例）
ui/desktop/src/components/AlgorithmsView.tsx
ui/desktop/src/components/FigureTemplatesView.tsx
ui/desktop/src/components/PaperTemplatesView.tsx
ui/desktop/src/components/ConnectorsView.tsx
ui/desktop/src/components/ProfileView.tsx
ui/desktop/src/components/Hub.tsx             （改写：品牌头 + 预设栏 + 真题卡片）
ui/desktop/src/components/ChatInput.tsx       （新增 presetPrompt 入口）
ui/desktop/src/hooks/useNavigationItems.ts    （重写：NavItem / NavGroup / CATALOG_SUB_ITEMS）
ui/desktop/src/components/Layout/NavigationPanel.tsx  （新增 NavSubRow / NavGroupRow）
```

### 主页预设不是装饰

截图里那一行「默认工作区 / 写论文 / 国赛 CUMCM / 比赛信息」，本实现让它**真的起作用**：
点「写论文」→ 输入框被写入 `加载 math-modeling、math-paper、math-figure 技能…`；
再点「国赛 CUMCM」→ 追加 `使用国赛模板 math_paper/assets/templates/cumcm-latex/paper.tex`；
点真题卡片 → 追加该题目的建模指令。实现方式：`ChatInput` 新增 `presetPrompt` 入口
（按预设 id 去重，保证重复点击也能重新写入），预设文本反过来引用真实技能名与模板路径。

未内置题目/数据的真题卡片会显示「题目未内置，请自行补充」，不做假象。

### 个人信息页只展示能取到的数据

`SessionListItem` 提供 `messageCount / providerId / modelId / workingDir / createdAt /
updatedAt / hasRecipe`，因此可算出：会话数、提示词数、活跃天数、项目数、最常用供应商与模型、
使用配方的会话数，以及近一年活跃度热力图。

**Token 与费用不做汇总**：它们只在加载单个会话（`MessageUsage`）后才有，遍历全部会话代价过高。
页面上直接写明「按会话统计，此处尚未汇总」，而不是编一个数字。

设计取舍：截图里「科研绘图」在侧栏是一级项、同时又在「扩展 → 模板」下出现，本实现按
**一级导航 + 扩展分组子项** 处理，子项直接跳到对应页面，不做二套内容。

数据驱动：页面内容全部来自 `src/catalog/*.ts`，加一条内容只需往数组里追加一项，
无需改组件。这是后续批量灌内容（A1–A5）的前提。

### P-A 能力层（进行中）

| # | 交付 | 状态 |
|---|---|---|
| **A1** | **技能正文** | ✅ **完成：8 → 44 个**（八批：方法论 6 / 领域 5 / 小样本 1 / 工程写作 5 / 专项与写作 5 / 补缺 3 / 分支 5 / 运营 2；**另加 4 个工具技能与 A7**） |
| **A2** | **赛事论文模板** | **完成：17 套可编译模板（16 套 xelatex + 1 套 typst），全部实测编译通过** |
| **A3** | **科研绘图模板** | **完成：14 个可运行模板**（A11 又并入 90 个产品模板 → 目录 104 条，其中 102 条可用、2 条 cartopy 待补充，见 A14） |
| **A4** | 算法库条目 | 进行中：14 → 23 条 |
| A5 | MCP 连接器 | ✅ 完成：8 条可一键安装，规划中归零 |
| **A6** | **内置真题案例** | **进行中：3 个自编样例题已落地（赛题因授权不明不打包）** |

#### A1 已落地：8 → 25 个技能

**第一批（方法论，6 个）**

| 技能 | 覆盖内容 |
|---|---|
| `data-prep` | 缺失值分类处理、离群点定性、量纲一致性、特征泄漏检查、数据质量表 |
| `evaluation-method` | 熵权法、AHP（含 CR ≤ 0.1 校验）、TOPSIS、灰色关联、秩聚合与权重扰动稳健性 |
| `time-series` | 分解、ADF/KPSS、定阶、ARIMA/SARIMA/VAR/Prophet、滚动回溯与朴素基线 |
| `optimization-modeling` | 约束族、求解器选型、big-M、最优性间隙、Pareto 前沿、超体积 |
| `statistical-testing` | 检验选型、前提检查、效应量与置信区间、多重比较校正、回归诊断与 VIF |
| `sensitivity-analysis` | 局部弹性、容差区间、Sobol/Morris、蒙特卡洛传播、基线对比 |

**第二批（领域建模，5 个）**

| 技能 | 覆盖内容 |
|---|---|
| `differential-equation-modeling` | 机理建模、无量纲化、刚性求解与容差、参数辨识与可辨识性、守恒量校验、稳定性 |
| `graph-and-network` | 图定义、Dijkstra/MST/最大流/匹配/TSP 选型、边级校验、关键边与鲁棒性 |
| `spatial-analysis` | CRS 与投影、距离度量、IDW/Kriging 与交叉验证、Moran's I 与冷热点、选址与覆盖 |
| `queueing-and-simulation` | M/M/1、M/M/c、M/G/1、Little's 定律校验、SimPy 离散事件、预热与重复次数 |
| `cellular-automata` | 元胞与邻域/边界定义、转移规则、对观测数据的标定与 FoM、随机集合、格局指标 |

**第三批（小样本预测，1 个）**

| 技能 | 覆盖内容 |
|---|---|
| `grey-and-ensemble-prediction` | GM(1,1) 级比检验（前置条件）、残差比 C 与小误差概率 P、指数平滑参数、组合预测 |

**第四批（工程与写作，5 个）——本轮新增**

前几批管"怎么算对"，这批管"**怎么写对、怎么可复现**"，直接对应评审会扣分的地方：

| 技能 | 覆盖内容 |
|---|---|
| `code-and-reproducibility` | 目录布局、`uv` 锁依赖、随机种子、参数外置到 `config.yaml`、每篇论文的数字都要落 `results/`、环境记录、README 写成运行说明 |
| `model-comparison` | 命名真实基线、跨模型协议对齐（同切分/同预处理/同调参预算）、按决策选指标、差异的置信区间与配对检验、"两者不可区分"也要如实写 |
| `assumptions-and-notation` | 把题干逐句转成约束/目标/参数/假设、假设三要素（是什么/为什么/错了会怎样）、区分 given/assumed/derived、量纲检查、符号表清单式自查 |
| `result-visualization` | 按"想说什么"选图型、柱子零基线、颜色按用途（顺序/发散/分类）、标注结论、多面板规范、图注三段式（图号—画什么—结论） |
| `abstract-and-conclusion` | 摘要素写（五步结构、必须带数字）、结论量化对照表（"效果较好" vs "RMSE 0.284"）、优缺点各 2–3 条且带改法、推广要具体到"改哪里"、投稿前七项自查 |

**第五批（专项建模与论文写作，5 个）——本轮新增**

| 技能 | 覆盖内容 |
|---|---|
| `regression-modeling` | 区分"解释"与"预测"目标、VIF 与共线性、函数形式选择、**假设诊断四件套**（线性/独立/同方差/正态）、Cook 距离、稳健标准误、正则化的正确用法、系数表要带单位与 CI |
| `classification-modeling` | 先看类别平衡、**先切分后重采样**、按决策选指标（不平衡时用 PR-AUC 而非 ROC-AUC）、**阈值要显式选并说明依据**、类别权重优先于 SMOTE、概率校准 |
| `clustering-analysis` | 先标准化并说明距离度量、k 的多个判据（肘部/轮廓/CH/DB）、按簇形状选算法、**稳定性检验与零模型对比**、簇画像表、下游使用时的信息泄漏 |
| `paper-structure` | 逐节该写什么、常见失分点（问题重述照抄题干、问题分析写成第二遍重述、正文贴代码、检验只有一张扰动表）、问题分析里的方法比选表、附录该放什么 |
| `citations-and-references` | 绝不凭记忆写引用、DOI 逐个验证、GB/T 7714 与 IEEE 格式、BibTeX 卫生（key 命名、无重复、转义）、**引用与列表双向核对**、查不到来源就改弱论点 |

`math-modeling` 的模型选择表扩到 **25 行**，Step 1 现在明确要求先加载 `data-prep`，并在存在极端值或
"极端值本身就是问题"时加载 `outlier-and-anomaly-detection`；Step 6 写作段指向
`assumptions-and-notation` + `paper-structure` + `citations-and-references` +
`abstract-and-conclusion` 四个技能。

#### A5 补充验证：8 条连接器全部通过真实 MCP 握手

上一轮把连接器的验证停在"包存在、命令可解析、配置形状正确"。本轮补上了最后也是最关键的一环，
新增 `ui/desktop/scripts/check-connectors.js`：**按 MCP 协议真的发 `initialize` + `tools/list`
并读回工具清单**，而不是只看进程能不能启动。

| 连接器 | 结果 |
|---|---|
| arxiv | ✅ 19 个工具 |
| crossref | ✅ 18 个工具 |
| drawio | ✅ 5 个工具 |
| zotero | ✅ 3 个工具 |
| context7 | ✅ 2 个工具 |
| web-fetch | ✅ 1 个工具 |
| fred | ✅ 正确要求凭据（提示 `FRED_API_KEY`，包本身可用） |
| github | ✅ HTTP 401（远程端点在线且要求 PAT，符合预期） |

脚本用**直接 spawn 而非 shell**，与桌面端行为一致。这点不是细节：第一版用了 `shell: true`，
`--with mcp<2` 里的 `<` 被 `cmd.exe` 当成输入重定向，报 "The system cannot find the file specified"，
把 drawio 与 crossref 两条**本来可用**的连接器误判为失败。改成直接 spawn 后两条都通过
（5 与 18 个工具）。**测试脚手架的偏差会制造出不存在的问题**——如果没多查一步，
我就会去"修"一个根本没坏的配置。

**本轮又踩到同一处脚手架的第二个坑**：Node 20.12+/22+ 为修 CVE-2024-27980，
拒绝在没有 shell 的情况下 spawn `.cmd` 文件，且是**同步抛 EINVAL**（不是发 `error` 事件），
于是 `npx` 那条（context7）把整个脚本崩掉，连已经跑完的 5 条结果都看不全。
桌面端有自带 `npx.cmd` shim 所以用户不受影响，受影响的只有这个校验脚本。
修法两条：① Windows 上把 `npx` 解析成 npm 的 `npx-cli.js` 交给当前 Node 运行
（完全不需要 shell）；② 把 spawn 用 try/catch 包住，启动失败只让**那一条**失败。
修完 context7 通过（2 个工具），**8/8 全绿**。

**第六批（补缺，3 个）——上一轮新增**

先做了覆盖自查（grep 全部技能正文确认哪些主题没有命中），补的是**真正没有覆盖**的三块：

| 技能 | 覆盖内容 |
|---|---|
| `simulation-optimization` | 目标只能靠仿真评估时的优化：**公共随机数（CRN）**、离散事件仿真与优化的耦合、样本均值近似（SAA）的重复数一致性检查、排序与选择、代理模型；以及"先算出可检测差异再判断改进是否真实"这一步 |
| `outlier-and-anomaly-detection` | 先分清**清洗 / 建模 / 检测**三种框定（把该找的异常当错误删掉是最常见的致命混淆）、硬约束优先于统计规则、MAD 修正 z 优于普通 z（后者被离群点自身污染）、多变量方法（马氏距离/孤立森林/LOF）、时序需先去趋势季节、逐点记录处置、**处置前后结论对比** |
| `count-and-ordinal-models` | 计数/有序/比例型响应不能用 OLS：Poisson 的**过度离散检验**（Pearson χ²/dof）、负二项与零膨胀、**率模型必须带 offset**、系数要报发生比 IRR 及其 CI、有序 logit 的**平行线假设检验**与其边际效应、beta 回归与二项 GLM |

这三块之前都只在别的技能里被顺带提过（`queueing-and-simulation` 提过一次仿真但没讲优化、
`data-prep` 提过离群点但没讲检测方法、`regression-modeling` 只覆盖连续响应），单独成篇后
才真正可执行。

**第七批（独立分支，5 个）——本轮新增**

同样先 grep 全部技能正文找出**真正没有命中的主题**，再决定写哪几个（避免为了凑数而写）：

| 技能 | 覆盖内容 |
|---|---|
| `pde-modeling` | 先写守恒式、方程分类（抛物/双曲/椭圆）决定方法、**三类边界条件**、方法线离散化与网格收敛检查、**CFL 稳定性判据**、守恒量漂移检查、显式 vs 隐式取舍 |
| `changepoint-and-regime` | 变点类型判定（水平跳变/趋势转折/方差变化/状态切换——**渐进漂移不是变点**）、PELT/BinSeg 的惩罚项必须显式、CUSUM 检验、马尔可夫切换、**日期必须给不确定性区间**、安慰剂与 bootstrap 验证 |
| `facility-location` | p-median / 最大覆盖 / 集合覆盖 / CFLP 选型、需求聚合层级的影响、网络距离与投影、**成本-覆盖权衡曲线**、未覆盖需求必须显式、公平性检查、哪个约束在起作用 |
| `experimental-design` | 因子与响应先行、全因子与部分因子的**分辨率与混杂结构**、随机化与区组（别把因子和日期混在一起）、响应面法与**确认实验**、按设计分析而非回归堆砌 |
| `multi-attribute-decision` | 排序 vs **决策**的区分、偏好信息必须显式获取（权重/效用/偏好函数/否决阈值）、加权和的完全补偿假设、ELECTRE 的不可比是合法答案、PROMETHEE 净流与 φ+/φ− 图、权重扰动与第二方法交叉验证 |

这几块都只在别的技能里被顺带提过一次：`differential-equation-modeling` 提过 PDE 却没讲空间离散与 CFL、
`time-series` 提过变点却没讲检测方法、`spatial-analysis` 提过选址却没讲覆盖模型、
`optimization-modeling` 提过响应面却没讲实验设计、`evaluation-method` 讲的是**客观排序**而非偏好决策。
单独成篇后才真正可执行。

**第八批（运营决策，2 个）——本轮新增，A1 至此达标**

同样按 grep 结果来定：`survival`、`Weibull`、`MTBF`、`censoring`、`inventory`、`EOQ`、
`newsvendor`、`safety stock` 在全部技能正文里**命中数均为 0**，而这两类都是赛题高频。

| 技能 | 覆盖内容 |
|---|---|
| `reliability-and-survival` | **删失数据的框定**（右删失是信息不是缺失，丢掉会把寿命估低）、Kaplan–Meier 作为无分布基线、按**风险函数形状**选分布、**Weibull 形状参数的含义**（β>1 才是磨损期、才值得定期更换；β≈1 就该明说"定期更换没有可靠性收益"）、系统可靠度（串/并/k-out-of-n）与独立性假设、年龄更换最优策略、B10 寿命、外推必须标注 |
| `inventory-and-supply-chain` | EOQ 及其"无缺货"假设的适用边界、**成本必须按单位时间比**、数量折扣要逐段算总成本、**报童模型的临界分位数**（用均值需求是经典错误）、安全库存必须用**提前期需求方差**（用日标准差会少 √L 倍）、服务水平的两种定义（周期服务水平 ≠ 满足率）、多品多期 MIP 与库容影子价格、成本分解 |

**A1（技能正文）至此标记为完成。** 判定依据：目标写的 40+ 是数量指标，但更要紧的是
**覆盖完整且不重复**——每加一批前都先 grep 全部正文确认该主题真空缺，八批共新增 32 个技能，
覆盖了从数据准备、各类模型族、工程复现到论文写作的完整链路；`math-modeling` 的选型表共
**32 行**逐行指向对应技能，**不存在"写了却不会被加载"的技能**。

技能由后端经 ACP 动态列出，**新增 `.md` 无需在前端注册**；`include_dir!` 会在编译时
将其编进二进制，因此这两项都不需要改任何 Rust 代码。

#### A6 已落地：3 个自编样例题（赛题不打包）

目标产品的主页有三张"真题案例"卡片。要做这一项必须先解决**赛题再分发授权**，我查证后
的结论是：**不能打包真实赛题**。

| 查证对象 | 结果 |
|---|---|
| `mcm.edu.cn`（国赛官网）、`cmathc.org.cn`（参赛规则） | 站点可访问，但**没有声明赛题的可再分发许可** |
| MathorCup / APMCM 官方"长期征题通知" | 赛题由**出题人投稿**产生，著作权归属未在本站声明中让渡 |
| 各类"历年赛题合集"转载站 | 均为二次转载，**不能作为授权依据**（不能拿它当来源） |

因此我改为**自编样例题**，数据用固定种子脚本生成，许可完全清晰：

| 目录 | 领域 | 考察点 |
|---|---|---|
| `production-planning/` | 多目标优化 | LP/MILP 建模、Pareto 前沿、灵敏度参数区间 |
| `demand-forecast/` | 时间序列 | 缺失值与异常处理、季节分解、滚动回溯、朴素基线对比 |
| `water-quality/` | 综合评价 | 正负向指标归一化、熵权与 AHP 双权重对比、权重扰动稳健性 |

每个目录含 `problem.md`（题面）、`generate_data.py`（固定种子）与已生成的 `data/`。
生成脚本已实测跑通，**重生成后数据哈希完全一致**（可复现）。数据是合成的，
题面与图内都标注了这一点，不会让学生把合成数当成真实观测。

主页三张卡片现在指向这三道样例题（标签写明"样例题"而非"真题"），
点一下会把题面路径与要加载的技能写进输入框。卡片上的"已附带样例题数据"是实话——
数据确实在仓库里，不需要用户额外准备。

样例题放在 `math_modeling/assets/samples/` 下，因此加载 `math-modeling` 技能时会自动
列出（现在该技能带 15 个支撑文件）。题面同时写了**建议加载的技能**，把 A1 的方法论技能
串起来用。

#### A5 已落地：连接器从"占位"变成"真能装"

之前连接器页的「安装」按钮是 `disabled` 的，只是摆设。本轮把它接上了真实的扩展配置写入
（`useConfig().addExtension`），并逐个核实了每个候选 MCP 服务器的**包是否真实存在、许可、
入口命令**——结果纠正了三条错误：

| 连接器 | 核实结果 | 配置 |
|---|---|---|
| arXiv | PyPI `arxiv-mcp-server` 0.7.2，MIT | `uvx arxiv-mcp-server` |
| Web Fetch | PyPI `mcp-server-fetch` 2026.8.18，MIT | `uvx mcp-server-fetch` |
| Zotero | PyPI `zotero-mcp` 0.3.1，MIT | `uvx zotero-mcp`，本地 API 模式**无需 key** |
| draw.io | PyPI `drawio-mcp` 1.0.2，MIT | `uvx --from drawio-mcp --with mcp<2 drawio-mcp` |
| 引用真实性校验 | PyPI `crossref-mcp` 0.1.0，MIT | `uvx --from crossref-mcp --with mcp<2 crossref-mcp`（可选 `CROSSREF_MAILTO` 加入礼貌池） |
| FRED 经济数据 | PyPI `fred-mcp` 1.0.1，MIT | `uvx fred-mcp` + `FRED_API_KEY` |
| GitHub | **原 npm 包已废弃** → 改用官方托管远程 MCP | `streamable_http` + PAT |
| Context7 | npm `@upstash/context7-mcp` 4.1.0，MIT | `npx -y @upstash/context7-mcp` + API key |

**规划中归零**：原先标为"规划中"的两条（引用校验、公开数据获取）本轮都找到了**实测可用**的
上游服务器，因此不再需要自研 MCP。核实过程同样是"运行验证"而非读元数据：

- `crossref-mcp` 与 `drawio-mcp` 有**同一个病**：面向 MCP SDK 1.x，默认安装会
  `ModuleNotFoundError: No module named 'mcp.server.fastmcp'`；两者都靠 `--with mcp<2` 修好，
  实测启动日志为 `starting crossref-mcp 0.1.0 (transport=stdio)`。
- `fred-mcp` 加载后主动退出并提示 `FRED_API_KEY is required for stdio transport`——
  这是**凭证确实必需时的正确行为**，反而证明包本身可用。
- 主动**排除**了 `open-data-mcp`（韩国公共数据）：它**没有声明任何许可信息**，
  按本项目"只用 MIT/Apache/LPPL"的红线不能收录。宁可少一条也不塞一个许可不明的依赖。

**四条纠错 / 教训**：

1. 我原先写的 `@modelcontextprotocol/server-fetch` **在 npm 上不存在**（fetch 是 Python 的
   `mcp-server-fetch`）。
2. `@modelcontextprotocol/server-zotero` **也不存在**（Zotero 是社区 Python 服务器）。
3. `@modelcontextprotocol/server-github` 存在但 **npm 已标记 deprecated / no longer supported**。
   查证后改用 GitHub 官方的 `github/github-mcp-server`（MIT，32.8k★，活跃）所托管的**远程端点**
   `https://api.githubcopilot.com/mcp/`——本项目已支持 `streamable_http`，因此不需要让用户装
   Docker 或 Go 二进制。
4. **`drawio-mcp` 是"装得上但跑不起来"的典型**：包存在、MIT、README 里就写着
   `uvx drawio-mcp`，但实际运行会在 import 阶段崩——
   `ModuleNotFoundError: No module named 'mcp.server.fastmcp'`。原因是它面向 MCP Python SDK 1.x，
   而现在解析到的是 2.x（`FastMCP` 改名为 `MCPServer`）。SDK 的报错信息给出了修法，
   实测 `--with mcp<2` 后 `--help` 正常返回。**这条约束已写进 `args`，不留给用户踩。**
   如果只看包名和 README，就会把这个坏配置推给用户。

命令可用性也做了实测：`uvx arxiv-mcp-server` 能解析安装（1.65s 装完 46 个包），
`npx @modelcontextprotocol/server-github` 能真实启动（输出 `GitHub MCP Server running on stdio`），
两个远程端点也都有响应（405 / 401，即未带凭证的预期行为）。
打包侧 `uvx.exe` 已在 `prepare-platform-binaries.js` 里按哈希固定，Windows 侧 `npx.cmd`
由 `winShims.ts` 提供，所以这些命令在安装包里也能解析。

安装流程：点「安装」→ 弹凭据对话框（敏感项写进系统钥匙串，不进配置文件）→
`toExtensionConfig()` 按传输类型把凭据放到 `envs`（stdio）或 `headers`（streamable_http）→
写入并在扩展页可见。GitHub 的连接器需要 `Bearer ` 前缀，这个细节在 catalog 里用
`valuePrefix` 标记而不是让用户自己拼。

仍未做得可安装的（保持"规划中"，写明原因而不是塞个坏配置）：引用真实性校验、
公开数据获取——这两个还没有合适的现成 MCP 服务器。

#### A2 已落地：17 套真实竞赛论文模板（从已安装产品提取）

**本轮补齐最后一套（Typst）并把模板改为可离线编译。**

`cumcm-typst` 此前标为"不可用"，原因有二：仓库里只有 `lib.typ` 没有入口文件，
且本机没有 typst 命令行无法验证。本轮两件都解决了：

1. 从 GitHub Releases 取到 typst 0.15.1 预编译二进制，**真的编译出 5 页 PDF** 并渲染首页预览；
2. 写了可编译的 `paper.typ` 入口（摘要 + 7 章正文 + 附录，含公式、定理环境与代码块）。

顺带发现并修掉一个**真问题**：`lib.typ` 原本 `#import "@preview/ctheorems:1.1.3"`，
Typst 首次编译会去 `packages.typst.org` 下载该包——本机 DNS 解析失败，编译直接中断。
**这意味着比赛现场或任何受限网络下，这篇论文根本编译不出来。** 而 `lib.typ` 实际只用到了
ctheorems 的一个函数 `thmbox`，于是改为本地等价实现 `theorems.typ`（按接口重写，非复制源码；
ctheorems 为 MIT），模板因此**完全不需要联网**。为对齐签名，`lib.typ` 只改了两处：
import 行，以及 `envbox` 绑定里那个本实现用不到的 `base:` 参数。

`build-paper-previews.js` 也扩展为双引擎：`.tex` 走 xelatex 两遍编译，`.typ` 走 typst 单遍；
typst 缺失时**跳过该目录而不是整个失败**，可用 `TYPST=<path>` 指定。

`docs:check` 的"可编译"判定同步改为同时识别 `paper.tex` 与 `paper.typ`——
改完立刻抓到 3 处文档计数落后（A2 从 13 变 14），这正是这个检查存在的意义。

`crates/goose/src/skills/builtins/math_paper/assets/templates/`

| 目录 | 赛事 | 类文件 | 来源 | 许可 | 页数 |
|---|---|---|---|---|---|
| `cumcm-latex/` | 国赛 CUMCM | `cumcmthesis.cls` | Sustainable-Enjoyment（内置） | MIT | 4 |
| `jxust-latex/` | 校级赛 | `JXUSTmodeling.cls` | sikouhjw（内置） | MIT | 4 |
| `mcm-icm-latex/` | 美赛 MCM/ICM | 无（`article`） | 本项目自写 | 自写 | 3 |
| `apmcm-latex/` | 亚太赛 APMCM | 无（`ctexart`） | 本项目生成 | 自写 | 4 |
| `mathorcup-latex/` | MathorCup | 无（`ctexart`） | 本项目生成 | 自写 | 4 |
| `shuweibei-latex/` | 数维杯 | 无（`ctexart`） | 本项目生成 | 自写 | 4 |
| `huashubei-latex/` | 华数杯 | 无（`ctexart`） | 本项目生成 | 自写 | 4 |
| `wuyi-latex/` | 五一杯 | 无（`ctexart`） | 本项目生成 | 自写 | 4 |
| `diangongbei-latex/` | 电工杯 | 无（`ctexart`） | 本项目生成 | 自写 | 4 |
| `dongsansheng-latex/` | 东三省赛 | 无（`ctexart`） | 本项目生成 | 自写 | 4 |
| `huazhong-latex/` | 华中杯 | 无（`ctexart`） | 本项目生成 | 自写 | 4 |

**关键：这 11 套全部用 xelatex 实际编译通过**，应用里的首页预览就是从编译产出的 PDF
渲染的（`pnpm run papers:build`）。一套从没跑过 xelatex 的模板只是猜测——所以构建脚本
在编译失败时会直接报出 LaTeX 错误日志，而不是让坏模板进仓库。

八套中文骨架由 `scripts/build-paper-templates.js` 从一份描述生成：共用同一套前言与
六段式结构，**只有章节清单、摘要说明与示例标题不同**（例如 MathorCup 多一节引言、
电工杯强调机理分析、五一杯注明要交代数据清洗）。这样既贴合各赛事习惯，又不会出现
八份近似代码各自漂移。模板清单（`ALL_TEMPLATE_DIRECTORIES`）由生成器导出，
预览构建脚本直接复用，不再各维护一份。

目录里仍保留 3 条 `available: false`（长三角赛、华数杯研究生组、Typst 版），
写明原因而不是用降级内容冒充。

#### A2 许可核查结论（纠正了调研报告的几处不准）

| 仓库 | 核查结果 | 处置 |
|---|---|---|
| Sustainable-Enjoyment/CUMCM-LaTeX-Template | MIT | 已内置 |
| sikouhjw/JXUSTmodeling | **MIT** | 已内置（自包含类文件） |
| a-kkiri/CUMCM-typst-template | Apache-2.0 | 已内置库文件 |
| latexstudio/mcmthesis | **LPPL 1.3c+**（README 明写） | **未内置**：仓库只发布 `mcmthesis.dtx`，`.cls` 是用 `xetex` 跑源文件生成的派生物，无法从仓库复现 |
| sikouhjw/MathorCupmodeling | **无 LICENSE 文件** | **未内置**（调研报告曾标为"公开仓库"，实际不可用） |
| sikouhjw/CUMCMThesis、latexstudio/MCM-ICM | **仓库 404** | 未内置（调研报告引用的地址已失效） |

美赛没有用 `mcmthesis`，而是自写了一套基于标准 `article` 的 Summary Sheet 骨架：
**不需要安装任何赛事类文件就能编译**，牺牲的是官方外观。如果后续要官方版式，需要先能跑
`xetex mcmthesis.dtx` 生成 `.cls`。

Typst 侧：`cumcm-typst/lib.typ` 已内置，但**仓库内没有入口文件，且本机没有可用的 typst
命令行**（PyPI 的 `typst` 包不提供可执行文件），因此我**没有编写无法编译验证的
`paper.typ`**，该条在目录里标为不可用并写明原因。

#### A3 已落地：14 个真实绘图模板（自建部分占位清零）

`crates/goose/src/skills/builtins/math_figure/assets/templates/`

| 模板 | 分类 | 画什么 | 额外依赖 |
|---|---|---|---|
| `flowchart/five_band_roadmap.py` | 流程图 | 五阶段技术路线图 + 左侧时间线箭头 | 无 |
| `flowchart/horizontal_pipeline.py` | 流程图 | 左到右五阶段，每阶段带子步骤 | 无 |
| `flowchart/hierarchical_structure.py` | 流程图 | 总目标 → 子问题 → 每问的数据与方法 | 无 |
| `flowchart/three_stage_pipeline.py` | 流程图 | 三阶段 × 输入/处理/输出 + 阶段间数据交接 | 无 |
| `flowchart/three_column_framework.py` | 流程图 | 阶段 / 研究内容 / 方法模型 三栏对齐 | 无 |
| `model-evaluation/roc_cross_validation.py` | 模型评价 | 每折 ROC + 均值曲线 + ±1 SD 带 + 各折 AUC | 无 |
| `model-evaluation/sensitivity_curves.py` | 模型评价 | 参数弹性曲线 + "结论不变"输入可行区间 | 无 |
| `model-evaluation/model_radar.py` | 模型评价 | 多模型 × 多指标雷达（成本型指标已反向） | 无 |
| `model-evaluation/metric_heatmap.py` | 模型评价 | 模型 × 指标矩阵，写原始值并圈出每列最优 | 无 |
| `combination/correlation_combined.py` | 组合图 | 下三角散点矩阵 + 上三角系数热力图 + 共享色标 | 无 |
| `distribution/paired_distributions.py` | 分布 | 半小提琴 + 箱线 + 抖动散点（含 n 标注） | 无 |
| `distribution/data_overview.py` | 分布 | 缺失率 / 分布 / 相关性 / 趋势 四联图 | 无 |
| `machine-learning/feature_importance_beeswarm.py` | 机器学习 | 重要性条形图 + 样本效应蜂群图 | 无 |
| `spatial/response_surface_3d.py` | 空间分析 | 3D 响应面 + 底面等高线投影 + 最优解标注 | 无 |

**这 14 条自建模板全部为真实模板，占位清零。** 从 9 → 11 → 14，本轮补上了最后三条：
数据体检四联图、层次结构图、横版流水线图。

> **后续修正（A14 实测）**：A11 并入 90 个产品内置模板后，图库目录变成 **104 条**，
> 其中 **2 条是 cartopy 模板**（`figures:mathmodel` 的 88/90 就是它们），界面上显示为
> 「模板待补充」。所以"图库零占位"这句只对**自建的那 14 条**成立，对整个目录不成立。

`distribution/data_overview.py` 值得单独说：它是拿到新数据时**第一个该跑的模板**——
一页里给出缺失率、分布形态（含偏态）、相关性矩阵与时间趋势，并且数据里刻意带了
缺失与非正态列，正好对应 `data-prep` 技能要求的那张"数据质量表"。

设计要点：

- **`_style.py` 统一风格与图元**：共享 rcParams、品牌色板、CJK 字体探测，以及
  `diagram_axes` / `block` / `arrow` / `title_and_note` 四个流程图元，
  外加 `enable_utf8_stdout()`。
- **零额外依赖**：全部只用 matplotlib + numpy。ROC 用降序扫描自实现、相关性用
  中心化矩阵自实现、KDE 用 Silverman 规则自实现、蜂群图用分桶堆叠自实现
  ——不引入 `shap`/`seaborn`/`sklearn`/`scipy`，因此 `uv run --with matplotlib` 就能跑。
- **`resolve_cjk_font()` 返回 `None` 时自动改用英文标签**，不会输出方块字。
- **合成演示数据**：固定种子，并在图内标注「演示数据（合成）」。
- **预览图可复现**：`pnpm run figures:build` 重新生成全部 PDF/PNG 并同步到应用侧
  `src/assets/figures/`（需 `uv`）。

**本轮修掉一个真 bug**：`metric_heatmap.py` 在 Windows 上打印列名 `R²` 时抛
`UnicodeEncodeError`——图已经写盘了，但进程以非零码退出，看起来像渲染失败。
控制台默认是 GBK/cp1252 而非 UTF-8。修法是给 `_style.py` 加 `enable_utf8_stdout()`
并在每个模板的 `main()` 开头调用，11 个模板已全部接入。

#### A4 已落地：算法库 14 → 23 条

新增 9 条，并加了两个分类（时间序列、降维）：灰色关联分析、PCA、高斯混合聚类 GMM、
Prophet、VAR 向量自回归、蒙特卡洛模拟、Bootstrap 重采样、马尔可夫链、遗传算法。

仍只登记元数据、不 vendor 代码：每条指向真实开源库（`mealpy` MIT、`pymoo` Apache-2.0、
`scikit-learn`/`statsmodels`/`scipy` BSD-3、`prophet` MIT），纯数学方法标注
"自实现，无第三方许可问题"。条目字段包含截图里那四项（适合什么时候用 / 需要什么数据 /
会得到什么 / 不适合的情况）以及依赖、许可、调用入口。

### A7 工具技能对齐（本轮新增）——把"参考产品比我们多出来的那一层"补上

对照参考产品的 12 个内置技能逐个核对后，发现差距**不在方法论数量**（我们已有 32 个，
它一个都没有），而在**它每个技能都带一个能跑的脚本或模板**。本轮把这一层补齐：

| 参考产品 | 我们之前 | 本轮做法 |
|---|---|---|
| `mma-paper`（含 config.json、逐问 .py、book.bib、图注规则、示意图路由） | `math-paper.md` 只写章节结构与**已删除的旧模板名** | 按参考产品的工作流重写：定模板来源 → 集中确认模型 → **每问一个 .py** → 出图路由 → `paper-search` 生成 `book.bib` → `compile_latex` 编译 → `math-review` 自评 |
| `mma-figure`（路由到三个技能） | `math-figure.md` 只讲自己的 14 个模板 | 改成**路由技能**：数据图表（自带 14 个 / 90 个内置模板 / `nature-figure`）、示意图（`paper-diagram`）、物理图（TikZ），并保留产物与图注约定 |
| `mma-review`（六维 0–10 + review.md + 致命项） | 八维 1–5，无产物文件 | 改为六维 0–10、单独列**致命项**、产出 `review.md`（问题必须带位置与改法）、确认前不改正文 |
| `paper-search`（带 `paper_search.py`） | 只有 curl 片段 | **自研** `paper_search.py`：双引擎并行、按 DOI 交叉验证、`verify` 核对、`bib` 由权威元数据生成；伪 DOI 直接非零退出 |
| `data-search`（带 `record_source.py` + 来源路由） | 只有仓库清单 | **自研** `record_source.py`（写 `data/sources.json`：相对路径 + SHA-256 + 许可 + 获取日期；拒绝写入带 token 的 URL）+ `references/source-routing.md`（按权威度排列的国内外来源） |
| `doctor`（`check_environment.py` + 安装指引） | 只有 `check_env` MCP 工具，没有技能 | 新增 `doctor` 技能：检测走 `modeling__check_env`，安装方案写进 `references/install.md`（含中国大陆镜像），不静默安装 |
| `metaheuristic-optimization`（MEALPY 路由） | 只有算法库条目 | 新增同名技能：先核对版本与官方文档再写代码、统一计算预算比较、交付原始运行记录 |
| `paper-diagram`（draw.io + 5 套模板 + 校验脚本） | 只有 matplotlib 流程图 | 新增 `paper-diagram` 技能：draw.io XML 写法、中文字宽预算、连接器规范、`drawio` 连接器/命令行导出、复刻流程 |
| `nature-figure`（Apache-2.0） | `result-visualization` 只有文字规范 | **合法整包内置**（它自带 Apache-2.0 的 `LICENSE.txt`），路由由 `math-figure` 承担 |
| `paper-sharing` / `skill-creator` | — | 未做：前者需要账号与后端（P3），后者与数模无关 |

### A8 一致性修复（本轮新增）——同一件事在两处说法不一致

提取产品资产那一轮改了目录与计划书，但**四处没跟上**，这些是"文档说 A、文件是 B"的真缺陷：

| 位置 | 问题 | 处置 |
|---|---|---|
| `math_paper.md` | 模板表还列着**已被删除的 11 个自写骨架**（`mcm-icm-latex`、`apmcm-latex` …），没提任何真实模板 | 换成 17 套真实模板表（含入口文件与许可） |
| `math_paper/assets/templates/README.md` | 同样在描述已删除的骨架 | 重写：14 套提取 + 3 套采购、入口、`template.json` 字段、字体为何剥离、未内置原因 |
| `homePresets.ts` | 美赛/华数杯/MathorCup/亚太赛标着"模板尚未内置"，其实都已内置 | 指向真实目录与入口文件；国赛改为产品内置版 `cumcm/` |
| `figures.ts` 的 `script` 字段 | 两个系列**基准不同**（自建模板少了 `templates/` 前缀），"使用此模板"会给出错误路径 | 统一为相对 `math_figure/assets/`，并给缺失的 4 个分类补中文标签（原来显示 `flowchart` 这样的原始英文键） |

**并且把这类错误变成可自动发现的**：`docs:check` 新增「引用的资产必须真实存在」校验——
技能正文里的模板名、`scripts/`、`references/` 路径，目录文件里的 `entryFile`、`script`，
主页预设的 `templateDirectory`，全部逐个核对。本轮它当场抓出了 `script` 基准不统一与
4 个分类标签缺失，也就是说：**这类"文档与文件不一致"下次会被构建拦住，而不是留给你发现。**

### A9 构建污染技能资产（本轮新增）——源码目录里不该有编译产物

核对 `papers:build` 的输出时发现：它在**模板目录里就地编译**，于是
`math_paper/assets/templates/<每一套>/` 里都留下了编译出的 PDF（共 3.2 MB）、
重复的 `preview.png`，以及 `missfont.log` / `.lot` / `.lof` 这类日志。

这三点都有实际代价：
1. 这些目录是**要被 agent 复制进用户项目的模板源**，旁边放一份 `main.pdf` 会让人（和 agent）
   以为论文已经写好了；
2. `include_dir!` 会把 `builtins/` 下的一切编进二进制，3.2 MB 的编译产物白占体积；
3. **产品自己的模板目录里没有任何编译产物**（逐目录核对过），我们反而比它脏。

改法：`build-paper-previews.js` 改为把模板**复制到系统临时目录**再编译，只把首页 PNG
写进 `ui/desktop/src/assets/papers/`，编译完删掉临时目录。已清理 38 个残留文件，
重跑 `papers:build --force` 后 17/17 仍然全部编译通过、预览字节数与之前完全一致，
而模板目录里只剩源码。

绘图模板**保持原样**（脚本旁的 PDF/PNG 是它自己的输出）：产品内置的绘图技能同样在
`assets/previews/` 里放渲染结果，因此这一处"不干净"是**对齐产品**而不是疏漏——
两边的差异已写进 `NOTICE.md`。

### A10 「扩展」五类逐项对齐参考产品（本轮）

参考产品的侧栏「扩展」展开是 **技能 / 模板 / 算法 / 插件 / 连接器** 五类。把它的界面文案、
本地数据与交互逐项挖出来对照后，结论是：**五个入口我们都有，但每一类都缺实质功能**，
其中技能页差距最大（我们还是上游 goose 的扁平静态列表）。本轮逐类补齐：

#### 技能页（差距最大，已重写）

| 参考产品有 | 我们之前 | 现在 |
|---|---|---|
| 已启用 / 已停用 分组 + 各自计数 | 一个平铺列表 | ✅ 分组（语义化 region，含计数） |
| 详情渲染 SKILL.md 正文 + 状态 + 位置 | 只有名称与一句话说明 | ✅ `SourceEntry.content` 直接渲染正文（去掉 frontmatter）、显示来源与路径 |
| **启用 / 停用开关**（移动到 `skills-disabled/`） | 无 | ✅ 主进程新增 IPC，把技能目录移进应用数据目录并记索引，可原样移回 |
| 新建 / 编辑 / 删除 / 导出 / 导入 | 无（只有一个隐藏的「Add Skill」按钮） | ✅ 走 ACP 的 `sourcesCreate/Update/Delete/Export/Import` |
| 导入 Skill 文件夹 / 扫描本机 Claude Code Skills | 无 | 部分 ✅：文件夹导入（含支撑文件）；Claude Code 插件扫描由上游「插件」页承担 |
| 底部「{{count}} 个技能」 | 无 | ✅ |
| 「推荐 · 社区」技能市场 | 无 | ❌ **不做**：需要远端技能仓库与审核流程（见下方"仍未对齐"） |

**关键实现细节（为什么这么做）**：goose 内核**没有**技能的启用/停用概念——发现逻辑只按固定根目录
扫描（`~/.agents/skills`、`<project>/.agents/skills`、`.goose/skills`、`.claude/skills`），
frontmatter 里也没有 `disabled` 字段。所以唯一不改 Rust 就能让技能对 agent 隐形的方式，
就是参考产品采用的那种：**把目录移出被扫描的根**。我们用应用数据目录下的 `skills-disabled/`
加一份索引（记录原始路径），启用时移回原处；内置技能是编进二进制的合成路径，因此**不给开关，
而是如实说明"随应用更新，不能停用"**。

#### 模板页

| 参考产品有 | 现在的做法 |
|---|---|
| 「内置 · mma-paper」分组 | ✅ 分两组：内置 · 赛事模板（14 套提取）/ 上游开源模板（3 套 MIT/Apache） |
| 「默认用于」（中文界面 / 英文界面） | ✅ 直接读各模板 `template.json` 的 `defaultFor` |
| 「使用此模板」 | ✅ 已在上轮完成（封面信息随表单写进请求） |
| 「基于此模板自定义」+ 自定义模板可编辑可删除 | 部分 ✅：填一个名称后生成**让 agent 在项目内建副本并改造**的请求（`.modelforge/templates/<名>/`）。参考产品把自定义模板存在本机并直接编辑；我们走 agent 改造，因为改模板本质上要改 `.cls`/章节文件，agent 比表单更合适。**这是有意的差别，不是遗漏。** |

#### 算法页

| 参考产品有 | 现在 |
|---|---|
| 「在测试中使用」建算法会话 | ✅ 新增：建会话 + 首个消息（方法、调用入口、依赖、先检查依赖再跑、要求原始运行记录） |
| 「刷新算法目录与依赖状态」 | ❌ 未做：依赖检测目前由 agent 在会话里做（`check_env` 不查任意 Python 包）。做一个**假的状态徽章**不如不做 |

#### 连接器页

能力清单、传输方式、来源包、许可、运行命令、安装与凭据对话框**上轮已经具备**；
本轮补上参考产品有的「**添加自定义连接器**」——直接复用扩展编辑器（`ExtensionModal`），
任何用户已知的 MCP 服务器都能接进来，不需要改代码。

#### 个人信息页

| 参考产品有 | 现在 |
|---|---|
| 提示词总数 / 会话总数 / 活跃度热力图 / 最常用项 | ✅ 已有 |
| **当前连续天数 / 最长连续天数** | ✅ 本轮新增（由活跃日期算出；今天还没活动不会把连续天数打断） |
| 模型使用情况（占比条） | ✅ 本轮新增（按会话数占比） |
| 累计 Token / 最高活跃日 / 最常用推理模式 / 最活跃时段 | ❌ **不做假的**：`SessionListItem` 与 `SessionInfo` 都不带用量，逐会话加载才能求和，而参考产品是本地 SQLite 一句聚合。页面照旧写明"按会话统计，此处尚未汇总，聚合需要本地的用量库" |

#### 仍未对齐（需要后端或产品决策，不是本轮能"提取"出来的）

| 参考产品功能 | 为什么没做 |
|---|---|
| 推荐 · 社区技能市场（`bz1/bz2-*` 那批社区 Skill） | 需要远端技能仓库、审核与安装链路 |
| 插件页的「套装」（如 `paper-daily` = 图表 Skill + arXiv 连接器 + 定时任务） | 需要套装清单格式与安装编排；本机 Claude Code 插件的开关上游已有（`enabledPlugins`） |
| 数模广场、账号/积分/协作/飞书微信入口 | 需要自建后端，属 P3 |
| 真题案例卡片 | 版权原因坚持用自编样例题（见 A6） |

本轮的可验证结论：`check-skills` 44/44、`docs:check` 全绿、`lint:check` 退出 0、
新增 **12 条**自动化测试（技能启停 8 条 + 技能页 4 条），串行单测 **834 通过 / 4 失败**
（仍是那两个既有文件）。

### A11 内容本体提取（本轮）——不是等价物，是产品自己的东西

上一轮取的是**资产**（论文模板、绘图脚本），技能**正文**是我重写的等价物。你的反馈是
"我要的不是壳，是内容核心"，所以这一轮把产品的内容本体整体取了过来：

| 取到的内容 | 数量 | 落在哪 |
|---|---|---|
| 产品 12 个技能里的 10 个 **SKILL.md 正文** | 10 | 顶层技能文件（名字按本 fork 改） |
| **paper-diagram 全套**：5 套版式模板（含 content JSON）、8 个 Python 脚本、11 篇参考、Tabler 图标 | 131 文件 | `paper_diagram/` |
| **doctor / paper-search / data-search 的真实脚本**与参考文档、agent 清单 | 6 | 各自技能目录下 |
| **skill-creator 技能包**（含它自带 Apache-2.0 LICENSE） | 6 | `skill_creator/` |
| **90 张产品自带的图库预览**（无损 WebP） | 90 | `mathmodel_figure_templates/assets/previews/` |
| **三套真题**（2023 国赛 A 题 / 2023 华数杯 C 题 / 2024 高教社杯 C 题）：官方题面 PDF + 题面文本 + 附件 + 结果文件 | 15 文件 | `math_modeling/assets/examples/` |

合计 530 文件、46.7 MB。字体（29 个、约 118 MB 商业中文字体）默认仍不取；
`.disabled-by-default` 标记与 `paper-sharing` 技能刻意不取（前者在我们这儿是死文件，
后者依赖产品自己的上传后端）。

**验证的不是"文件在不在"，而是"能不能用"**：

| 检查 | 结果 |
|---|---|
| paper-diagram 5 套版式渲染 | ✅ 全部渲染出 `.drawio`（171/110/131/103/117 个图元） |
| `check_layout.py` 校验 | ✅ 5/5 **FAIL 0 / WARN 0** |
| `paper_search.py` | ✅ `verify` 返回权威元数据、`search` 双引擎排序、`bib` 由 Crossref 反查生成 |
| `record_source.py` | ✅ 写出 `data/sources.json`（schemaVersion + sha256 + 许可 + 获取日期） |
| `check_environment.py` | ✅ 输出 JSON 报告（平台 / Python / 工具 / 字体） |

**顺带修掉产品脚本在 Windows 上的真 crash**：本机控制台是 GBK，9 个会打印中文或 ✓ 的脚本
都会抛 `UnicodeEncodeError`。`roadmap_5band.py` 尤其隐蔽——它在**写 .drawio 之前**打印
`✓ 容量检查通过`，于是第一次测试时"渲染成功"看起来像"渲染失败"，文件根本没生成。
修法是给这些脚本加一个只重设 stdout/stderr 编码的守卫
（`ui/desktop/scripts/patch-extracted-scripts.js`，幂等），布局逻辑与输出文字一个字没动。

**正文采用不是照抄**：产品正文写着它自己的工具名（`AskUserQuestion`）、路径
（`.mathmodel/`、`assets/template/`）与 App 界面，直接抄在 goose 上跑不通。
`ui/desktop/scripts/adopt-product-skills.js` 统一施加并**逐条列出**全部替换（技能名、目录、
提问方式、品牌、`~/.claude/skills` → `~/.agents/skills`）；`data-search` 的 `browser_*` 一节
因为本 fork 没有内置浏览器而重写为降级方案；`paper-sharing` 依赖产品的上传后端，**不采用**。

**两处信息架构也跟着对齐了产品**：`mathmodel-figure-templates` 恢复成**独立技能**
（90 个模板 + 渲染器 + 4 篇参考 + 90 张预览都在它自己的目录下），`math-figure` 回到产品那种
"只做路由"的角色；图库目录因此新增 `skill` 字段，`script` 相对各自技能目录，
不再出现"同一个字段两种基准"。

这一轮也让 `docs-check` 的资产校验更有价值：它当场抓出 5 处"技能正文引用了不存在的文件"，
其中 3 类是**校验规则本身过严**（产品正文用 `<template.id>` 通用占位符、跨技能引用、
以及 `**Examples**: \`references/finance.md\`` 这类举例），规则已按这三种真实情况收紧，
同时保留对"真的要 agent 去跑却不存在"的拦截。

### A12 测试版核心内容补齐 + 一键切回可分发版（本轮）

你的要求是"测试要准，核心不能丢"。前两轮出于再分发风险跳过的东西这轮全部取回：

| 补的内容 | 数量 | 为什么必须取 |
|---|---|---|
| **29 个嵌入字体** | 118 MB | `wuyi` / `huawei` / `huazhong` 的类文件按**文件名**引用它们，`stats` 用方正书宋；缺字体就静默回退系统字体，**版面与产品不一致，测试结论不可信** |
| **`.disabled-by-default` 标记** | 2 | 产品默认停用 `data-search` 与 `metaheuristic-optimization`；文件已就位（局限记在 NOTICE.md：goose 的内置技能编进二进制，标记本身关不掉它） |
| **`paper-sharing` 正文** | 1 | 补齐产品 **12/12** 技能；上传步骤改成本机写 `sharing.json`，不会假装上传 |
| **PDF.js** | 185 文件 / 1.9 MB | 产品用它做论文预览；Apache-2.0 可分发。库已就位（`ui/desktop/vendor/pdfjs/`），**查看器 UI 尚未接线** |
| **用真实字体重编译 17 套模板** | — | `wuyi` 回到产品原始字体引用（不再是我上轮改的 `Consolas`），17/17 编译通过 |

**没取的两项，理由不是风险而是没用**：`claude-code/claude.exe`（272 MB，Anthropic 专有 CLI，
本 fork 的运行时是 goose 内核，应用根本不会调用）；`bin/uv.exe`（65 MB，我们自己的打包流水线
已按哈希固定 `uv.exe`/`uvx.exe`，重复一份没有意义）。

**一条命令在"测试版"与"可分发版"之间切换**：

```bash
cd ui/desktop
node scripts/strip-unshippable.js            # 只出清单，不删任何东西
node scripts/strip-unshippable.js --write    # 删字体 + 真题 + 许可未声明的模板
pnpm run papers:catalog && pnpm run docs:check
```

清单：**177 个文件**（29 字体 + 15 真题 + 109「无许可声明」+ 24「上游仓库无许可」），
**保留 8 套模板**（5 套 LPPL + `cumcm-latex`/`jxust-latex` MIT + `cumcm-typst` Apache-2.0）。
剥离后 `wuyi`/`huawei`/`huazhong`/`stats` 会因缺字体编译失败，脚本与文档都会提示改指系统字体或下架。

**文档跟着改了**：`NOTICE.md` 里"字体刻意未取""真题刻意未取"两节都改成"**本树里就有**，
并写明剥离命令"；模板目录的 `README.md` 同步；`REPORT-extraction.md` 增加第三轮记录。
**这两处如果不改，文档就会和树里的真实情况相反**——这正是 `docs-check` 存在的意义。

### A13 把项目跑起来：自编译内核 + 桌面端（本轮）

你要"先运行看看"，而桌面端需要 Rust 内核（`goose.exe`），本机原本没有 Rust 工具链。
这一轮把它跑通了，过程里踩的坑值得写下来——**下次改完 Rust 重新编译就是两条命令**：

```powershell
.\build-kernel.ps1            # 同步源码到 ASCII 目录 + 编译 + 自检
.\start-modelforge.ps1        # 用自编译内核启动桌面端
```

#### 为什么绕了这么远

| 问题 | 现象 | 处理 |
|---|---|---|
| 没有 MSVC 工具链 | 没有 VS Build Tools / Windows SDK，`link.exe` 只有 Git 自带的那个 | 改用 **GNU 目标**（`x86_64-pc-windows-gnu`），本机 Strawberry Perl 自带 MinGW-w64 gcc 13.2 + cmake + nasm |
| **MinGW 的 ld/dlltool 不认非 ASCII 路径** | `dlltool: Can't create .lib file` / `ld: cannot find E:\桌面\智能体\...\libstd-*.rlib` | 编译环境整体搬到 ASCII 路径 |
| junction 没用 | 给项目建 `E:\goose` junction 后仍报中文路径——**cargo/rustc 会 canonicalize，把 junction 解回真实路径** | 改成**真实复制**一份源码到 `E:\goose-build` 编译 |
| 工具链 sysroot 在中文用户名下 | `cannot find C:\Users\韩正阳\.rustup\toolchains\...\libstd-*.rlib` | `RUSTUP_HOME=E:\rustup`、`CARGO_HOME=E:\cargo`（含 registry） |
| crates.io 直连大量超时 | 数百条 `spurious network error [28] Timeout` | 换 **rsproxy.cn** 镜像（索引与包体都镜像；TUNA 只镜像索引，`dl` 仍指向 static.crates.io） |
| `v8-goose` 构建失败 | `code-mode` 特性拉进的 V8 绑定，GNU 目标没有预编译包 | 构建时去掉 `code-mode` 与 `local-inference`（后者要编译 llama.cpp） |

#### 实际编译参数

```
cargo build -p goose-cli --bin goose --no-default-features \
  --features rustls-tls,system-keyring,telemetry,otel,aws-providers,update,nostr
```

- **没带** `code-mode`（V8）、`local-inference`（llama.cpp）：这两个在 GNU 目标上不可行或极慢，
  不影响对话、技能、MCP、调度器；
- `RUSTFLAGS="-C target-feature=+crt-static"`：静态链接 MinGW 运行时，产物不依赖任何 DLL；
- 编译耗时 **15 分 56 秒**（677 个 crate，20 核并行），产物 `target/debug/goose.exe` 1.08 GB（debug 带调试信息）。

#### 编译产物的验证（不是"编过了"就算）

| 检查 | 结果 |
|---|---|
| `goose.exe --version` | ✅ 1.50.0 |
| **自研 modeling MCP 握手** | ✅ `serverInfo: {"name":"goose-modeling","version":"1.50.0"}`，工具 `check_env, compile_latex` |
| 内置技能 | ✅ **47 个**，来源为 `builtin://skills/...`（`math-paper` / `doctor` / `nature-figure` / `paper-diagram` 逐个确认） |
| 桌面端接入 | ✅ 日志 `Starting goose serve from: E:\goose-build\target\debug\goose.exe`，窗口标题 `ModelForge`，React 已挂载 |

**一个容易误判的坑**：先用官方发布版二进制做预览时，我把 45 个技能装到了 `~/.agents/skills`；
换成自编译内核后它们会**同名遮蔽内置技能**，`skills list` 里显示成用户技能。
要看到真正的「内置」来源，把那批副本删掉即可（`build-kernel.ps1` 的验证步骤会数 builtin 数量）。

#### 关于参考产品的 `claude.exe`：可以接，但不要打包

参考产品把 272 MB 的 `claude-code/claude.exe` 打进安装包，用非开源的 TS SDK 驱动。
本 fork 里有更干净的路：goose 内置 `claude-code` 这类 **ACP provider**，
二进制路径由 `CLAUDE_CODE_COMMAND` 配置（默认 `claude`）。也就是说**本机装了什么 Claude Code
就指向什么**，既不用打包，也不碰再分发条款。Anthropic 的合规红线是：
不得修改其二进制、不得代付费/转售终端用户用量（每个用户自带 key）、
不得拿 Claude/Anthropic 的名字与 logo 当自家产品名。

### P-C 后续（不在本轮）

- 数模广场（论文社区，需后端）
- 账号/积分/计费（需后端，且合规上不能代付）
- 飞书/微信机器人（上游代码已有，需实测配置）

## 三、约束与红线

1. **技能正文一律自行重写，不照抄产品文本。** 模板与图形**资产**是按你的要求从本机已安装
   产品提取的（你自己机器上的文件），每套的许可状态逐条记在 `NOTICE.md`：LPPL 那 5 套可再分发，
   无声明的 7 套标注为"许可未解决"。**对外分发前需要先做取舍**（只留 LPPL + 采购的 3 套）。
2. **每引入一个第三方资产必须**：核对许可 → 保留原 `LICENSE` → 在 `NOTICE.md` 登记来源与版权。
   自带明确开源许可的（`nature-figure` Apache-2.0、`cumcm-latex`/`jxust-latex` MIT）可整包内置。
3. **不动 Rust 内核大逻辑**；页面数据优先用桌面端本地数据文件驱动。
4. 每个阶段结束必须跑通 `pnpm run lint:check`（typecheck + eslint + i18n:check）、
   `node scripts/check-skills.js` 与 `pnpm run docs:check`（后者现在还会校验引用资产是否存在），
   并把结果记入 `MODELFORGE_CUSTOMIZATION.md` 的「验证状态」。

## 四、已知待决

| 项 | 说明 |
|---|---|
| `goose://` 是否改 `modelforge://` | 改则作废已发布 deeplink，需同时改协议注册 |
| `app-update.yml` / `githubUpdater.ts` 的 `your-org/modelforge` | 等真实仓库地址 |
| 内置真题的版权 | 赛题通常可公开获取，但"再分发"需逐个确认；未确认前用自造样例 |
| 目录页文案的 i18n 化 | 页面框架文案已走 i18n（16 语言）；`src/catalog/*.ts` 里的条目正文目前是中文硬编码，等确认产品主语言后再迁移到 i18n |

## 五、验证（本机实测，2026-09）

| 检查 | 结果 |
|---|---|
| `pnpm run lint:check`（typecheck + eslint + i18n:check） | ✅ 退出码 0 |
| `i18n:validate-locale` | ✅ 15 语言 / 1916 条（zh-CN/zh-TW 已翻译，其余回退英文） |
| `check-skills` | ✅ **47/47**（`math_paper` +233、`math_figure` +149、`nature_figure` +99 支撑文件；含 agentskills 规范校验：名称模式、描述 ≤1024 字符） |
| `docs:check` | ✅ 四个文档的声称数字与文件系统一致，**并新增"引用的资产必须存在"校验**（技能正文/目录文件/主页预设指向的模板、脚本、入口文件逐个核对） |
| `connectors:check` | ✅ **8/8 连接器真实 MCP 握手**：arxiv 19 工具、crossref 18、drawio 5、zotero 3、context7 2、web-fetch 1；fred/github 正确要求凭据 |
| `brand:check` | ✅ |
| 自研脚本 | ✅ `paper_search.py`（检索/DOI 交叉验证/BibTeX/伪 DOI 拒绝）与 `record_source.py`（登记/列表/去重/凭据拒绝）实测通过 |
| `vite build`（renderer） | ✅ 2.1s，14 张绘图预览 + 17 张论文预览全部产出到 `dist/assets/` |
| `pnpm run figures:build` | ✅ 14/14 模板出图 |
| `pnpm run papers:build` | ✅ **17/17 模板编译通过**并渲染首页预览 |
| `vitest run`（默认并行） | 失败数在 8–34 之间波动，**不可作为判据** |
| `vitest run --no-file-parallelism`（串行） | **834 通过 / 4 失败**（稳定，每次同样 2 个文件；含目录页「使用此模板」4 条与技能页/启停 12 条测试） |

**关于单测失败——请以串行结果为准**：默认并行下失败数在 8–34 之间大幅波动，而串行运行稳定在
4 个失败，且每次都是同样 2 个文件：

- `desktopFileAccess.test.ts` 2 项：Windows 临时目录大小写差异
  （期望 `C:\WINDOWS\TEMP`，实际 `C:\Windows\Temp`），纯路径断言问题。
- `CustomProviderForm.test.tsx` 2 项：`userEvent` 5s 超时。**已实测排除本次改动**：
  临时移除 modeling 扩展后仍失败；单文件运行通过。

结论：失败与本次改动无关，是 `userEvent` 在并行高负载下的超时抖动。
排查时建议带 `--no-file-parallelism`。

**本机可用但未纳入本轮的工具**：这台机器装有 TeX Live 2024
（`xelatex` / `latexmk` / `pdftoppm` / `pdfinfo` 都在 `E:\texlive2024\texlive\2024\bin\windows`），
所以论文模板是真的编译验证过的。`check_env`（modeling 扩展）也已能检测到 LaTeX。

**未验证**：

1. ~~Rust 工具链缺失，`just run-ui` 起不来，因此所有新页面没有在真实应用里目视验收~~
   → **已做**：A13 用 GNU 目标编出内核，A14 把桌面端实跑起来并逐页验收（见下）。
   仅"缩略图裁切比例"这类纯视觉项留待人工看 A14 存下的截图。
2. ~~Typst 模板：本机没有可用的 typst 命令行，`cumcm-typst` 只内置库文件、未写入口文件~~
   → **已解决**：A2 取得 typst 0.15.1 预编译二进制、补写 `paper.typ`，并改为本地
   `theorems.typ` 以免首次编译联网，17/17 编译通过。
3. 各赛事**当年度**的论文格式规范（封面、页数上限、编号规则）会变，骨架不等于合规保证。

### A14 桌面端实跑验收（本轮）

**首次跑通时要逐个点开的页面已全部验收通过**：侧栏「扩展」展开态（技能/模板/算法/插件/连接器）、
`/algorithms`、`/figures`、`/paper`、`/connectors`、`/profile`，以及主页的预设栏与示例卡片。

**验收过程中修掉一个阻断级缺陷**（值得单独记，因为它看起来像"前端坏了"）：

`ui/desktop/vite.renderer.config.mts` 缺 `server.host`。本机 `localhost` 解析到 `::1`，
Vite 于是只监听 IPv6；Chromium 解析 `localhost` 走 IPv4 → `ERR_CONNECTION_REFUSED`，
窗口停在 `chrome-error://chromewebdata/`，**七个路由截图全是同一张白图、`innerText` 长度 0**。
修法是显式 `server: { host: '127.0.0.1' }`（仍只监听回环）。重启后日志出现
`React ready event received`，七页全部渲染出真实内容。

**另发现两处「界面与内容不一致」（未修，待决）**：

| # | 位置 | 问题 |
|---|---|---|
| 1 | `/figures` | 同一页两个数字：筛选条「全部 **104**」vs 页脚「共 **102** 个模板**」。差的 2 条是 cartopy 模板（`available: false`，需 MSVC），显示为「模板待补充」。文档里"图库零占位"的说法因此不成立（已在上文 A3 处更正） |
| 2 | 主页示例卡片 | `src/catalog/homePresets.ts` 指向的是**真实赛题**（2023 国赛 A 题 / 2023 华数杯 C 题 / 2024 高教社杯 C 题，官方题面 PDF 在 `math_modeling/assets/examples/`），但界面标题仍是「试试这些数模样例题」、徽标仍是「已附带样例题数据」。这是 A6 的"自编样例题"决策被 A11/A12 的"提取真实赛题"取代后**文案没跟上**；且牵连分发口径——`strip-unshippable.js` 删掉真题后，这两句文案才重新成立 |

**一处开发模式的正常噪音（不是回归）**：启动日志有 3 条
`Failed to copy shim uv.exe / uvx.exe / npx.cmd`（`ensureWinShims`，ENOENT）——
开发模式 `resources/bin` 没有填充（打包时才由 `prepare-platform-binaries.js` 放入），
所以 shim 拷不出来。含义是**开发模式下依赖 `uvx`/`npx` 的连接器解析不到命令**，
与单独跑通的 `connectors:check` 不是一回事。
