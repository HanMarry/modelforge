---
name: cellular-automata
description: 建立元胞自动机或 agent-based 空间仿真模型（土地利用、疫情与火灾蔓延、交通流）。当问题涉及"局部规则产生全局格局""邻域演化""扩散模拟"时使用。含元胞与邻域/边界定义、转移规则设计、用观测数据标定与 FoM 评价、随机集合与格局指标。
---

# Cellular Automata and Local-Interaction Models

Use this skill when a global pattern emerges from **local rules**: land-use change,
epidemic or fire spread, traffic, opinion diffusion, urban growth. The deliverable is a
defined lattice and rule set, a calibrated model, and evidence that the simulated pattern
matches observations rather than merely looking plausible.

## Requirements

```bash
uv pip install numpy matplotlib
uv pip install scipy        # convolution-based neighbourhood updates
uv pip install numba        # only if the grid is large and the loop is slow
```

Pure numpy is usually enough. Reach for `numba` only after measuring.

## Step 1 — Define the lattice and boundary conditions explicitly

Write down before coding:

- **Grid** — cell size in real units (e.g. 30 m), and the resulting cell count. Cell size
  is a modelling choice, so test at least two resolutions and report whether conclusions
  survive.
- **States** — the finite set of cell states, with what each means.
- **Neighbourhood** — von Neumann (4) or Moore (8), or an extended radius. The choice
  changes the dynamics; justify it or show both.
- **Boundary** — fixed (walled), periodic (wraps), or reflecting. Choosing periodic to
  avoid edge effects must be stated, since it is not physical for most real regions.
- **Time step** — what one iteration represents in real time, and how it was chosen.

## Step 2 — Write the transition rule in testable form

State the rule as a probability or a deterministic function of the neighbourhood, and
name every parameter:

$$P(s_i^{t+1} = \text{developed}) = f(\text{neighbour count},\ \text{suitability}_i,\ \text{road distance}_i,\ \dots)$$

Typical forms:

- **logistic**: $P = 1/(1+e^{-z})$ with $z$ linear in the covariates — interpretable
  coefficients, easy to calibrate;
- **threshold**: convert when the neighbour count exceeds a threshold — simple, but
  brittle at the threshold;
- **contact process** (spread): $P = 1-(1-p)^{n_{\text{infected}}}$ with $p$ the per-contact
  transmission probability.

Update **synchronously** by default (all cells computed from the same previous state) —
asynchronous updating changes the results, so if you use it, say so.

```python
from scipy.signal import convolve2d
kernel = np.array([[1, 1, 1], [1, 0, 1], [1, 1, 1]])          # Moore neighbourhood
neighbour_count = convolve2d(state == INFECTED, kernel, mode="same", boundary="fill")
```

## Step 3 — Calibrate against data, do not hand-pick parameters

A cellular automaton has enough freedom to reproduce almost any pattern by tuning, so
calibration must be honest:

- Fit the rule's parameters on an **earlier period** and validate on a **later one**;
  calibrating and evaluating on the same snapshot proves nothing.
- Use a proper objective: the **Figure of Merit** (observed change that was correctly
  simulated minus observed change simulated in the wrong place) or at minimum
  hit-rate / Kappa. Plain cell-by-cell accuracy is misleading because most cells do not
  change — a model that predicts "no change" everywhere scores highly and is useless.
- Report the calibrated parameters with the objective value, and the objective on the
  **validation** period.

If the parameters look arbitrary, they probably are. Say which were fitted and which
were assumed from literature.

## Step 4 — Handle stochasticity with an ensemble

A stochastic rule gives a different map on every seed, so one run is not a result:

- Run **30+ seeds** and report the mean and spread of the aggregate metrics (total
  converted area, patch count, spread front speed).
- Report the **frequency** with which each cell converts across runs — a probability map
  is far more informative than one realisation.
- For spread models, report the distribution of arrival times, not a single arrival time.

## Step 5 — Validate the pattern, not just the totals

Matching total area while producing the wrong spatial arrangement is a failure. Compare
pattern metrics between simulation and observation:

- **patch size and shape** (number of patches, mean patch area, perimeter–area ratio);
- **spatial autocorrelation** of the simulated state (join-count statistics, Moran's I —
  see `spatial-analysis`);
- **edge density** and the distance-decay of conversion probability from roads or
  existing development.

Then run the sensitivity check from `sensitivity-analysis` on the rule parameters: which
one changes the pattern most, and over what range is the conclusion stable.

## Step 6 — Report the simulation as a scenario, not a prediction

Projections from a cellular automaton are conditional on the rules and the assumed
drivers. Present them as scenarios ("under continued road expansion at the observed rate,
…"), state the horizon, and state the validation metric from Step 3.

## Rules

- Never present one stochastic realisation as the model's output.
- Never calibrate and validate on the same time period.
- Never report overall accuracy on an imbalanced grid without the figure of merit or Kappa.
- Never change cell size, neighbourhood, or boundary conditions without reporting the
  effect on the result.
- Never describe a scenario projection as a prediction.
- Keep the update synchronous unless asynchronous updating is justified, and say which.
