---
name: assumptions-and-notation
description: 撰写模型假设、符号说明与模型陈述，让评审能跟着推导走。当需要写假设、列符号表、把题干逐句形式化，或用户说"假设怎么写""符号表""变量定义"时使用。含假设三要素（是什么/为什么/错了会怎样）、given/assumed/derived 的区分、量纲检查与符号表清单式自查。
---

# Assumptions, Notation and Model Statement

Use this skill for the part of a paper that decides whether the rest is checkable: the
assumptions, the symbol table, and the formal model statement. Most papers lose marks here
without realising it.

## Step 1 — Turn every sentence of the problem into a formal statement

Go through the problem statement line by line and produce one of:

| Problem sentence | Becomes |
|---|---|
| "the factory can run at most 2400 machine-hours" | a **constraint** with the unit |
| "maximise profit while cutting emissions" | an **objective** (and note the conflict) |
| "data was collected hourly" | a **parameter** or a stated granularity assumption |
| "assume the reaction is first-order" | an **assumption**, with a justification |
| "the market absorbs at most 900 units" | a **bound** on a decision variable |
| anything not stated | an **assumption** you are making, marked as such |

Keep a checklist while doing this. A sub-question that produced no constraint and no
objective has not been modelled yet.

## Step 2 — Write assumptions so they can be challenged

Three parts per assumption:

1. **What** is being assumed.
2. **Why** it is reasonable here (cite the problem, a reference, or a physical argument).
3. **What breaks** if it is wrong.

```markdown
**假设 3**：忽略生产过程中的停机检修时间。
*理由*：题目给出的设备可用工时已扣除计划检修；附件《设备台账》中无计划外停机记录。
*影响*：若实际存在计划外停机，设备工时约束将偏松，最优产量被高估；
该影响在问题三的灵敏度分析中以设备工时 ±10% 扰动覆盖。
```

An assumption with no "what breaks" clause cannot be checked, and reviewers notice.
Distinguish **simplifying** assumptions (ignore second-order effects) from **modelling**
assumptions (the form of a rate law or distribution).

## Step 3 — Separate assumed, given and derived quantities

Tag every quantity in the notation table:

| Symbol | Meaning | Unit | Status | Value / source |
|---|---|---|---|---|
| $c_j$ | unit profit of product $j$ | 元/件 | given | 附件 products.csv |
| $a_{ij}$ | machine hours of product $j$ on resource $i$ | h/件 | given | 附件 products.csv |
| $\theta$ | reaction rate constant | 1/s | **assumed** | 假设 2 |
| $x_j$ | production quantity of product $j$ | 件 | **decision variable** | — |
| $\hat{x}_j$ | fitted estimate reported in Table 2 | 件 | **derived** | results/q2_summary.json |

This table is what makes a reviewer trust the numbers: every symbol has a unit and a
provenance. It also catches the common error of presenting an assumed value as if it were
measured.

## Step 4 — Check units dimensionally

Before writing the derivation, verify each equation is dimensionally consistent:

- objective: same units on both sides;
- constraints: same units across the sum;
- rate laws: match the units of the state variable's derivative.

Do this by hand once, then keep units in the notation table so a reader can do it too.
Dimensional errors are cheap to catch now and impossible to explain later.

## Step 5 — State the model formally, in one place

Write the complete model once, before the solution section:

$$\begin{aligned}
\min_{x} \quad & f(x) = \sum_j c_j x_j \\
\text{s.t.} \quad & \sum_j a_{ij} x_j \le b_i, && \forall i \quad \text{(资源约束)} \\
& x_j^{\min} \le x_j \le x_j^{\max}, && \forall j \quad \text{(需求上下限)} \\
& x_j \ge 0
\end{aligned}$$

Label every constraint with what it came from (Step 1). Then:

- **Make the code match the equations**, same symbol names where reasonable. If the paper
  says $a_{ij}$ and the code says `consumption[i][j]`, add a comment mapping them — do not
  leave the reader to guess.
- Never introduce a new symbol in the solution section that was not in the table.
- If the model changes while solving, update the statement and say why.

## Step 6 — Keep notation consistent

- One symbol, one meaning. Never reuse $\alpha$ for two things in different sections.
- Subscript consistently: $i$ for resources, $j$ for products, $t$ for time — and keep it
  that way across every section and figure.
- Define a symbol at first use, then never re-define it.
- Vectors and matrices styled consistently (bold, or not — but consistently).
- After finishing, run the checklist below.

## Final checklist

| Check | How |
|---|---|
| Every symbol in the text appears in the table | search the symbol, look it up |
| Every symbol in the table is used in the text | reverse search |
| Every symbol has a unit (or is explicitly dimensionless) | read the table |
| Every assumption has a justification and an impact clause | read section 模型假设 |
| Every constraint traces to a problem sentence or a marked assumption | read step 1 list |
| The formal model in the paper matches the code | diff the symbol names |
| No symbol is redefined with a new meaning | scan the symbol list for duplicates |

## Rules

- Never present an assumed value as measured data.
- Never state an assumption without saying what it affects.
- Never introduce an undefined symbol in a derivation.
- Never leave a unitless quantity in a table where units matter.
- Never let the paper's notation diverge from the code's; a reader who wants to verify must
  be able to map one to the other.
- If two notations are conventional for the same quantity, pick one and note the
  alternative once.
