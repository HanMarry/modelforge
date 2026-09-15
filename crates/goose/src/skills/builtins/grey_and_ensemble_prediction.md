---
name: grey-and-ensemble-prediction
description: 小样本与分解式预测方法。当数据点很少（4–15 个），或用户提到"灰色预测""GM(1,1)""指数平滑""组合预测"时使用。含 GM(1,1) 级比检验（前置条件）、残差比 C 与小误差概率 P 双检验、指数平滑参数选择与组合预测权重。
---

# Small-Sample and Decomposition Forecasting

Use this skill when there is **too little data** for ARIMA or machine learning, or when
the expected solution is a grey / ensemble model. The deliverable is a forecast with its
structural preconditions tested — these methods are invalid on data that does not satisfy
them, and that test is the part most papers skip.

## Requirements

```bash
uv pip install numpy pandas matplotlib
uv pip install statsmodels     # exponential smoothing
```

## Step 1 — Establish that a small-sample method is the right call

| Observations | Reasonable approach |
|---|---|
| 4–15 | grey GM(1,1), exponential smoothing, fit a simple trend |
| 15–40 | ARIMA / Holt–Winters (see `time-series`) |
| 40+ | the full `time-series` toolkit, plus ML with lag features |

Machine learning on 10 points is not a model, it is a curve fit. Say why the dataset size
forces the method, and prefer a method you can defend over one that fits.

## Step 2 — GM(1,1): test the preconditions first

GM(1,1) is only valid if the raw sequence satisfies the **class-ratio test**. With
$x^{(0)} = (x^{(0)}_1, \dots, x^{(0)}_n)$ and

$$\sigma_i = \frac{x^{(0)}_{i-1}}{x^{(0)}_i},$$

every $\sigma_i$ must fall in the admissible interval
$\left(e^{-2/(n+1)},\ e^{2/(n+1)}\right)$. **Check this and report it.** If it fails, the
standard remedy is a translation or a square-root transform of the series — apply it and
report that you did.

Then:

1. Accumulate: $x^{(1)}_k = \sum_{i \le k} x^{(0)}_i$ (this is what makes GM(1,1) work on
   short, roughly exponential series).
2. Build the mean sequence $z^{(1)}_k = 0.5(x^{(1)}_k + x^{(1)}_{k-1})$.
3. Least-squares estimate of $(a, b)$ from $x^{(0)}_k + a z^{(1)}_k = b$.
4. Solve $\hat{x}^{(1)}_{k+1} = (x^{(0)}_1 - b/a)e^{-ak} + b/a$.
5. Reduce back: $\hat{x}^{(0)}_{k+1} = \hat{x}^{(1)}_{k+1} - \hat{x}^{(1)}_k$.

## Step 3 — Validate with the two error tests, not just eyeballing

- **Residual ratio test**: $C = s_2/s_1$, the ratio of the residual standard deviation to
  the raw series standard deviation. $C < 0.35$ excellent, $< 0.5$ qualified,
  $< 0.65$ marginal; above that the model should not be used.
- **Small-error probability**: $P = P(|e_k - \bar{e}| < 0.6745\,s_1)$. $P > 0.95$
  excellent, $> 0.8$ qualified.

Report both $C$ and $P$, plus MAPE on a held-out tail where the length allows. Fitting a
GM(1,1), finding a small residual and stopping is not validation — the class-ratio
precondition and these two tests are the validation.

## Step 4 — Exponential smoothing: choose the right variant

| Data pattern | Method |
|---|---|
| no trend, no seasonality | simple exponential smoothing |
| trend, no seasonality | Holt's linear |
| trend and seasonality | Holt–Winters (additive or multiplicative) |

Fit the smoothing parameters by minimising one-step-ahead SSE (`statsmodels`
`ExponentialSmoothing` with `optimized=True`). Report the fitted $\alpha, \beta, \gamma$
— they are interpretable and reviewers ask for them. For short series, prefer damped
trend: undamped Holt extrapolates a trend forever, which is rarely defensible.

## Step 5 — Ensembles: combine, then check the combination helps

Averaging several forecasts usually beats any single one on short series:

- combine **different method families** (grey + Holt + a simple regression), not five
  variations of the same idea;
- use **inverse-error weighting** only when the errors are estimated on enough points to
  be stable; on 10 observations the weights are mostly noise, so equal weights are
  usually the honest choice;
- report the ensemble's error **and** each component's error, so the reader can see the
  combination earned its keep. If it did not, report the best single method instead.

## Step 6 — Report the forecast honestly

- Give the point forecast **and an interval**. For GM(1,1) a residual-based interval is
  acceptable; say how it was constructed.
- State the **valid horizon**. Grey models degrade quickly; two to three steps ahead is
  often the honest limit even though the formula will happily extrapolate further.
- Plot the fitted values over the observed series with the forecast beyond the boundary,
  so the reader sees where evidence ends.
- Report MAPE alongside the grey tests, and prefer the metric the problem's evaluation
  would use.

## Rules

- Never apply GM(1,1) without reporting the class-ratio test result.
- Never report GM(1,1) without $C$ and $P$ (or an explicit note that the sample was too
  short to compute them reliably).
- Never compare small-sample methods without stating the number of observations used for
  fitting and for testing.
- Never extrapolate far beyond the observed range and present it as a forecast rather
  than a scenario.
- Never use a grey model on a series with strong seasonality — the accumulated series
  assumes a monotone-ish trend.
- Report the fitted smoothing parameters whenever exponential smoothing is used.
