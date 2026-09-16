---
name: regression-modeling
description: 端到端建立并验证回归模型。当问题是"影响因素""预测数值""相关性分析""建立回归方程"时使用。含区分解释与预测目标、VIF 与共线性、函数形式选择、假设诊断四件套（线性/独立/同方差/正态）、Cook 距离、稳健标准误、正则化的正确用法，系数表要带单位与置信区间。
---

# Regression Modelling

Use this skill when the outcome is continuous and you either need to predict it or
**explain** how the inputs drive it. The deliverable is a fitted model plus diagnostics
that show the assumptions hold — a regression without diagnostics is an assertion.

## Requirements

```bash
uv pip install numpy pandas statsmodels scikit-learn matplotlib
uv pip install patsy           # formula interface for statsmodels
```

Use `statsmodels` when you need inference (p-values, confidence intervals, diagnostics)
and `scikit-learn` when you need prediction and cross-validation plumbing. Mixing them
without thinking is how papers end up with p-values from a model that was never checked.

## Step 1 — Decide: explanation or prediction

| Goal | Priority | Report |
|---|---|---|
| Explain an effect | unbiased coefficients, correct standard errors | coefficient, CI, p-value, effect size |
| Predict | out-of-sample accuracy | cross-validated RMSE/MAE, residual behaviour |
| Both | a model that does both is rare | say which claim each number supports |

For explanation, a simpler model with interpretable coefficients beats a black box, even
at some accuracy cost. For prediction, regularisation and ensembles are fair game. Do not
report p-values from a heavily regularised or tree-based model as if they were inferential.

## Step 2 — Inspect the variables before fitting

- **Scatter each predictor against the target.** A nonlinear pattern means a linear term
  is the wrong functional form, and no amount of diagnostics will fix that.
- **Check the predictor distributions.** A variable spanning two orders of magnitude
  usually wants a log transform; a count variable may want a Poisson model.
- **Check for multicollinearity before interpreting coefficients**: compute VIF per
  predictor. VIF > 10 (some say 5) means the coefficients are unstable — drop, combine, or
  use regularisation, and say which you did.

```python
from statsmodels.stats.outliers_influence import variance_inflation_factor
vif = [variance_inflation_factor(X.values, i) for i in range(X.shape[1])]
```

High VIF does **not** hurt prediction; it destroys the interpretation. That distinction
belongs in the paper.

## Step 3 — Choose the functional form deliberately

- Try the plain linear fit first, then add the terms the physics or the scatter suggests:
  a squared term for a peak, an interaction for a joint effect, a log for diminishing
  returns.
- Justify each added term by the mechanism, not by "it improved R²". Adding terms always
  improves in-sample R².
- Use **adjusted R², AIC or BIC** to compare models with different numbers of terms.
- Report the final equation with coefficients and units, so a reader can compute a
  prediction by hand.

## Step 4 — Diagnose the assumptions

Fit, then check all of these and report each:

| Assumption | Check | If it fails |
|---|---|---|
| Linearity | residuals vs fitted, partial regression plots | add the missing term or transform |
| Independence | residual vs order/time; Durbin–Watson | time series → use lagged/AR errors |
| Homoscedasticity | residuals vs fitted; Breusch–Pagan | robust (HC) standard errors, or WLS |
| Normality of residuals | QQ plot, Shapiro–Wilk | matters for small n; bootstrap the CI |
| No influential outliers | Cook's distance, leverage | report the fit with and without them |

**Robust standard errors** (`cov_type="HC3"`) are the pragmatic answer to
heteroscedasticity: they keep the coefficients and fix the inference. Say that you used
them, since the p-values change.

## Step 5 — Handle regularisation correctly

- **Ridge** shrinks coefficients and handles collinearity; it does not select variables.
- **Lasso** selects variables; with correlated predictors it picks one arbitrarily.
- **Elastic net** is the compromise.
- **Standardise predictors first** — otherwise the penalty depends on units and the
  result is meaningless.
- **Tune the penalty by cross-validation** on the training set, never on the test set, and
  report the chosen value.
- Do not report p-values from a regularised fit. Coefficient paths or the selected set
  are the right output.

## Step 6 — Validate out of sample

- **Cross-validate** (k-fold, or time-series split for temporal data) and report mean ±
  standard deviation of RMSE and MAE across folds.
- **Compare against baselines**: the training mean, and a single-predictor model. A
  regression that does not beat the mean has no predictive content.
- **Report errors in the response's units**, and (if useful) as a percentage of the mean.
- **Check extrapolation**: state the range of each predictor in the data and never present
  a prediction outside it as if it were supported.

## Step 7 — Report coefficients so they can be used

```markdown
| 变量 | 系数 | 标准误 | 95% CI | p |
|---|---|---|---|---|
| 温度 (每 +1 °C) | 0.42 | 0.08 | [0.26, 0.58] | < 0.001 |
```

- Give the unit of the predictor in the row label — "per +1 °C" makes the coefficient
  interpretable.
- Report the CI, not just significance: it shows both size and precision.
- For a transformed predictor (log, standardised), state how to back-transform.
- Never write "temperature is significant" without the direction and magnitude.

## Rules

- Never present coefficients from a model whose assumptions you did not check.
- Never interpret coefficients when VIF indicates collinearity; report the problem first.
- Never compare in-sample fit across models with different numbers of terms.
- Never report p-values from a regularised or ensemble model.
- Never predict outside the observed range of the predictors without flagging it.
- Never report R² alone; pair it with an out-of-sample error in the response's units.
- If the relationship is not linear, say so instead of forcing a linear fit.
