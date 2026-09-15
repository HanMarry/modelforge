---
name: differential-equation-modeling
description: 建立并求解微分方程机理模型。当问题涉及"变化率""传染/增长""种群""药代""传热"等机理描述时使用。含仓室与种群建模、无量纲化、刚性方程求解与容差设置、参数辨识与可辨识性、守恒量校验与稳定性分析。
---

# Differential Equation Modelling

Use this skill when the process has a mechanism (growth, decay, spread, flow, reaction,
heat) and the question asks how it evolves. The deliverable is a stated system, fitted
parameters, a numerical solution with its accuracy justified, and the invariants checked.

## Requirements

```bash
uv pip install numpy scipy matplotlib
uv pip install sympy          # only when you need a symbolic derivation
```

## Step 1 — Write the system and its assumptions explicitly

Before code, state in the paper:

- the **state variables** and their units;
- the **balance** for each state (what flows in, out, and is created or destroyed);
- every **rate law** with its justification (mass action, first-order decay,
  Michaelis–Menten, logistic, …);
- **initial conditions** and **boundary conditions**, with where each came from.

A differential-equation model is only as defensible as its rate laws. "We assume
logistic growth" without a reason is the standard weak point.

## Step 2 — Non-dimensionalise when the scales differ

If parameters span orders of magnitude, non-dimensionalise before solving:

$$\tilde{t} = \frac{t}{T}, \quad \tilde{x} = \frac{x}{L},$$

which exposes the dimensionless groups that actually control the behaviour. Report them
(e.g. a Reynolds or Péclet number) — they tell the reader which regime the system is in,
which is often a better answer than the raw solution.

## Step 3 — Choose stiffness-aware solver settings

```python
from scipy.integrate import solve_ivp

solution = solve_ivp(
    rhs, (t0, t1), y0,
    method="LSODA",          # auto-switches between stiff and non-stiff
    rtol=1e-8, atol=1e-10,
    dense_output=True,
    t_eval=grid,
)
if not solution.success:
    raise RuntimeError(solution.message)
```

- `RK45` for smooth non-stiff systems; `LSODA` or `BDF` when rates differ by >10²,
  which is where explicit methods either crawl or blow up.
- **Always check `solution.success`.** A silently failed integration produces a plot
  that looks plausible and is wrong.
- Tighten `rtol`/`atol` and re-solve; if the answer moves, your earlier tolerances were
  not enough. Report the tolerance you used.

For PDEs, discretise space explicitly (method of lines) and state the grid and the
**CFL condition**; an unstable scheme gives oscillations that are numerical artefacts,
not physics. `scipy.integrate.solve_ivp` on the discretised system is usually enough —
reach for a finite-element package only if the geometry demands it.

## Step 4 — Estimate parameters from data

- Set it up as an optimisation: minimise the sum of squared residuals between the
  solution and the observations (`scipy.optimize.least_squares`).
- **Use multi-start**: fit from 20+ random or log-spaced initial guesses. A single
  `curve_fit` call that converges says nothing about uniqueness.
- Report each fitted parameter **with a confidence interval** (from the Jacobian, or by
  bootstrapping the residuals).
- Check **identifiability**: if two parameters only appear as a product, the data cannot
  separate them. Say so rather than reporting two confident-looking numbers.
- State the units and the residual magnitude. Plot the fit over the data.

## Step 5 — Check the invariants

Numerical solutions drift. Verify the physics:

- **Conservation**: for a closed system, the total mass/energy must stay constant —
  compute it at each output time and report the maximum drift.
- **Positivity**: concentrations and populations cannot go negative. If they do, your
  step size or solver is wrong, or the model is missing a constraint.
- **Steady states**: solve `rhs(y) = 0` and check the simulation converges to the one
  the stability analysis predicts.
- **Stability**: linearise around each steady state and report the eigenvalues. A
  steady state with a positive real eigenvalue is unstable, and the simulation should
  agree.

## Step 6 — Report dynamics, not just the final value

Plot the trajectories and describe the qualitative behaviour: monotone or oscillatory,
converging or diverging, the time to reach 90 % of steady state, the peak and when it
occurs. Those are the numbers a paper can compare against reality.

## Rules

- Never present a solution without stating the solver, the tolerances, and the
  integration success flag.
- Never fit parameters with a single starting guess and report them as though unique.
- Never report a fitted parameter without units or without an uncertainty.
- Never plot a numerically unstable solution as if it were the model's behaviour.
- Never skip the conservation check on a system that should conserve something.
- If the model is phenomenological rather than mechanistic, say so explicitly.
