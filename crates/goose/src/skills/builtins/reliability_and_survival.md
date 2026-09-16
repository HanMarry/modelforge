---
name: reliability-and-survival
description: 分析失效时间与寿命数据。当问题涉及"寿命""可靠性""故障率""维修周期""保修"时使用。含删失数据的框定（右删失是信息不是缺失）、Kaplan–Meier 基线、按风险函数形状选分布、Weibull 形状参数的含义（β>1 才是磨损期）、系统可靠度（串/并/k-out-of-n）与独立性假设、年龄更换策略与 B10 寿命。
---

# Reliability and Survival Analysis

Use this skill when the response is **a time until an event**: a component's lifetime, a
machine's time between failures, a patient's survival time, a customer's time to churn. The
data has features ordinary regression cannot handle — most importantly **censoring**. A unit
that has not failed yet is not missing data; it carries the information "survived at least
this long", and discarding it biases the answer downwards.

## Requirements

```bash
uv pip install numpy pandas scipy matplotlib
uv pip install lifelines        # Kaplan-Meier, Cox, parametric survival
uv pip install reliability      # system reliability from structure
```

## Step 1 — Identify the censoring structure before anything else

| Situation | Type | Consequence if ignored |
|---|---|---|
| All units observed to failure | no censoring | ordinary fitting works |
| Study ends with units still running | **right-censored** | dropping them underestimates the mean life |
| Failure only known to have happened between inspections | **interval-censored** | treating it as exact overstates precision |
| A unit failed before it was installed/observed | left-censored | rare in these problems, but state it |

Report the counts: how many exact failures, how many right-censored, and the total
observation time. **Fit to the censored data, never to the failures alone.**

## Step 2 — Start with the non-parametric estimate

Before assuming any distribution, compute the **Kaplan–Meier** survival curve and the
Nelson–Aalen cumulative hazard:

```python
from lifelines import KaplanMeierFitter
kmf = KaplanMeierFitter()
kmf.fit(durations, event_observed=events)   # events: 1 = failed, 0 = censored
kmf.plot_survival_function()
print(kmf.median_survival_time_)
```

- The KM curve needs no distributional assumption, so it is the honest baseline. Plot the
  parametric fit **on top of it**; if it deviates, the distribution is wrong.
- Report the **median lifetime with a confidence interval** — medians are robust and are what
  a reader wants, more than the mean.
- A **mean** from a heavy-tailed fit may not exist (Weibull with shape < 1); say so instead of
  quoting a divergent mean.
- Compare groups with a **log-rank test** rather than eyeballing two curves.

## Step 3 — Choose a distribution from the hazard's shape, not from habit

| Distribution | Hazard | Use when |
|---|---|---|
| Exponential | constant | random failures, no wear-out; memoryless |
| Weibull (shape β) | β<1 decreasing, β=1 constant, β>1 increasing | the default for component life; β>1 means wear-out |
| Lognormal | rises then falls | repair times, some fatigue lives |
| Gamma | flexible | cumulative damage processes |

Fit and compare with AIC, and check against the KM curve:

```python
from lifelines import WeibullFitter, ExponentialFitter, LogNormalFitter
for fitter in (WeibullFitter(), ExponentialFitter(), LogNormalFitter()):
    fitter.fit(durations, event_observed=events)
    print(fitter.__class__.__name__, fitter.AIC_, fitter.summary)
```

**The Weibull shape parameter is the result, not a nuisance:** β ≈ 1 means failures are
random (preventive replacement does not help), β > 1 means wear-out (replacement on a
schedule does help), β < 1 means infant mortality (burn-in is the right response). Report β
with its confidence interval and interpret it in those terms — that interpretation is usually
the actual answer to the problem.

Exponential is a special case (β = 1); test it rather than assuming it, since an exponential
assumption makes the "constant failure rate" claim that many conclusions depend on.

## Step 4 — System reliability from structure

For independent components, combine reliabilities rather than fitting the system as a whole:

| Structure | Reliability at time t |
|---|---|
| Series (all must work) | $R_s = \prod_i R_i(t)$ |
| Parallel (any one suffices) | $R_s = 1 - \prod_i (1 - R_i(t))$ |
| k-out-of-n (at least k of n) | binomial sum over the component reliabilities |
| Standby with a perfect switch | Poisson sum with the spare's failure rate |

- **Independence is an assumption.** Shared power, shared cooling and common-cause failures
  break it, and then a series system fails more often than the product predicts. State it and,
  if common-cause is plausible, add a β-factor term rather than ignoring it.
- Compute **MTTF** by integrating $R_s(t)$ from 0 to ∞ (or the mission time).
- Report the **weakest link's contribution**: which component dominates the system failure
  probability is the actionable output. Improving a component that contributes 2 % is wasted
  effort.

## Step 5 — From reliability to a maintenance decision

The practical question is usually "when to service or replace":

- **Age replacement**: choose the replacement age $t^*$ minimising cost per unit time,
  $C(t) = [c_f \cdot F(t) + c_p \cdot R(t)] / \int_0^t R(u)\,du$ — the numerator is the
  expected cost per cycle, the denominator the expected cycle length. Report $t^*$ and the
  cost saving versus running to failure.
- **Block replacement**: replace everything every $T$ regardless of age; only sensible when
  β > 1 and the logistics are cheaper that way.
- **Inspection interval**: for a system with a detectable defect state, choose the interval
  that trades inspection cost against the probability of failure before detection.
- If β ≈ 1, say plainly that **scheduled replacement gives no reliability benefit** — this is
  a valuable negative result that avoids recommending pointless maintenance.

## Step 6 — Report lifetime statistics correctly

- Give the **median and a percentile** (B10 life: the time by which 10 % have failed) with
  confidence intervals, not just a fitted mean.
- State the **shape and scale** parameters with units — the scale carries the time unit.
- Plot the fitted survival curve against the KM estimate, and the hazard function, since the
  hazard is what justifies the maintenance recommendation.
- State the **observation window** and whether predictions beyond it are extrapolation; life
  models extrapolate badly, so flag anything past the longest observation.
- Report the censoring counts in the caption of any lifetime figure.

## Rules

- Never drop censored observations; fit with the censoring indicator.
- Never report a mean lifetime without checking that the fitted distribution has a finite mean.
- Never assume exponential (constant hazard) without testing it; the conclusion usually
  depends on it.
- Never fit a distribution without comparing it to the Kaplan–Meier estimate.
- Never compute system reliability from component reliabilities without stating the
  independence assumption, and flag common-cause failures.
- Never recommend scheduled replacement when the fitted shape indicates a constant or
  decreasing hazard.
- Always report the shape parameter with its CI and interpret it in maintenance terms.
- Always flag predictions that extrapolate beyond the observation window.
