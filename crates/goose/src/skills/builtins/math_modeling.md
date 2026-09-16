---
name: math-modeling
description: 数学建模竞赛全流程（国赛 CUMCM / 美赛 MCM / 华数杯等）。凡是要解一道建模题、分析附件数据、建立模型、写建模论文，或用户粘贴题目、上传数据附件、说"帮我做这道题""这道题怎么建模"时使用。覆盖读题拆解、模型选型、Python 实现、检验、配图与论文结构，并按子问题类型指向对应的专项技能。
---

# 数学建模全流程

任何竞赛式建模任务都按这条流水线走，不要跳步。

## 内置真题与样例题

**三套真题**（题目 PDF、题面文本、附件与结果文件）随应用提供，位于 `assets/examples/`：

| 目录 | 赛事 | 题目 | 练什么 |
| --- | --- | --- | --- |
| `assets/examples/2023国赛A题/` | 2023 国赛 A 题 | 定日镜场的优化设计 | 光学效率物理建模、镜场布局优化、几何计算 |
| `assets/examples/2023华数杯C题/` | 2023 华数杯 C 题 | 母亲身心健康对婴儿成长的影响 | 缺失值处理、统计检验、回归与分类 |
| `assets/examples/2024高教杯C题/` | 2024 高教社杯 C 题 | 农作物的种植策略 | 多年期种植规划、MILP 建模、稳健性检验 |

每个目录含 `questions.txt`（题面全文，先读它，不需要 PDF 工具）、官方题面 PDF、
数据附件，以及赛事方发布的结果文件模板。**这些是赛事方的版权材料**，随本 fork 仅供本机使用，
再分发前先看 `NOTICE.md`。

**三道自编样例题**（合成数据、可自由分发）位于 `assets/samples/`，适合离线跑通全流程：

| 目录 | 领域 | 练什么 |
| --- | --- | --- |
| `assets/samples/production-planning/` | 多目标优化 | LP/MILP 建模、Pareto 前沿、灵敏度参数区间 |
| `assets/samples/demand-forecast/` | 时间序列 | 缺失值与异常处理、季节分解、滚动回溯、朴素基线 |
| `assets/samples/water-quality/` | 综合评价 | 正负向指标归一化、熵权与 AHP 双权重、权重扰动 |

每个目录含 `problem.md`（题面）、`generate_data.py`（固定种子）与已生成的 `data/`。
它们是**为本项目自编的练习题**，数据是合成的，图内与题面都标注了这一点，
不要把里面的数字当成真实观测。

## 第 1 步 — 读题与拆解

- 完整读题面与**每一个**数据附件，再提模型。
- 明确列出子问题（通常是 2–4 问），不要合并成一句"求解该问题"。
- 写出假设，并标出题目未明确的地方。
- 先体检数据：表结构、字段、单位、缺失值、异常值。
- 加载 `data-prep` 再动数据；存在极端值、或"极端值本身就是问题"时，
  加载 `outlier-and-anomaly-detection`。

## 第 2 步 — 选型并说明理由

按子问题类型选模型族，用一两句话说明为什么它优于替代方案：

