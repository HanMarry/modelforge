---
name: experimental-design
description: 设计实验或计算扫描，使效应真的可被估计。当需要安排试验、参数组合、正交表，或用户说"实验设计""正交试验""响应面"时使用。含因子与响应先行、全因子与部分因子的分辨率与混杂结构、随机化与区组、响应面法与确认实验。
---

# Experimental Design

Use this skill when **you choose the runs**. That changes the analysis: you can estimate
effects cleanly, but only if the design supports it. It applies to physical experiments and
equally to designed computational sweeps (parameter studies, calibration, simulation
experiments) — the same algebra governs both.

## Requirements

```bash
uv pip install numpy pandas statsmodels matplotlib
uv pip install pyDOE3              # factorial and response-surface designs
```

## Step 1 — State the factors, levels and response before designing

- **Factors**: each with a range and units, and why that range.
- **Levels**: two levels for screening, three or more for curvature.
- **Response**: the measured quantity, with units and its measurement error.
- **Noise**: what varies that you are not studying (ambient conditions, machine drift,
  random seeds).

A design cannot be chosen until the factors and the response are fixed. Write them in a table
before touching a generator.

## Step 2 — Full factorial when it is affordable

With $k$ factors at 2 levels, a full factorial is $2^k$ runs:

| k | Runs | Notes |
|---|---|---|
| 2 | 4 | trivial; gives the interaction |
| 3 | 8 | still cheap; all interactions |
| 4 | 16 | usually fine |
| 5 | 32 | getting expensive |
| 6+ | 64+ | use a fractional design |

The point of a factorial is **interactions**: the effect of A depends on the level of B. One
factor at a time (OFAT) cannot detect that, and OFAT is what most papers do. If you run OFAT,
say why (cost, safety) and state that interactions are not estimable.

## Step 3 — Fractional factorial to screen

When $2^k$ is too many, a **fractional factorial** estimates the main effects and low-order
interactions at the cost of aliasing:

```python
from pyDOE3 import fracfact
design = fracfact("a b c ab ac")   # 5 factors in 8 runs, resolution IV
```

- Report the **resolution**: III = main effects clear of each other but aliased with
  two-factor interactions; IV = main effects clear of two-factor interactions; V = two-factor
  interactions also clear.
- State the **aliasing structure** — which effects are confounded. A conclusion about a main
  effect at resolution III can actually be an interaction.
- Choose the fraction deliberately, not because 8 runs fit the schedule.

## Step 4 — Randomise and block

These two steps are cheap and they are what make the arithmetic valid:

- **Randomise the run order** (unless the order itself is a factor, e.g. a wear study). A
  monotone drift in the lab then becomes noise rather than a fake factor effect.
- **Block** known nuisance sources: different machines, days, batches, operators, or
  random-number streams. Put each block through all treatments if possible; if not, use a
  balanced incomplete block design.
- Never run all of level A on Monday and all of level B on Tuesday and then attribute the
  difference to A.

## Step 5 — Response surface methodology for optimisation

Once screening has identified the important factors, find the optimum with a response
surface design (three or more levels):

- **Central composite (CCD)** or **Box–Behnken**: fit a quadratic in the factors with an
  interaction term, then locate the stationary point.
- The quadratic model $\hat{y} = b_0 + \sum b_i x_i + \sum b_{ii}x_i^2 + \sum_{i<j} b_{ij}x_ix_j$
  is what lets you plot contours and find an optimum — a two-level design cannot fit curvature.
- **Check the fit**: R² alone is not enough; look at the residual plots and the lack-of-fit
  test. If the quadratic is inadequate, the "optimum" is an artefact of the model.
- **Confirm the predicted optimum with a run at that point.** A predicted optimum that was
  never run is a hypothesis; a confirmation run makes it a result.

## Step 6 — Analyse as a designed experiment, not a regression dump

```python
import statsmodels.formula.api as smf
model = smf.ols("y ~ a * b * c", data=df).fit()   # * expands to interactions
print(model.summary())
print(smf.ols("y ~ a * b * c", data=df).fit().anova_lm(typ=2))
```

- Report the **effect estimate per factor** (change in response per unit change in the factor),
  the standard error, and the confidence interval — not only p-values.
- **Pool the clearly negligible interactions** into the error term when the design has no
  replication, and say that you did.
- With no replication you cannot estimate pure error; state that limitation explicitly and
  note that the lack-of-fit test is unavailable.
- Report the **residuals**: a normal probability plot of effects or residuals is standard for
  screening designs and shows the few effects that matter.

## Step 7 — Report the design itself

```markdown
| 项 | 值 |
|---|---|
| 设计 | 2^(5-1) 部分因子，分辨率 IV |
| 因子 | 温度(60–80 °C)、浓度(0.5–1.5 M)、流速(1–3 L/min)、pH(6–8)、催化剂(0.1–0.5 %) |
| 运行数 | 16 + 3 中心点 |
| 区组 | 按两台设备各 8 次 |
| 结果 | 主效应：温度 +2.3 (SE 0.4)、浓度 +1.1 (SE 0.4)；其余不显著 |
```

Include the run order, the actual (not nominal) factor values achieved, and the response with
its measurement uncertainty. A design table is part of the result.

## Rules

- Never run one-factor-at-a-time and then claim to have studied interactions.
- Never confound a factor with run order, day, batch, or operator.
- Never report a fractional-factorial conclusion without stating the resolution and aliasing.
- Never fit a curvature model to a two-level design.
- Never present a predicted optimum that was never confirmed by a run.
- Never report effects without standard errors; an unreplicated design must say so.
- Always report the actual factor values achieved, not just the intended levels.
- Always distinguish experimental evidence from observational correlation in the discussion.
