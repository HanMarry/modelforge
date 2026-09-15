---
name: time-series
description: 分析与预测时间序列。当数据带时间索引，或用户说"预测未来""趋势""季节性""时序"时使用。含分解、ADF/KPSS 平稳性检验、ACF/PACF 定阶、ARIMA/SARIMA、VAR 与 Prophet、滚动回溯验证与朴素基线对比。
---

# Time Series Analysis and Forecasting

Use this skill whenever the data has a time index and the question asks what happens
next, whether a trend is real, or how two series interact. The deliverable is a forecast
**with a validated error** and an honest statement of how far ahead it holds.

## Requirements

```bash
uv pip install numpy pandas statsmodels matplotlib
uv pip install prophet        # only when you need holiday effects or many seasonalities
```

## Step 1 — Establish the time index before anything else

- Parse the time column explicitly; do not let it become a string.
- Confirm the sampling interval and whether it is **regular**. Irregular sampling
  breaks ARIMA assumptions — resample and say how you aggregated.
- Plot the raw series first. Look for: trend, seasonality, level shifts, gaps,
  outliers, and a changing variance.

State the frequency (hourly / daily / weekly / monthly) in the paper. Every later
choice depends on it.

## Step 2 — Decompose

```python
from statsmodels.tsa.seasonal import seasonal_decompose
result = seasonal_decompose(series, model="additive", period=12)
result.plot()
```

Use `model="multiplicative"` when the seasonal swing grows with the level. Report the
decomposition figure — it is what justifies the model class you pick next.

## Step 3 — Test for stationarity, then difference

- **ADF test** (`statsmodels.tsa.stattools.adfuller`): p < 0.05 ⇒ no unit root.
- **KPSS test**: the null is the opposite (stationary), so running both guards against
  a single test's blind spot.

If non-stationary, difference ($d$) and retest. Report the test statistic and p-value
before and after differencing; do not difference and simply assert it worked.

## Step 4 — Identify orders, then fit

Read ACF/PACF of the differenced series to pick starting $(p, q)$, then search
$p, q \le 3$ by AIC/BIC rather than trusting the plot alone.

```python
from statsmodels.tsa.arima.model import ARIMA
model = ARIMA(train, order=(p, d, q), seasonal_order=(P, D, Q, s)).fit()
print(model.summary())
```

For multiple interacting series use `statsmodels.tsa.api.VAR` and check the lag order
with `select_order`. For strong calendar seasonality, multiple seasonalities, or
holidays, `Prophet` is a reasonable alternative — but a plain SARIMA that you can
explain beats a Prophet you cannot.

**Residual diagnostics are mandatory**: plot residuals, check they look like white
noise, and run the Ljung–Box test. Autocorrelated residuals mean the model is
misspecified no matter how good the fit looks.

## Step 5 — Validate with rolling-origin backtesting

A single train/test split is not enough evidence for a time series. Walk the origin
forward:

```python
errors = []
for cutoff in range(len(train_min, len(series) - horizon, step)):
    fit = ARIMA(series[:cutoff], order=order).fit()
    forecast = fit.forecast(horizon)
    errors.append(series[cutoff:cutoff + horizon] - forecast)
```

Report **MAE, RMSE and MAPE** on the backtest, plus a baseline: the naive
"tomorrow = today" forecast and, for seasonal data, the seasonal naive. A model that
does not beat the naive baseline has not earned its complexity — say so if it does not.

## Step 6 — Report a forecast interval, not a point

Always give the confidence interval with the point forecast, and state the horizon
beyond which it widens too far to be actionable. Plot the backtest errors alongside the
forecast so the reader can see the accuracy for themselves.

## Rules

- Never report a forecast without its error metric and a baseline comparison.
- Never fit ARIMA to data with an unremoved trend and call it stationary.
- Never claim a seasonal pattern from a single cycle — you need at least two, ideally
  three, full periods.
- Keep the train/test boundary strictly in time order; never shuffle.
- Fix the random seed and record the library versions, since forecast results differ
  across `statsmodels` releases.
