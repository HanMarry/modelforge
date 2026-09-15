---
name: math-paper
description: 使用内置的多赛事 LaTeX 模板完成数学建模竞赛的逐问建模求解、论文撰写、高级绘图和编译。适用于所有竞赛论文，以及包含 .tex、.cls 文件的数学建模论文项目。
---


# Workflow


## FIRST STEP

完成所有问题，完成所有建模任务

先读取当前项目的 `.modelforge/paper/config.json`（若存在）并确认模板来源：

- `template.source` 为 `custom` 时，以配置中的 `template.sourcePath` 普通目录为模板源。
- `template.source` 为 `builtin` 时，先定位本技能所在目录（goose 加载技能时会打印它，即
  `math_paper/`），再以其中的 `assets/templates/<template.id>/` 为模板源，不要依赖固定的用户主目录路径。
- 没有项目配置时，优先采用首条任务提示明确指定的模板源；仍判断不出来时，中文默认 `cumcm`，英文默认 `mcm`。

仅当配置指定的入口 `.tex` 尚不存在时，才由你把模板源完整复制到当前工作目录；若入口已存在，直接在当前论文上继续，禁止用模板覆盖已有论文、`.modelforge/`、`AGENTS.md` 或 `CLAUDE.md`。

创建 python 虚拟环境，使用 python 或 uv

先用一次集中的提问块问我几个问题（关于每个模型的选择），然后做 plan，再开始执行。


Notice:
- 本 fork 没有 AskUserQuestion 工具：直接在回复里一次问 2–4 个问题，每题 2–4 个选项，不要挤牙膏式反复追问
- **示意图必须通过 `paper-diagram` Skill 绘制（2ProblemRestatement 流程图等）**：技术路线图、
  研究框架图、论文/算法流程图、模型架构图一律调用 `paper-diagram` Skill 完成——优先套用其内置模板
  （roadmap-5band / roadmap-3phase / framework-3col / stageflow-3col / taskflow-land），产出可编辑 `.drawio` + PNG，
  并用其 `check_layout.py` / `export_figure.py` 校验与导出。
  若 `paper-diagram` 未启用，再自行用 draw.io 绘制并如实告知用户。
- 如果物理题记得使用 tikz 绘制物理图
- 每个问题分开.py 求解，不要一次性求解，保存成文件运行。
- 论文 latex 完整格式正确美观
- **参考文献必须真实（8Reference / book.bib）**：一律通过 `paper-search` Skill 检索真实文献——
  先 `search` 找候选，再 `verify` 核对元数据，最后用 `bib --doi <DOI> --key <引用key>` 生成条目
  追加进 `book.bib`；禁止凭记忆手写或编造 bib 条目的题名、作者、期刊、卷期页。
  若 `paper-search` 未启用或网络不可用，只保留能人工核验的真实文献，宁缺毋滥，并如实告知用户。
- 尽可能绘制数量多、类型多、美观的图像（比如分组箱线图 / 小提琴图，Sankey 流向图，SHAP/贡献度图 等等比如seaborn,plotnine）
如果 `nature-figure` Skill 已启用，优先调用它；如果未启用，则按下文的图表类型、
统一样式、DPI 和质量基线自行完成同等质量的绘图，不要中断论文工作流。
  **只采用它的作图规范（配色、版式、DPI、导出），不要采用它的图注(legend)规范** ——
  那套 `Fig. N |` 自足式长图注（分面 a/b 逐项描述 + 颜色映射 + 300 词上限 + 末句结论）
  是投 Nature 系期刊用的，套到国赛论文上会让 `\caption{}` 长到挤爆版面。图注一律按下面这条规则写。
- 绘图的中文字体使用SimSun 保证正确
- **图注写短，解读写正文**：`\caption{}` 只写一句短图题（≤20 字，不带句号、不写结论、不逐项解释
  (a)(b)），例如 `\caption{SiC 与硅样品反射光谱概览}`。"这张图展示了什么、能得出什么结论"、
  子图 (a)(b) 分别是什么、图中颜色/虚线含义，一律写进图前后的正文段落
  （"如图~\ref{fig:xx} 所示……可见……"）。**禁止把整段解释塞进 `\caption{}`**——
  图注过长会挤占版面、破坏排版，评委也读不到正文里的分析，图片需要在文中引用和对应解释。