| 子问题类型 | 候选模型 | 要加载的技能 |
| --- | --- | --- |
| 排序 / 评价 | AHP、TOPSIS、熵权法、灰色关联 | `evaluation-method` |
| 含偏好的多准则**决策** | 加权和、MAUT、ELECTRE、PROMETHEE | `multi-attribute-decision` |
| 连续响应，解释或预测 | 线性/岭/Lasso、GAM、GBDT | `regression-modeling` |
| 分类响应 | logistic、SVM、随机森林、XGBoost | `classification-modeling` |
| 计数 / 有序 / 比例响应 | Poisson、负二项、有序 logit、beta | `count-and-ordinal-models` |
| 极端值本身是问题，或要清洗 | IQR / MAD / 孤立森林 / LOF | `outlier-and-anomaly-detection` |
| 无标签分组 / 分群 | K-means、GMM、DBSCAN、层次聚类 | `clustering-analysis` |
| 时间序列 | ARIMA/SARIMA、VAR、Prophet、分解 | `time-series` |
| 序列中途改变行为 | CUSUM、PELT、二分段、马尔可夫切换 | `changepoint-and-regime` |
| 极短序列（4–15 个点） | GM(1,1)、指数平滑、组合预测 | `grey-and-ensemble-prediction` |
| 优化 / 调度 | LP/ILP、遗传算法、模拟退火、PSO | `optimization-modeling` |
| 黑箱 / 非凸 / 不可导 / 组合优化 | MEALPY、pymoo（多目标） | `metaheuristic-optimization` |
| 目标只能靠仿真评估 | 公共随机数、SAA、排序与选择 | `simulation-optimization` |
| 机理建模 | ODE/PDE、反应、扩散、热传导 | `differential-equation-modeling` |
| 时空场（扩散、对流） | 有限差分、方法线、CFL | `pde-modeling` |
| 选址 / 覆盖 | p-median、最大覆盖、集合覆盖、CFLP | `facility-location` |
| 实验或参数扫描设计 | 全因子、部分因子、响应面 | `experimental-design` |
| 路径、网络、流量 | 最短路、最大流、匹配、MST、TSP | `graph-and-network` |
| 位置、区域、坐标 | 插值、空间自相关、选址 | `spatial-analysis` |
| 排队、拥堵、排班 | M/M/c、Little's 定律、离散事件仿真 | `queueing-and-simulation` |
| 订多少 / 何时补货 | EOQ、报童、安全库存、(Q,R) | `inventory-and-supply-chain` |
| 失效时间、寿命、维修时机 | Weibull、风险函数、删失、年龄更换 | `reliability-and-survival` |
| 局部规则 → 全局格局 | 元胞自动机、agent-based | `cellular-automata` |
| 统计推断 | 假设检验、相关、ANOVA、PCA | `statistical-testing` |
| 数据脏或需要体检 | — | `data-prep` |
| 任何需要检验的模型 | — | `sensitivity-analysis` |
| 多个候选模型要比 | — | `model-comparison` |
| 写可复现的代码 | — | `code-and-reproducibility` |
| 写假设与符号表 | — | `assumptions-and-notation` |
| 把结果变成图 | — | `result-visualization` |
| 组织论文章节 | — | `paper-structure` |
| 找文献、排引用 | — | `citations-and-references` |
| 收尾写摘要与结论 | — | `abstract-and-conclusion` |

选定方法后**先加载对应技能再写代码**——那里写着评审会扣分的失败模式与必须报告的项。

任何模型都要交代：目标函数、变量、约束，以及为什么选它而不是替代方案。

## 第 3 步 — 用 Python 实现

- 用 numpy / scipy / sympy / pandas / matplotlib / seaborn。
- **每个子问题一个脚本**，放 `code/` 下，共用工具放 `utils.py`。
- 写 `requirements.txt`（或用 `uv`）；参数外置到 `config.yaml`，固定随机种子。
- 打印**每一个**将写进论文的数值结果，并把中间产物落盘到 `results/`。
- 按 `code-and-reproducibility` 的目录布局、依赖锁定与环境记录执行。

## 第 4 步 — 检验

- 灵敏度分析：关键参数 ±10–20%，报告对结论的影响。
- 与基线（朴素模型、历史数据、已知结果）对比。
- 给出残差/误差/精度指标并解释其量级。
- 多于一个候选模型时用 `model-comparison`：统一协议、指名基线、给出差异的区间。
- 用 `sensitivity-analysis` 给出"结论仍然成立"的参数区间。

## 第 5 步 — 出图

- 每张图都要有标题、坐标轴、单位与图例；正文未引用的图删掉。
- 同时导出矢量（PDF/SVG）与位图（PNG，DPI ≥ 300），整篇共用一套配色与字号。
- **走 `math-figure`**：数据图表用它的 14 个模板或 90 个内置科研绘图模板；
  需要投稿级多面板图时用 `nature-figure`；技术路线图/流程图走 `paper-diagram`；
  物理示意图用 TikZ。不要另起一套风格。
- 用 `result-visualization` 决定图型与图注写法。
- 图注 ≤20 字只写图题，解读写进正文（见 `math-paper`）。

## 第 6 步 — 写论文

用 `math-paper` 的章节结构与自带赛事模板；结构固定为：
摘要 → 问题重述 → 问题分析 → 模型假设与符号说明 → 模型建立与求解 → 模型检验 →
模型评价与推广 → 参考文献 → 附录（摘要最后写）。

分工：`assumptions-and-notation` 管第 3–4 节，`paper-structure` 管第 2–6 节与附录，
`citations-and-references` 管第 8 节（引用必须真实，走 `paper-search`），
`abstract-and-conclusion` 管第 1、7 节。

## 第 7 步 — 交稿前评审

对完成的稿子跑 `math-review`：六个维度打分，按对得分的影响排出问题清单。
环境有问题（缺 xelatex、缺绘图库）时先跑 `doctor`，不要盲目重试。

## 规则

- 绝不编造数据、引用或数值结果。
- 每个假设都写出来；模型是近似的就直说。
- 代码可复现：固定随机种子、依赖版本锁定。
- 论文里的每个数字都要追得到 `code/` 下的脚本与 `results/` 下的产物。
- 摘要最后写，写完再对照最终数字复查一遍。
