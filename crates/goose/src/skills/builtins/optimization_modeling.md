---
name: optimization-modeling
description: 为建模问题建立并求解优化模型。当问题是"最优方案""成本最小""利润最大""调度""分配"时使用。含决策变量、目标函数与约束族（资源、平衡、逻辑、整数）建模、求解器选型、big-M 的取值风险、最优性间隙报告与多目标 Pareto 前沿。
---

# Optimisation Modelling

Use this skill when a sub-question asks for the best plan, allocation, schedule, siting
or parameter choice. The deliverable is a model, a solved instance, and evidence that
the solution is both feasible and close to optimal.

## Requirements

```bash
uv pip install numpy scipy matplotlib
uv pip install pulp                 # MILP with readable model code
uv pip install mealpy               # single-objective metaheuristics
uv pip install pymoo                # multi-objective (NSGA-II)
```

Pick one solver family and justify it. Do not install all of them.

## Step 1 — Write the model in three parts

Before code, write the model in the paper's notation:

1. **Decision variables** — with type (continuous / integer / binary) and bounds.
2. **Objective** — maximise or minimise, and why that is the right surrogate for the
   problem's goal.
3. **Constraints** — each one with a one-line justification from the problem statement.

If the problem is described in words, the mapping from each sentence to a constraint is
part of the deliverable. A model with no stated constraint provenance is unverifiable.

## Step 2 — Check linearity, then pick the solver

| Structure | Solver | Notes |
|---|---|---|
| Linear objective and constraints, continuous | `scipy.optimize.linprog` | exact optimum, fast, large scale |
| Linear with integer/binary variables | `pulp` (CBC) or HiGHS | exact optimum; watch time limits |
| Smooth nonlinear, small dimension | `scipy.optimize.minimize` | try multiple starts |
| Nonlinear, non-convex, black box | `mealpy` (PSO/GA) | approximate; report variance over seeds |
| Several conflicting objectives | `pymoo` (NSGA-II) | returns a Pareto front, not one answer |

**Prefer the exact method when the structure allows it.** A metaheuristic is justified
when the problem is genuinely non-convex or black-box, not because it was easier to code.

## Step 3 — Implement with the model visible

Write the model so a reader can map it to the paper's equations — one constraint group
per block, named after the constraint:

```python
import pulp

problem = pulp.LpProblem("allocation", pulp.LpMinimize)
x = pulp.LpVariable.dicts("x", (i, j), lowBound=0, cat="Continuous")
y = pulp.LpVariable.dicts("y", i, cat="Binary")

problem += pulp.lpSum(cost[i][j] * x[i][j] for i in i_idx for j in j_idx)   # objective
problem += pulp.lpSum(x[i][j] for j in j_idx) <= capacity[i]  for i in i_idx  # resource
problem += pulp.lpSum(x[i][j] for i in i_idx) >= demand[j]    for j in j_idx  # balance
problem += x[i][j] <= big_m * y[i]                            for i in i_idx for j in j_idx  # logical

status = problem.solve(pulp.PULP_CBC_CMD(msg=False))
print(pulp.LpStatus[status], pulp.value(problem.objective))
```

Then verify the solution against the constraints **manually**, not just by trusting the
solver status. Recompute each constraint's left-hand side from the returned variables
and print the slack. A solution that violates a constraint you encoded wrongly is the
most damaging error in an optimisation paper.

## Step 4 — Handle the failure modes

- **Infeasible**: relax one constraint at a time and report which one binds. Do not
  silently drop a constraint.
- **Unbounded**: usually a missing upper bound — go back to Step 1.
- **Timeout / no proven optimum**: report the **optimality gap**
  $(\text{bound} - \text{incumbent})/|\text{incumbent}|$ and the time limit. "Best found
  within 60 s" is an honest result; "the optimum" is not.
- **Metaheuristic variance**: run at least 10 seeds and report the distribution of the
  best objective. A single run is not evidence.

## Step 5 — Multi-objective

With several conflicting objectives you get a **Pareto front**, not an answer. Report:

- the front (as a table or plot), with the two objectives on the axes;
- how the front was filtered to a recommendation (knee point, weighted sum with stated
  weights, or a stated preference from the problem);
- the **hypervolume** or spacing metric if you compare algorithms.

Never collapse objectives into a weighted sum without showing what the weights do: run
at least three weight settings and show how the chosen solution moves.

## Step 6 — Model the discrete choices explicitly

Most competition optimisation problems have a hidden combinatorial structure (on/off
decisions, sequencing, minimum batch sizes). Encode it with binary variables and
big-M constraints rather than rounding a continuous solution — rounding can violate
constraints and produces a solution that is not feasible in the real problem.

## Rules

- Never claim optimality without either a solver's proven optimum or a stated gap.
- Never present a metaheuristic result from one seed.
- Never re-verify nothing: always recompute constraint violation and feasibility from the
  returned solution.
- Always report the objective in the problem's own units, alongside the model's.
- Keep the model formulation in the paper identical to the code — if they diverge, the
  numbers are unverifiable.
