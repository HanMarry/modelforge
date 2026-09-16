---
name: abstract-and-conclusion
description: 撰写建模论文的摘要、结论与评价章节。当需要写摘要、写结论、写模型评价与推广，或用户说"摘要怎么写""帮我润色摘要""结论太空"时使用。含摘要五步结构（必须带数字）、结论量化对照表、优缺点各 2–3 条且带改法、推广要具体到改哪里，以及投稿前七项自查。
---

# Abstract, Conclusion and Evaluation

Use this skill for the sections written **after** the results are final: 摘要, 模型评价与推广,
and the closing of each sub-question. These carry disproportionate weight — the abstract is
read before anything else and often decides the score.

## Step 1 — Write the abstract last, and structure it

Five moves, in this order, in **one** paragraph per sub-question at most:

1. **What the problem is** (one sentence, in your own words — not a copy of the prompt).
2. **What you built** (the model class per sub-question, named).
3. **How you solved it** (the method/algorithm, named).
4. **What you found** (the headline numbers, with units).
5. **Why it is sound** (validation, and any distinctive feature).

```markdown
本文针对 <问题> 建立了 <模型一>（问题一）、<模型二>（问题二）与 <模型三>（问题三）。

针对问题一，建立了 <模型>，采用 <方法> 求解，得到 <结论：数值+单位>。
针对问题二，应用了 <算法>，发现 <结论>。
针对问题三，提出了 <方法>，在 <扰动范围> 内结论保持成立。

模型经 <检验手段> 验证，<关键指标> 为 <数值>，相对 <基线> 提升 <比例>。
```

Rules for the abstract:

- **Every claim must be backed by a section.** If the abstract says "robust", the
  sensitivity section must show it.
- **Include numbers.** "取得了较好的效果" is not a result; "<指标> = 0.93，优于基线 0.87" is.
- **No citations, no figure references, no undefined symbols** in the abstract.
- Respect the contest word limit. Write to the limit, do not pad to it.
- Write it into the template's `\begin{abstract}` block, then re-read it against the final
  numbers — abstracts that still quote a superseded number are common and costly.

## Step 2 — Make each conclusion quantified

For each sub-question, the closing paragraph should answer the question **in its own
terms**, with numbers:

| Weak | Strong |
|---|---|
| "问题一得到了最优方案" | "问题一的最优产量为甲 480 件、乙 320 件、丙 700 件，对应利润 42 360 元，设备工时利用率为 96%" |
| "模型精度较高" | "验证集 RMSE = 0.284（约为均值的 6%），优于朴素基线的 0.412" |
| "该方案是稳健的" | "在设备工时 ±10% 扰动下，推荐方案的排名在 500 次扰动中保持第一的比例为 94%" |

If a number came from a run, cite the table or figure it appears in so the reader can find
the full result.

## Step 3 — Write the evaluation honestly

**Strengths** — 2 to 3, each specific to your model rather than generic praise:

- tie it to evidence: "模型对缺失数据不敏感（问题三的第二种处理方式下排名不变）";
- name what the model does that a simpler alternative would not.

**Weaknesses** — 2 to 3, each with a direction for fixing it:

- "假设了反应速率恒定，未考虑温度依赖；若数据允许，可引入 Arrhenius 形式并重新辨识参数";
- "样本量仅 42 条，随机森林的袋外误差估计不稳定，后续应补充数据或改用交叉验证".

A paper with no stated weaknesses reads as either dishonest or unaware. Reviewers reward
specific, well-argued limitations.

## Step 4 — Make the extension concrete

"模型的推广" should name a different situation the model could handle and **what would have
to change**:

> 本文的选址模型只处理单期决策。推广到多期时，需要把容量变量改为按年份索引，
> 并引入投资预算的跨期约束；目标函数中的运营成本需贴现。

A vague "可推广到其他领域" adds nothing.

## Step 5 — Check the paper holds together

Run this before submitting:

| Check | How |
|---|---|
| Abstract numbers match the final results | compare each number with `results/` |
| Every sub-question is answered in order | read section headings against the prompt |
| Every figure and table is referenced | search each "图 N" / "表 N" in the text |
| No number appears in the text but not in a table/figure | scan for numerals |
| Symbol table covers every symbol used | per `assumptions-and-notation` |
| Strengths/weaknesses are specific, not generic | read them as a sceptical reviewer |
| Word limit respected (including the abstract) | count it |

Then have it reviewed with `math-review`, which scores the eight rubric dimensions and
lists the fixes that would gain the most points.

## Rules

- Never write the abstract before the results are final.
- Never put an unquantified claim ("good", "robust", "accurate") in the abstract or
  conclusion.
- Never claim an advantage the paper does not demonstrate.
- Never omit weaknesses; and never write a weakness without a direction for fixing it.
- Never let the abstract describe a model the paper does not actually build.
- Never copy the problem statement into 问题重述 verbatim — restate it in your own words.
