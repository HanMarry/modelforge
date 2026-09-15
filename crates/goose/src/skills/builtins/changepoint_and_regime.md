---
name: changepoint-and-regime
description: 检测并建模序列中的结构变化：水平跳变、趋势转折、方差变化与状态切换。当用户说"变点""突变点""分段""状态转换""哪一年开始变化"时使用。含 CUSUM 与 PELT/BinSeg（惩罚项必须显式）、马尔可夫切换、变点日期的不确定性区间与安慰剂/bootstrap 验证。
---

# Changepoint and Regime Detection

Use this skill when a series seems to behave differently before and after some point, or
when the task is explicitly to date a change (policy effect, fault onset, market regime).
The deliverable is a change point with a **confidence statement** and a check that it is not
an artefact of noise or of your own model.

## Requirements

```bash
uv pip install numpy pandas scipy matplotlib
uv pip install ruptures          # changepoint detection (PELT, BinSeg, PELT with costs)
uv pip install statsmodels       # Markov switching models
```

## Step 1 — Decide what kind of change you are looking for

| Change | Signature | Method |
|---|---|---|
| Level shift | mean jumps, variance roughly constant | CUSUM, binary segmentation, PELT (mean cost) |
| Trend change | slope changes, level continuous | piecewise regression, PELT (linear cost) |
| Variance change | spread changes, mean constant | PELT (variance cost) |
| Regime switching | alternates between states, can switch back | Markov-switching model |
| Gradual change | no single date, a slow drift | fit a trend; changepoint methods force a date that does not exist |

Write down which one the problem implies. Applying a level-shift detector to a gradual trend
produces a confident-looking date that means nothing.

## Step 2 — Look at the series before running a detector

- Plot it. A human eye is a good changepoint detector and it tells you how many changes are
  plausible.
- Distinguish **one** change from **many**. A single shift needs a different tool than
  segmentation into k segments.
- Note the **noise level** relative to the candidate change. A shift of half a standard
  deviation is not detectable no matter how clever the algorithm.

## Step 3 — Detect, with the penalty made explicit

Most methods trade fit against the number of changes through a penalty. That penalty is a
**decision**, so report it.

**Binary segmentation** (fast, greedy, good for a few changes):

```python
import ruptures as rpt
algo = rpt.Binseg(model="l2").fit(signal)
breaks = algo.predict(n_bkps=1)          # 1 = number of changes
```

**PELT** (exact for the given penalty, good for many changes):

```python
algo = rpt.Pelt(model="l2").fit(signal)
breaks = algo.predict(pen=3 * np.log(len(signal)))   # BIC-style penalty
```

- `n_bkps` asks for a fixed number — then **justify the number** (domain knowledge, or a plot).
- A penalty asks the data how many — then report the penalty and check the sensitivity of the
  count to it (halve and double it; does the number change?).
- **Either way, do both and compare.** If the count is unstable under the penalty, the
  evidence is weak and you should say so.

**CUSUM** is the classical single-change test and gives a test statistic and a critical value:

```python
from statsmodels.stats.diagnostic import breaks_cusumolsresid
```

It is a hypothesis test, so report the statistic and the p-value, not just "a change was
found".

## Step 4 — Model the regimes properly

Detection finds dates; modelling explains them:

- **Piecewise regression**: fit a separate slope/intercept per segment. Report all
  coefficients, and check that the segments are long enough to estimate them (fewer than
  ~10 points per segment and the slope is noise).
- **Markov-switching**: for a series that alternates between regimes. Report the transition
  probabilities, the state means/variances, and the smoothed probability of being in each
  state over time. The probability plot is the informative output — a hard label hides the
  uncertainty in the dating.
- **Intervention analysis**: if the change has a known cause and date (a policy, a repair),
  fit before/after explicitly rather than detecting the date.

## Step 5 — Validate the change is real

This is the step that separates a finding from an artefact.

1. **Placebo test**: run the same detector on the pre-change segment alone. If it finds a
   "change" there too, the method is finding noise at that rate.
2. **Bootstrap the date**: resample residuals, re-detect, and report the distribution of the
   estimated change point. A date with a ±1 point interval is strong; one spanning half the
   series is not a date.
3. **Test against a no-change model**: compare AIC/BIC of the segmented model against a
   single-regime model. Report both; if the improvement is negligible, there is no evidence.
4. **Check the boundary**: exclude a few points either side and re-detect, in case one outlier
   is driving the result.
5. **Seasonality**: deseasonalise first. A seasonal cycle plus a short series produces
   spurious level shifts at the same phase every year.

Report the confidence interval on the date, not just the point estimate.

## Step 6 — Report so the date can be used

```markdown
| 项 | 值 |
|---|---|
| 方法 | PELT（l2 成本） |
| 惩罚 | 3·ln(n) = 17.3 |
| 检出变点 | 第 42 期（95% bootstrap 区间 40–45） |
| 变点前后均值 | 812.4 → 968.1（+19.2%） |
| 与无变点模型比较 | ΔBIC = −58.3（支持存在变点） |
| 安慰剂检验 | 变点前子段未检出变点 |
```

Then state the interpretation in the problem's terms: what event does the date correspond
to, and what changed (level, trend, or variance).

## Rules

- Never report a change-point date without an uncertainty interval.
- Never report "a change was detected" without the penalty or the number of changes and why
  that number was chosen.
- Never run a detector on a seasonal series without deseasonalising first.
- Never interpret a detected date as causal without an external reason for that date.
- Never force a single changepoint onto a gradual trend.
- Always run a placebo/negative control; a detector that fires on stationary noise is useless.
- If the penalty sensitivity changes the number of changes, report the range rather than
  picking the one you prefer.
