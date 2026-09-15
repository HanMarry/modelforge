---
name: result-visualization
description: 为结果选对图型并按论文规范出图。当要决定"用什么图表示"、写图注，或用户说"这张图不好看""怎么画更清楚"时使用。含按"想说什么"选图型、柱子零基线、颜色按用途（顺序/发散/分类）、标注结论、多面板规范与图注三段式。
---

# Result Visualisation

Use this skill when turning results into the paper's figures. `math-figure` covers how to
render; this skill covers **which chart, which axis, which colour, and what the caption
must say**.

## Requirements

```bash
uv pip install numpy pandas matplotlib
```

Reuse `math-figure`'s `_style.py` for the shared palette and rcParams; do not invent a
second house style.

## Step 1 — Pick the chart from the message, not from habit

| What you want to say | Chart | Avoid |
|---|---|---|
| how a quantity changed over time | line | bar chart of a time series |
| comparison across a few categories | bar, sorted by value | pie chart |
| comparison across many categories | horizontal bar, sorted | vertical bars with rotated labels |
| distribution of one variable | histogram, violin, ECDF | bar of binned means |
| distribution across groups | box, violin, or half-violin + points | bar of means with error bars only |
| relationship between two variables | scatter (+ fit line) | line connecting unordered points |
| three variables at once | scatter with size/colour encoding | 3D scatter |
| correlation across many variables | heatmap, or scatter matrix | table of numbers |
| composition over time | stacked area | stacked bar with many categories |
| trade-off frontier | line/scatter of the Pareto front | table of objectives |
| a metric across models | heatmap or radar after normalisation | raw units on one axis |

A **bar chart of means with no spread** hides whether a difference is real. If you show
means, show the uncertainty (error bars with a stated meaning, or the points themselves).

## Step 2 — Make the axes honest

- **Start a bar chart's axis at zero.** Bar length encodes magnitude; truncating the axis
  misrepresents it. Line charts may truncate, but say so if the truncation exaggerates.
- **Label the axis with the quantity and its unit**: "功率 / kW", not "value".
- **Do not use a log axis without marking it** ("log scale" in the axis label), and never
  to hide a spread you would rather not show.
- **One y-axis per panel.** Two different scales on one panel invites a false correlation
  reading; use two stacked panels sharing the x-axis instead.
- **Order categories meaningfully** — by value, by time, or by a stated order. Alphabetical
  order is almost never the useful one.

## Step 3 — Use colour with a job

| Encoding | Use |
|---|---|
| Sequential (light→dark) | a magnitude |
| Diverging (two hues through a neutral) | a signed value around a meaningful zero |
| Categorical (distinct hues, ≤6) | group identity |
| Position or shape | **prefer these over colour** when there are more than six groups |

- Do not use a rainbow/jet scale for a continuous variable — it invents boundaries.
- Make it **colour-blind safe**: distinguish groups by lightness as well as hue. Avoid
  red-green pairings; the brand palette's slate/orange/teal set is already separated.
- Grey is not wasted: use grey for the baseline or the non-selected series and reserve the
  accent colour for the finding.

## Step 4 — Annotate the finding

A results figure has a message; state it **on** the figure so the reader gets it in two
seconds:

- mark the optimum / the chosen configuration;
- shade the band where the conclusion holds (`sensitivity_curves.py` does this);
- label the baseline and draw it as a reference line;
- call out the anomaly ("缺口 = 缺失", "第 3 折异常").

Then the caption carries the interpretation, not a repeat of the axis labels.

## Step 5 — Multi-panel layout

For more than one result, prefer panels over one cluttered chart:

- Share axes where the quantities are comparable (`sharex`/`sharey`) so panels can be read
  against each other.
- Label panels **A / B / C** and refer to them as "图 3A" in the text.
- Keep the same colour meaning across all panels — if blue is model A on the left panel, it
  is model A on the right.
- Put the more important panel top-left; that is where the eye lands first.
- Do not use a grid of 9 panels when 2 carry the message.

## Step 6 — Caption and export

Caption format, in order: **number — title. what is plotted. what the reader should
conclude.**

```markdown
图 4  不同设备工时下的利润与碳排放权衡
左图给出 Pareto 前沿（100 组非支配解），右图为推荐方案（★）与两个单目标最优解（●）的对比。
可见利润提高 12% 需要多排放 31% 的 CO₂，推荐方案位于前沿的膝点附近。
```

Export rules (from `math-figure`):

- vector PDF/SVG for the paper, PNG at ≥300 dpi for previews;
- embed fonts so Chinese labels render on a machine without your fonts;
- one figure per file, named after its purpose (`fig_pareto_front.pdf`), not `fig1.pdf`;
- every figure must be referenced in the text — an unreferenced figure should be deleted.

## Rules

- Never truncate a bar chart's baseline.
- Never use a rainbow colour map for a continuous quantity.
- Never show means without spread when the spread matters.
- Never put two different y-scales on one panel.
- Never let colour be the only distinction between groups.
- Never write a caption that only restates the axis labels; it must state the conclusion.
- Never include a figure that the text does not discuss.
