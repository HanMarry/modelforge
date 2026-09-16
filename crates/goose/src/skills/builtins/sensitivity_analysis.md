---
name: sensitivity-analysis
description: 检验结论对输入的稳健程度。当需要做灵敏度分析、稳健性检验，或用户说"参数变化影响""结论可靠吗"时使用。含局部弹性、单参数扫描、容差区间、Sobol/Morris 全局灵敏度、蒙特卡洛传播与基线对比。
---

# Sensitivity Analysis and Model Validation

Use this skill to validate a model, fill the paper's 模型检验 section, or answer "how
confident are you in this number". The deliverable is a statement of the input range
over which the conclusion holds — not just a table of perturbed outputs.

## Requirements

```bash
uv pip install numpy scipy matplotlib
uv pip install SALib        # only for Sobol / Morris global sensitivity
```

## Step 1 — Define the inputs and the conclusion

Write down explicitly:

- which parameters are being varied, with their plausible ranges and units;
- which single output is being judged (the objective value, the optimal choice, the
  forecast, a ranking);
- the tolerance that counts as "the conclusion did not change".

Without a stated tolerance, sensitivity analysis degenerates into a table of numbers
nobody can act on.

## Step 2 — Local sensitivity (do this first, it is cheap)

Vary one parameter at a time by ±5 %, ±10 %, ±20 % and record the output change.
Normalise to **elasticity** so parameters with different units are comparable:

$$E_j = \frac{\partial y / y}{\partial x_j / x_j} \approx \frac{\Delta y / y}{\Delta x_j / x_j}.$$

Rank parameters by $|E_j|$. The largest one is the answer to "what do we need to measure
most precisely", which is often the most valuable sentence in the section.

Also record the **standardised regression coefficient** (or a simple linear fit of
output against each input) when the response is close to linear — it is easier to
defend than a pile of one-off perturbation runs.

## Step 3 — Identify the safe range

For each parameter, find where the output leaves the tolerance band and report the
**interval**, e.g. "the conclusion holds for reaction rate $k \in [0.94, 1.05]\times
k_0$". Then take the intersection across all parameters: this is the range in which
*all* inputs may move together without changing the conclusion.

Use the bundled template `math-figure` →
`assets/templates/model-evaluation/sensitivity_curves.py` for this figure; it draws the
curves, the tolerance band and the safe interval.

## Step 4 — Global sensitivity (when parameters interact)

One-at-a-time analysis misses interactions. If two parameters plausibly interact, run:

- **Morris screening** — cheap, ranks parameters by elementary effects.
- **Sobol indices** — `S1` (first-order) and `ST` (total, includes interactions). A
  large gap between `ST` and `S1` is direct evidence of interaction, which is worth
  stating in the paper.

Use SALib:

```python
from SALib.analyze import sobol
from SALib.sample import saltelli
problem = {"num_vars": k, "names": names, "bounds": bounds}
samples = saltelli.sample(problem, 1024)
results = run_model(samples)          # your model, vectorised
print(sobol.analyze(problem, results))
```

Report `S1` and `ST` with confidence intervals. Global methods need hundreds to
thousands of model runs — if one run is expensive, say so and fall back to Morris.

## Step 5 — Propagate uncertainty (Monte Carlo)

When the inputs have distributions rather than ranges:

1. Assign a distribution and justify it (measurement error → normal; bounded physical
   quantity → uniform or triangular).
2. Sample $N \ge 1000$ times, run the model, collect the output distribution.
3. Report the output **mean, standard deviation, and a 95 % interval** — not just the
   mean.
4. Report the fraction of runs that violate a constraint, if the problem has one.

Fix the random seed. Report $N$. Plot the output histogram; a bimodal output
distribution usually means the model has two regimes and is a finding worth reporting.

## Step 6 — Compare against a baseline

Sensitivity alone does not show the model is any good. Also report:

- a **naive baseline** (mean predictor, previous value, no-optimisation plan) and the
  improvement over it;
- **error metrics** appropriate to the task (RMSE/MAE for regression, accuracy/AUC for
  classification, optimality gap for optimisation);
- **residual diagnostics** for any fitted model — random, homoscedastic residuals or an
  explanation of why not.

## Rules

- Never present a sensitivity table without the tolerance that defines "unchanged".
- Never conclude robustness from perturbing only the parameters you chose; state which
  were held fixed.
- Never claim a model is validated because the fit is good — fit quality and robustness
  are different claims.
- Report the safe range as an interval, and name the parameter that limits it.
- If the conclusion flips under a plausible perturbation, report that prominently. A
  negative robustness result is a result.
