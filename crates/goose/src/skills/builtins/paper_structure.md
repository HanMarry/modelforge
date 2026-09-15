---
name: paper-structure
description: 逐节写建模论文，把该拿的分拿到。当开始写论文正文，或用户说"论文怎么写""章节结构""问题重述"时使用。覆盖 问题重述/问题分析/模型建立与求解/模型检验/模型评价/附录 各节该写什么、常见失分点（照抄题干、正文贴代码、检验只有一张扰动表），以及问题分析里的方法比选表。
---

# Paper Structure and Section Writing

Use this skill when drafting a paper section by section. `math-paper` covers the outline
and the LaTeX templates; `abstract-and-conclusion` covers the abstract and evaluation;
this skill covers **what each middle section must contain and how it fails**.

## Step 1 — Know what each section is for

| Section | Its job | Common failure |
|---|---|---|
| 摘要 | sell the work with numbers | written first, no numbers, claims not in the body |
| 问题重述 | prove you understood the problem | copied the prompt verbatim |
| 问题分析 | show the path from problem to model | restates the prompt again, no decisions made |
| 模型假设与符号说明 | make the model checkable | assumptions with no justification, no units |
| 模型建立与求解 | the actual work | jumps to code, no derivation, parameters unexplained |
| 模型检验 | show it is trustworthy | one perturbation table, no baseline, no interval |
| 模型评价与推广 | honest assessment | generic praise, no weaknesses |

## Step 2 — 问题重述: restate, do not copy

Rewrite the problem in your own words and add what the statement implies:

- the **background** in two or three sentences;
- each **sub-question**, numbered exactly as the problem numbers them;
- the **data** you were given, with its structure (what each attachment holds);
- what the statement leaves **unspecified** — this becomes your assumptions later.

Never paste the prompt. A verbatim copy signals you had nothing to add, and it is the
fastest way to lose the 问题理解 marks.

## Step 3 — 问题分析: make decisions visible

This section is where you show the reasoning between the problem and the model. For each
sub-question:

1. What kind of question is it? (prediction / optimisation / evaluation / mechanism)
2. Which candidate approaches are available?
3. Which one you chose, and **why the others were rejected**.
4. What the chosen approach requires that you have (data, computing, assumptions).

A useful pattern is a short table:

| 子问题 | 问题类型 | 候选方法 | 选择 | 理由 |
|---|---|---|---|---|
| 一 | 评价排序 | AHP / 熵权 / TOPSIS | 熵权 + TOPSIS | 指标完整可客观赋权；AHP 主观性在无专家信息时不可靠 |

If this section could be deleted without the reader losing the reason for any modelling
choice, it is not doing its job.

## Step 4 — 模型建立与求解: derivation first, code second

Order within each sub-question:

1. **Model statement** — objective, variables, constraints, in the paper's notation
   (`assumptions-and-notation`).
2. **Derivation** — where the equations come from. State each step; do not jump from
   assumptions to a formula.
3. **Algorithm** — the solving procedure, with parameters and their values. A numbered
   procedure or pseudocode block is fine; a screenshot of code is not.
4. **Results** — the numbers, in a table, with the figure that shows them.

Include code only in the appendix, and even there only the core parts. The body states
what was computed and what came out; `code/` holds the how, referenced from the README.

## Step 5 — 模型检验: three different checks, not one

Many papers do only the first. Do all three:

1. **Sensitivity** — how the answer moves when inputs move, and the range over which the
   conclusion holds (`sensitivity-analysis`).
2. **Validity** — how well the model matches reality: error metrics on held-out data, or
   comparison with known results (`model-comparison`).
3. **Robustness** — whether conclusions survive reasonable changes in method or assumption
   (a second model, a different weighting, a different missing-data treatment).

Report all three with numbers. "进行了灵敏度分析，结果如表 X" is not a conclusion; say what
the analysis showed and whether the answer changed.

## Step 6 — 模型评价与推广: be specific

Per `abstract-and-conclusion`: strengths tied to evidence, weaknesses each with a fix, and
an extension that names what would have to change. Also state the model's **适用范围** —
the conditions under which it is valid, and where it should not be applied.

## Step 7 — Appendix: make it useful, not padded

Include:

- the support-material list (what file does what), as a table;
- core code, with clear headers per sub-question;
- extra results that support the body but would interrupt it (full parameter tables,
  extra sensitivity runs);
- the environment record from `code-and-reproducibility`.

Do not:

- dump every source file, including plotting scripts;
- include code that does not appear in the paper's results;
- let the appendix contain a result the body should have stated.

## Step 8 — Read it as a reviewer would

Before submitting, check:

| Check | Why |
|---|---|
| Each sub-question answered in order, in its own section | rubric maps to sub-questions |
| Every figure/table referenced in the text | unreferenced exhibits lose marks |
| No result appears only in the appendix | a result in the appendix is treated as padding |
| Each section's first sentence says what the section does | reviewers skim first sentences |
| No "如下图所示" without stating what the figure shows | the text must carry the finding |
| Consistent notation across sections | see `assumptions-and-notation` |
| Length within limit, no filler paragraph | padding is penalised, not rewarded |

Then run `math-review` for the scored rubric pass.

## Rules

- Never copy the problem statement into 问题重述.
- Never let 问题分析 become a second 问题重述; it must contain decisions.
- Never present code in the body where a derivation belongs.
- Never report 模型检验 as a table of perturbations with no stated conclusion.
- Never write generic strengths ("模型具有一定的实用价值") or omit weaknesses.
- Never reference a table or figure without saying what it shows.
- Every number must trace to `results/`; every symbol to the symbol table.
