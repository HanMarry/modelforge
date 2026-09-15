---
name: facility-location
description: 求解选址、覆盖与分配问题。当问题是"建在哪里""选址""覆盖多少人""配送中心"时使用。含 p-median、最大覆盖、集合覆盖、带容量选址（CFLP）的选型、需求聚合层级的影响、网络距离与投影、成本-覆盖权衡曲线、未覆盖需求与公平性检查。
---

# Facility Location and Coverage

Use this skill for "where should we put things" problems: warehouses, charging stations,
hospitals, monitoring stations, rescue points. The deliverable is a location set, the
allocation of demand to it, and the trade-off curve between cost and coverage — not a single
map with dots.

## Requirements

```bash
uv pip install numpy pandas scipy matplotlib
uv pip install pulp               # MIP formulation
uv pip install scikit-learn       # only for k-means style heuristics
```

## Step 1 — Classify the problem before modelling it

| Question | Model | Objective |
|---|---|---|
| Place exactly $p$ facilities to minimise total travel | **p-median** | minimise demand-weighted distance |
| Maximise demand within a radius, given $p$ or a budget | **maximal covering** | maximise covered demand |
| Cover all demand with the fewest facilities | **set covering** | minimise facility count |
| Facilities have capacity and a fixed cost | **capacitated facility location (CFLP)** | minimise fixed + transport cost |
| Demand must be assigned to exactly one facility | add single-sourcing constraints | — |
| Facilities serve as transfer points between origins and destinations | **hub location** | minimise routing cost via hubs |

Naming the model class determines the solver and the guarantees. Do not invent a formulation
when a standard one applies — cite it and use it.

## Step 2 — Decide how to represent demand, and say so

This choice changes the answer more than the solver does:

- **Aggregate demand into zones** (districts, grid cells, census tracts). Finer is more
  accurate and slower. State the aggregation level and its effect: re-solve at two levels and
  report whether the chosen sites move.
- **Demand weights** must have units and a source. "Population" and "population × frequency"
  give different answers.
- **Service radius** (for coverage models) must be justified — a policy standard, a travel
  time, or a stated assumption. Report the sensitivity to it: the site set often changes
  materially between a 10-minute and a 15-minute radius.

## Step 3 — Compute distances honestly

- Use **network distance or travel time** when movement is constrained by roads; Euclidean
  only for open terrain, and say which you used (see `spatial-analysis`).
- Compute distances in a **projected** coordinate system in metres, never in degrees.
- If the distance matrix is large, note its size — an $n \times m$ matrix of 10 000 × 200 is
  2 million entries, which is fine; 50 000 × 50 000 is not.

## Step 4 — Formulate and solve

**Maximal covering** (a good default when there is a budget rather than a fixed $p$):

$$\max \sum_i w_i z_i \quad\text{s.t.}\quad z_i \le \sum_{j \in N_i} y_j,\quad \sum_j c_j y_j \le B,\quad y_j, z_i \in \{0,1\}$$

where $N_i$ is the set of candidate sites covering demand $i$, $y_j$ opens site $j$, and $z_i$
marks demand covered. `pulp` handles this directly:

```python
import pulp
problem = pulp.LpProblem("coverage", pulp.LpMaximize)
y = pulp.LpVariable.dicts("open", sites, cat="Binary")
z = pulp.LpVariable.dicts("cover", demand, cat="Binary")
problem += pulp.lpSum(w[i] * z[i] for i in demand)                    # objective
problem += pulp.lpSum(c[j] * y[j] for j in sites) <= budget           # budget
for i in demand:
    problem += z[i] <= pulp.lpSum(y[j] for j in sites if j in N[i])   # coverage
problem.solve(pulp.PULP_CBC_CMD(msg=False))
```

- **p-median** adds $\sum_j y_j = p$ and minimises $\sum_{ij} w_i d_{ij} x_{ij}$.
- **Set covering** replaces the objective with $\min \sum_j y_j$ and requires $z_i = 1$
  for all $i$ — if it is infeasible, report that some demand **cannot** be covered with the
  candidate sites, which is a finding.
- Report the **solver status and the optimality gap** (see `optimization-modeling`). Location
  MIPs are NP-hard; a time-limited "best found" must be labelled as such.

Verify the solution by recomputing coverage and capacity from the returned variables — do not
trust the solver's objective alone.

## Step 5 — Report the trade-off curve, not one solution

The decision-maker needs the curve, not a point:

- Sweep the budget (or $p$) and plot **coverage achieved vs cost**.
- Mark the **knee** if you recommend a point, and say why.
- Report the **marginal value of the next facility** — how much coverage the next unit of
  budget buys. This is usually the most actionable number in the study.
- Report the **uncovered demand explicitly**, not just the coverage percentage. "96 % covered"
  hides which 4 % and whether it is the same hard-to-reach group every time.

## Step 6 — Check equity and robustness

- **Equity**: does the optimal solution systematically under-serve a group (rural, low-income)?
  Report coverage by group, not just overall. A max-coverage solution will always neglect
  sparse demand, and that is a policy choice worth making explicit.
- **Robustness**: how much coverage is lost if one facility fails (the min-cut of the
  solution), and how much the site set moves under ±10 % demand shift or a changed radius.
- **Sensitivity**: which constraint binds? Relaxing the binding one is where extra budget
  helps most.

## Rules

- Never present a single solution without the cost–coverage trade-off it came from.
- Never compute distances in degrees or across a network as Euclidean without saying so.
- Never report coverage without the uncovered demand.
- Never hide the aggregation level of demand; re-solve at two levels and report the movement.
- Never call a time-limited MIP solution optimal without stating the gap.
- Never present a max-coverage plan without checking which groups are under-served.
- Always verify the site set against the constraints by recomputation, and state which
  constraint is binding.
