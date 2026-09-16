---
name: outlier-and-anomaly-detection
description: 识别并处置离群点与异常。当数据含明显异常值，或"异常本身就是问题"时使用。含先分清清洗/建模/检测三种框定（把该找的异常当错误删掉是最常见的致命混淆）、硬约束优先于统计规则、MAD 修正 z（普通 z 会被离群点自身污染）、马氏距离/孤立森林/LOF、时序需先去趋势季节、逐点记录处置与处置前后结论对比。
---

# Outlier and Anomaly Detection

Use this skill when extreme values matter: either they are errors to clean, or they **are
the question** (fault detection, fraud, abnormal events). Getting the framing right is the
whole job — the same value can be an error, a rare real event, or the entire point.

## Requirements

```bash
uv pip install numpy pandas scipy scikit-learn matplotlib
```

## Step 1 — Decide which question you are answering

| Situation | Framing | What to do |
|---|---|---|
| Data is noisy, a few bad readings | **cleaning** | detect, then remove / correct / winsorise, and report counts |
| Tail behaviour matters (risk, extremes) | **modelling** | keep the extremes; use a heavy-tailed distribution |
| Task is to flag abnormal events | **detection** | this is the output; evaluate like a classifier |
| Suspected data-entry error | **validation** | check against physical limits first |

Write down which framing applies before touching the data. Removing outliers when the task
is to find them is the most common and most damaging confusion in these problems.

## Step 2 — Check hard constraints before statistics

Some "outliers" are simply impossible values, and no statistical rule is needed:

- negative values for a necessarily positive quantity;
- percentages outside 0–100;
- dates outside the study period;
- values that violate a physical or accounting identity (mass balance, sum of parts ≠ total);
- duplicate records with contradictory values for the same key.

Report these separately from statistical outliers. "3 negative flow readings removed" is
much more convincing than "3 outliers removed by the 1.5 IQR rule".

## Step 3 — Univariate detection, with the rule stated

| Rule | Detect when | Notes |
|---|---|---|
| IQR: $[Q_1 - 1.5\,IQR,\ Q_3 + 1.5\,IQR]$ | outside the fence | standard; 1.5 for outliers, 3.0 for extremes |
| z-score: $\lvert z\rvert > 3$ | far from the mean | **the mean and sd are themselves distorted by the outlier** |
| modified z: $0.6745\,(x - \text{median})/\text{MAD} > 3.5$ | far from the median | robust; prefer this when outliers are suspected |
| percentile trim | outside the 1st/99th | arbitrary; state the percentile |

The z-score's circularity matters: one huge value inflates the standard deviation and hides
itself. Use the **modified z-score (MAD-based)** or the IQR rule when you suspect outliers,
and say which you used.

Report: how many points per variable, what fraction, and the fence values.

## Step 4 — Multivariate detection when variables move together

A point can be normal in every variable but abnormal **in combination** (temperature 90 °C
is fine; temperature 90 °C *with* pressure 3 bar may not be). Univariate rules miss this.

- **Mahalanobis distance**: distance accounting for covariance. Needs ≥ ~10 observations per
  dimension, and the covariance itself must be estimated robustly (MCD) or the outliers
  inflate it.
- **Isolation forest**: tree-based, works in high dimensions, no distribution assumption.
- **Local Outlier Factor (LOF)**: flags points in low-density neighbourhoods; good for local
  anomalies.
- **DBSCAN as a detector**: points labelled noise (-1) are anomalies.

```python
from sklearn.ensemble import IsolationForest
flags = IsolationForest(contamination=0.02, random_state=20240912).fit_predict(X)
```

`contamination` sets the expected proportion — **it is a choice, not a detection**. If you
do not know the true rate, do not set it silently; report a ranked score and choose a
threshold on evidence.

**Scale first**: distance-based methods are scale-sensitive exactly as in clustering.
Standardise, or use a metric appropriate to the data.

## Step 5 — Time-series anomalies need a temporal baseline

What is abnormal depends on what was expected at that moment:

- **Residual-based**: fit the trend/seasonal model (`time-series`), then flag large
  residuals — this handles daily and weekly cycles correctly.
- **Level shift / changepoint**: the series changes regime; detect with a changepoint test
  rather than per-point rules.
- **Contextual anomaly**: a value normal globally but abnormal in context (high demand at
  3 a.m.).
- **Collective anomaly**: an unusual *sequence*, not a single point.

Never apply a global z-score to a seasonal series: it will flag every seasonal peak as an
anomaly. Detrend and deseasonalise first, and say so.

## Step 6 — Decide per outlier, and record the decision

For each detected point (or group), choose explicitly:

| Action | When |
|---|---|
| **correct** | the true value is recoverable (unit error, decimal shift) — state the correction |
| **remove** | confirmed error, and few enough to not bias the sample |
| **winsorise** | keep the observation but cap the influence |
| **keep** | it is a real extreme event relevant to the question |
| **model separately** | it is a different regime; fit it separately |

Report a table:

```markdown
| 变量 | 方法 | 检出数 | 处理 | 处理前后均值变化 |
|---|---|---|---|---|
| 温度 | 修正 z (MAD) | 4 | 保留（寒潮真实值） | — |
| 流速 | 物理约束 | 3 | 删除（负值） | +0.8% |
```

**Sensitivity is mandatory**: recompute the headline result with and without the
treatment. If the conclusion changes when outliers are handled differently, that is the
finding — report both.

## Step 7 — When detection is the task, evaluate it as one

If the goal is to find anomalies, you are doing classification with extreme imbalance:

- report **precision and recall** at an operating threshold, plus PR-AUC (not accuracy, not
  ROC-AUC — see `classification-modeling`);
- if labelled anomalies exist, use them for evaluation only, never for fitting the detector
  in an unsupervised framing;
- state the **false-alarm rate per unit time**, which is what an operator actually cares
  about.

## Rules

- Never remove points without reporting how many and why.
- Never use a plain z-score when outliers are suspected; the statistic is contaminated.
- Never apply univariate rules to a multivariate problem and call it complete.
- Never apply a global threshold to a seasonal series without detrending.
- Never let the detection method see the evaluation labels in an unsupervised framing.
- Never change a headline result silently after outlier treatment; report both versions.
- Never treat an outlier as an error by default — check the physical constraints first.