## SECOND STEP

绘制并补充更多高级图表


通读论文，补充更多种类、更专业的可视化图表

已有内容基础上绘制并补充更多图像，全面提升论文的可视化水平。要求：

        使用seaborn、matplotlib、plotnine、plotly、networkx、igraph、altair、bokeh、geopandas、folium、graphviz等库绘制多样化、高级图表，确保风格统一，图像清晰美观。具体要求如下：

1. **相关图优先组成多面板图**：同一问题、共同支撑一个结论或需要直接比较的 2–4 幅图，优先合并为多面板组合图（multi-panel figure）；2 幅通常采用 1×2，4 幅通常采用 2×2，子图用 (a)–(d) 标注，并统一字号、配色与版式，可比较的数据尽量统一坐标尺度、共享图例或色标。仅在合并后文字和关键细节仍清晰时使用，禁止为减少图号而强行拼接无关图。
2. 优先使用 seaborn（配合 matplotlib）绘图，充分利用其内置主题和调色板；按需选用其他库：plotly（交互式、3D、桑基图）、networkx / igraph（网络与图论）、plotnine（ggplot 风格图层语法）、altair / bokeh（声明式与交互式）、geopandas / folium（地理空间与地图）、graphviz（流程图、结构图）、wordcloud（词云）。
3. 多样化、上档次，不要只用折线图柱状图。鼓励优先使用以下高级图表（按数据特征挑选）：
   - 关系/相关性：相关系数热力图、成对关系图 pairplot、带树状图的聚类热图 clustermap、六边形分箱图 hexbin、二维核密度等高线 KDE
   - 分布：小提琴图 violinplot、山脊图 ridgeline、联合分布图 jointplot、雨云图 raincloud、蜂群图 swarmplot、经验累积分布 ECDF、直方图叠加密度曲线
   - 占比/层级：旭日图 sunburst、矩形树图 treemap、马赛克图 mosaic、漏斗图 funnel、华夫饼图 waffle
   - 多维/评价：雷达图 radar、平行坐标图、桑基图 Sankey、气泡图 bubble、3D 曲面图 / 3D 散点、热力日历图 calendar heatmap
   - 时间序列：时序分解图（趋势/季节/残差）、自相关图 ACF/PACF、堆叠面积流图 streamgraph、甘特图 Gantt
   - 优化/运筹：帕累托前沿 Pareto front、算法收敛曲线、可行域与约束图、等高线/等值线图 contour、向量场图 quiver
   - 模型诊断：灵敏度龙卷风图 tornado、残差图、Q-Q 图、ROC 曲线、PR 曲线、校准曲线、学习曲线、混淆矩阵热图、特征重要性 / SHAP 图、部分依赖图 PDP、决策边界图
   - 统计推断：置信区间误差带、bootstrap 分布、森林图 forest plot
   - 仿真/概率：蒙特卡洛模拟散点云、概率密度演化图、生存曲线 Kaplan-Meier
   - 微分方程/动力系统：相图 phase portrait、流线图 streamplot、分岔图 bifurcation
   - 多目标决策：TOPSIS / 熵权法得分排序图、层次分析 AHP 权重图
   - 结构/网络：网络图 networkx、弦图 chord、树状聚类图 dendrogram
   - 空间/地理：地理分级填色图 choropleth、等值面图、栅格热力图、流向图 flow map
4. 风格统一：为整篇论文定义一套全局样式（如 sns.set_theme() + 统一调色板 + plt.rcParams），所有图复用同一套配色和字体。
5. 质量基线：每张图都有清晰的标题、坐标轴标签、单位和图例；字体大小适中不重叠；以高分辨率保存（DPI ≥ 300）；含中文时正确配置中文字体，避免方框乱码。
6. 正确嵌入：把新图保存到合适目录，在论文对应位置插入，配上短图注（`\caption`，≤20 字，只写图题）
   和 `\label`；"这张图展示了什么、能得出什么结论"写成图旁的正文段落，用 `\ref{}` 引用图号，
   不要写进 `\caption{}` 里。
7. 只增强、不改动原有的数据、模型和结论。
