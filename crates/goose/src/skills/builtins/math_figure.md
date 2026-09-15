---
name: math-figure
description: 数学建模论文配图的统一入口。用户说“画图”“画一张…图”“补几张图”“把这个数据可视化”“画技术路线图/流程图”“复刻某个绘图模板”时使用。本 skill 不直接作图，只做路由——按需求把任务分派给 nature-figure（数据图表）、mathmodel-figure-templates（内置科研绘图模板复刻）或 paper-diagram（draw.io 流程/框架图），保证图片落到当前项目 figures/ 目录，并在项目含 document.tex 时给出可直接粘贴的插图 LaTeX 片段。
---

# 论文配图路由

先判断要画的是哪一类图，再调用对应 skill 完成；不要绕过它们自己从零手写。
一次请求里混有多类图时，逐类分派，最后统一汇总产物清单。

## 1. 分类与分派

| 需求特征 | 分派到 | 触发方式 |
|---|---|---|
| 折线 / 柱状 / 散点 / 热力图 / 小提琴 / ROC / SHAP 等**由数据生成**的图表 | `nature-figure` | 先问清 Python 还是 R（默认 Python，用户没说就直接用 Python 不要卡住） |
| 用户点名某个**内置模板**（SHAP 蜂群、配对雨云、泰勒图、和弦图、局部 Moran、土地利用等）或要"照着画廊那张画" | `mathmodel-figure-templates` | 先在其 `references/figure-catalog.md` 匹配模板 id，用它的 `render_template.py` 渲染，再按用户数据改参数 |
| 技术路线图 / 研究框架图 / 论文流程图 / 算法流程图 / 模型架构图 / 系统示意图 | `paper-diagram` | 优先套用其内置模板（roadmap-5band / roadmap-3phase / framework-3col / stageflow-3col / taskflow-land），产出可编辑 `.drawio` + PNG |
| 物理/几何示意图（受力、光路、坐标系） | 直接用 TikZ 写进 LaTeX | 不走上面三个 skill |

拿不准归哪类时按"图是不是由一组数值算出来的"判断：是 → 数据图表；否 → 示意图。

## 2. 产物约定（所有分支都遵守）

- 图片保存到当前项目根下的 `figures/`（不存在就创建），文件名用英文小写加下划线，如 `figures/sensitivity_tornado.png`。
- 同时保留脚本或源文件：Python 脚本放 `figures/scripts/`，draw.io 源文件与 PNG 同名放 `figures/`。
- 中文字体用 SimSun，DPI ≥ 300；同一批图共用一套配色与字号。
- 项目里存在 `document.tex` 时，每张图附一段可直接粘贴的插图片段，并给出建议插入的章节：

```latex
\begin{figure}[htbp]
  \centering
  \includegraphics[width=0.8\textwidth]{figures/sensitivity_tornado.png}
  \caption{灵敏度分析龙卷风图}
  \label{fig:sensitivity-tornado}
\end{figure}
```

- `\caption{}` 只写一句 ≤20 字的图题；"图说明了什么、能得出什么结论"写成正文段落，不塞进图注。
- 只画图、不改动用户已有的数据、模型与结论。

## 3. 收尾

用一张表汇总：图名 → 文件路径 → 生成方式（哪个 skill / 脚本）→ 建议插入位置。
某个 skill 未启用或运行环境缺失（如没有 Python 绘图库）时，如实说明，并给出退路：
数据图表退回 seaborn/matplotlib 自绘，示意图退回手写 draw.io XML。
