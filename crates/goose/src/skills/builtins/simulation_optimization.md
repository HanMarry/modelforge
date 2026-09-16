---
name: simulation-optimization
description: 目标只能靠仿真评估时的优化。当优化目标没有解析式、需要跑仿真才能得到，或用户说"仿真优化""随机优化"时使用。含公共随机数（CRN）、离散事件仿真与优化的耦合、样本均值近似（SAA）的重复数一致性检查、排序与选择、代理模型，以及先算出可检测差异再判断改进是否真实。
---

# Simulation-Based Optimisation

Use this skill when the objective has **no closed form**: each evaluation means running a
simulation, a Monte Carlo estimate, or another expensive model. This breaks the assumptions
of ordinary optimisation — the objective is noisy, so a single comparison between two
candidates is unreliable. The deliverable is an optimiser that accounts for that noise.

## Requirements

```bash
uv pip install numpy scipy simpy matplotlib
uv pip install scikit-optimize      # optional: Bayesian optimisation on a surrogate
```

## Step 1 — Recognise the situation

You are in this regime when:

- the objective is an **expectation** over random inputs (mean wait, expected cost,
  probability of failure);
- evaluating a candidate means running a simulation (SimPy, an ODE solve, a cellular
  automaton, a queueing model);
- the evaluation is **noisy** — repeating the same candidate gives a different value;
- the evaluation is **slow** — hundreds, not millions, of evaluations are affordable.

If the objective is deterministic, use `optimization-modeling` instead. The whole
difficulty here comes from the noise.

## Step 2 — Reduce the noise before optimising

Do not optimise a noisy objective until you have made it as quiet as you can:

- **Common random numbers (CRN).** Use the *same* random streams for every candidate, so
  differences between candidates are not contaminated by different random draws. This is
  the single most effective variance reduction and it costs nothing.
- **Antithetic variates**: pair each draw with its mirror to cancel part of the noise.
- **More replications** per candidate: variance falls as $1/n$, so 4× the replications
  halves the standard error — but it also quadruples the cost, so spend it only where the
  comparison is close.
- **Analytic where possible**: replace the simulated sub-component with a closed form if
  one exists.

Report which variance-reduction technique you used. Without CRN, a search that "improves"
the objective may just be reading noise.

## Step 3 — Know the noise level before trusting any comparison

Estimate the standard deviation of the objective at one candidate (a handful of
replications), then compute how large a difference is detectable:

$$\text{detectable difference} \gtrsim 2\sqrt{2}\,\frac{\sigma}{\sqrt{n}}.$$

State this number. If your optimiser reports an improvement smaller than it, the
improvement is not distinguishable from noise. This one calculation prevents most of the
false conclusions in simulation-optimisation papers.

## Step 4 — Choose the search strategy to match the budget

| Budget (evaluations) | Strategy |
|---|---|
| < 50 | enumerate candidates and rank them with enough replications (ranking & selection) |
| 50–500 | sample-average approximation (SAA): fix $n$ replications, optimise the deterministic sample mean |
| 500–5000 | stochastic approximation / noisy pattern search; or a surrogate |
| expensive, few evaluations | Bayesian optimisation on a Gaussian-process surrogate |

**Sample-average approximation** is the workhorse and the easiest to defend:

1. Fix a replication count $n$ and a seed.
2. For each candidate, evaluate the mean of $n$ replications using CRN.
3. Optimise that deterministic sample mean with an ordinary solver (`scipy.optimize`,
   `mealpy`, a MILP if the structure allows).
4. **Increase $n$ and re-solve.** If the optimal candidate changes, $n$ was too small — say
   so and show the check. This is the SAA consistency check and reviewers look for it.

## Step 5 — Handle discrete decisions correctly

Policy parameters are often discrete (number of servers, reorder point, batch size). For
those:

- **Ranking and selection**: evaluate a small candidate set with many replications and
  select the best with a stated confidence (e.g. two-stage Rinott procedure). Report the
  probability of correct selection.
- **Ordinal optimisation** when you can only compare, not measure differences.
- Do not apply a gradient-based method to a discrete parameter by rounding the result — the
  rounded policy is not the optimum and may be infeasible.

## Step 6 — Validate the optimum against noise and against a baseline

Report all of the following:

1. The best policy found, with its parameter values in the problem's units.
2. The objective value with a **confidence interval across replications** (not a single number).
3. The **noise level** from Step 3 and the detectable difference.
4. A **baseline policy** — the current practice, or a simple heuristic — evaluated with the
   same CRN and the same number of replications. Report the paired difference and its CI.
5. A **re-optimisation check** with more replications (Step 4.4): did the answer hold?

If the best policy is not significantly better than the baseline, that is the result: say
the simpler policy suffices. It is a legitimate and often useful finding.

## Step 7 — Present the search, not just the winner

- Plot the objective against the decision variable(s), with error bars from the
  replications — this shows the shape of the response and where noise matters.
- If the search was adaptive, report the number of evaluations used.
- State the total compute (evaluations × replications × cost per run) so the reader can
  judge feasibility.

## Rules

- Never compare two candidates from **different** random streams when common random
  numbers are available.
- Never report a single-run difference as an improvement.
- Never use one replication per candidate and call the argmin the optimum.
- Never omit the noise level; without it the reader cannot judge the improvement.
- Never apply a continuous optimiser to a discrete policy by rounding.
- Always run the SAA re-optimisation check with a larger replication count and report whether
  the optimum moved.
- Always include a baseline policy evaluated under the identical protocol.
- If the answer is within noise of the baseline, report that instead of the winning policy.
