---
name: count-and-ordinal-models
description: 建模计数、有序类别或比例型响应。当因变量是"次数""人数""等级""满意度 1–5""比例/比率"时使用。含 Poisson 的过度离散检验（Pearson χ²/dof）、负二项与零膨胀、率模型必须带 offset、系数报 IRR 及其 CI、有序 logit 的平行线假设与边际效应、beta 回归与二项 GLM。
---

# Count, Ordinal and Proportion Models

Use this skill when the response is **not** a continuous unbounded measurement: counts,
ordered ratings, unordered categories, or proportions. Fitting OLS to these is the standard
error in modelling papers — the predictions go negative, the residuals are wrong, and the
inference is invalid.

## Requirements

```bash
uv pip install numpy pandas statsmodels scipy matplotlib
```

`statsmodels` has all of these with proper inference; `scikit-learn` mostly does not.

## Step 1 — Identify the response type

| Response | Model family | Why not OLS |
|---|---|---|
| count of events (0, 1, 2, …) | Poisson | variance grows with the mean; OLS predicts fractions and negatives |
| count, over-dispersed (variance > mean) | negative binomial | Poisson underestimates standard errors |
| count with excess zeros | zero-inflated / hurdle | two processes: "any at all" and "how many" |
| ordered categories (1–5 scale, grade band) | ordered logit / probit | the spacing between categories is not equal |
| unordered categories | multinomial logit | no ordering to respect |
| proportion in [0,1] | beta regression, or logit transform | bounded; OLS can exceed the bounds |
| rate (events per exposure) | Poisson with an **offset** | the denominator must enter the model |

Ask: can the response be negative? Can it be fractional? Is there a natural ordering? Those
three questions select the family.

## Step 2 — Poisson: check for over-dispersion first

```python
import statsmodels.api as sm
poisson = sm.GLM(y, X, family=sm.families.Poisson()).fit()
# over-dispersion: Pearson chi2 / dof should be ~1
print(poisson.pearson_chi2 / poisson.df_resid)
```

- Ratio ≈ 1 → Poisson is fine.
- Ratio ≫ 1 → **over-dispersed**; use negative binomial (a GLM with
  `NegativeBinomial`) or quasi-Poisson. Reporting a Poisson fit with dispersion 5 and
  ignoring it invalidates every standard error.

**Offset for rates**: to model events per unit exposure, add `offset=np.log(exposure)`:

```python
model = sm.GLM(y, X, family=sm.families.Poisson(), offset=np.log(exposure)).fit()
```

Omitting the offset when observations have different exposures is a modelling error, not a
stylistic one.

## Step 3 — Interpret coefficients on the right scale

Poisson/negative binomial coefficients are on the **log** scale. Report:

- the coefficient (change in log mean per unit of the predictor);
- the **incidence rate ratio** $e^{\beta}$ — "a 1 °C increase multiplies the expected
  count by 1.08 (95 % CI 1.03–1.14)";
- the CI for the ratio, obtained by exponentiating the CI for $\beta$.

A bare "β = 0.077, p < 0.05" is uninterpretable to a reader; the rate ratio is what belongs
in the paper. Never exponentiate the standard error and call it a CI for the ratio.

## Step 4 — Ordered outcomes: respect the ordering

Ordered logit/probit models a latent continuous variable with cut points:

```python
from statsmodels.miscmodels.ordinal_model import OrderedModel
fit = OrderedModel(y, X, distr="logit").fit(method="bfgs")
print(fit.summary())
```

- Coefficients give the **direction** of the effect on the latent scale; they do not give
  the change in the probability of a specific category directly.
- Report **predicted probabilities per category** or the **marginal effect** at a
  representative point — that is what a reader can use.
- **Test the proportional-odds assumption** (the effect of each predictor is the same across
  cut points). If it fails, use a partial proportional odds or multinomial model and say so.
- Binary logit is the two-category special case; do not use OLS on a 1–5 rating.

## Step 5 — Unordered categories: multinomial

- Pick a **reference category** and say which; all coefficients are relative to it.
- Report **predicted probabilities**, not just coefficients, and compare against a baseline
  that always predicts the most frequent category (`classification-modeling`).
- With rare categories, coefficients can be enormous and unstable — report the category
  counts alongside.

## Step 6 — Proportions and rates in [0, 1]

- **Beta regression** for a continuous proportion (fraction of area, share of budget).
- **Logit transform** + OLS if the proportion is strictly inside (0, 1) and you report the
  back-transform; handle the boundary cases explicitly (they break the transform).
- **Binomial GLM** with weights when the proportion is a ratio of counts
  (`successes`, `trials`), which is usually the better choice — the variance then comes from
  the binomial rather than being assumed constant.

## Step 7 — Validate and report

- **Deviance / Pearson residuals** plotted against fitted values; look for the
  over-dispersion pattern and for systematic curvature.
- **Predictive check**: simulate counts from the fitted model and compare the distribution
  (especially the zeros and the tail) with the observed. A model that matches the mean but
  not the tail is not adequate.
- **Out-of-sample** error on the response's own scale (MAE on counts), against a baseline
  (predict the mean count) — see `model-comparison`.
- Report the **dispersion parameter**, the **family and link**, and the **offset** if used.

## Rules

- Never fit OLS to a count, an ordinal rating or a bounded proportion.
- Never report a Poisson fit with substantial over-dispersion without switching family or
  using robust standard errors, and saying so.
- Never omit the offset when observations have different exposures.
- Never report log-scale coefficients as if they were effects on the response.
- Never report exponentiated standard errors as confidence intervals for a rate ratio.
- Never claim an ordered model without noting whether the proportional-odds assumption held.
- Never present class/category probabilities without also presenting the counts behind them
  when categories are rare.
- Always name the family, the link and the offset in the model statement.
