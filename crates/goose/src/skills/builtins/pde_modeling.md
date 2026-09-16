---
name: pde-modeling
description: 用偏微分方程建模并求解空间分布系统。当问题涉及"随空间变化""扩散""对流""温度场""渗流"时使用。含先写守恒式、方程分类（抛物/双曲/椭圆）决定方法、三类边界条件、方法线离散化与网格收敛检查、CFL 稳定性判据、守恒量漂移检查与显式/隐式取舍。
---

# PDE Modelling

Use this skill when the state varies in **space and time** (or in space with a boundary
value problem). `differential-equation-modeling` covers ODE systems; this one covers the
extra hazards that space brings: boundary conditions, mesh choice, and numerical stability.
An unstable scheme produces oscillations that look like physics and are not.

## Requirements

```bash
uv pip install numpy scipy matplotlib
```

`solve_ivp` on a discretised system (method of lines) covers most competition problems.
Reach for FEniCS or FiPy only when the geometry genuinely demands finite elements.

## Step 1 — Write the conservation statement first

Every PDE in these problems comes from a conservation law. Write it in words, then in
symbols:

$$\underbrace{\frac{\partial u}{\partial t}}_{\text{accumulation}} =
\underbrace{-\nabla\cdot \mathbf{J}}_{\text{net flux in}} + \underbrace{S(u,x,t)}_{\text{source}}$$

Then state each flux law explicitly (Fick: $\mathbf{J} = -D\nabla u$; Fourier; Darcy), with
its units. If you cannot write the conservation statement in words, the equation is a
guess, and reviewers treat it as one.

**Classify the equation** before solving, because the class dictates the method:

| Type | Example | Behaviour |
|---|---|---|
| Parabolic | heat, diffusion | smooths; implicit schemes are stable |
| Hyperbolic | advection, wave | transports; upwinding needed; CFL critical |
| Elliptic | steady-state Laplace, Poisson | boundary value problem, no time step |

## Step 2 — State the domain, initial and boundary conditions completely

A PDE without its boundary conditions is not a well-posed problem. Report all of:

- **Domain**: geometry and extent, with units (a 1-D reduction must be justified).
- **Initial condition** $u(x,0)$: where it came from.
- **Boundary conditions**, each labelled by type:
  - Dirichlet (value fixed): $u = u_b$;
  - Neumann (flux fixed): $\partial u/\partial n = q$, including the insulated case $q=0$;
  - Robin (convective exchange): $-k\partial u/\partial n = h(u - u_\infty)$.
- **Consistency check**: the initial condition must satisfy the boundary conditions at
  $t=0$, or the solution has a discontinuity that looks like a numerical error.

A common defect is choosing Neumann everywhere because it is convenient; that leaves the
solution determined only up to a constant.

## Step 3 — Discretise and justify the mesh

Method of lines: discretise space, keep time continuous, hand the ODE system to `solve_ivp`.

```python
x = np.linspace(0, L, nx)
dx = x[1] - x[0]

def rhs(t, u):
    dudt = np.zeros_like(u)
    # interior: second-order central difference for diffusion
    dudt[1:-1] = D * (u[2:] - 2*u[1:-1] + u[:-2]) / dx**2
    # boundaries: apply the boundary condition of the problem
    dudt[0] = 0.0                     # Dirichlet
    dudt[-1] = D * (u[-2] - u[-1]) / dx**2   # Neumann (insulated)
    return dudt
```

- **Discretisation error is $O(\Delta x^2)$** for central differences, $O(\Delta x)$ for
  upwind. State the order you are using.
- **Refine the mesh and show convergence**: halve $\Delta x$, re-solve, and report the change
  in the answer. If the answer moves materially, the mesh is too coarse — this is the PDE
  equivalent of a convergence check and it is expected in a good paper.
- For advection-dominated problems, central differences oscillate; use **upwinding** and say
  so.

## Step 4 — Check stability before trusting the solution

For explicit schemes, the **CFL condition** is not optional:

$$D\frac{\Delta t}{\Delta x^2} \le \tfrac{1}{2} \quad\text{(1-D diffusion)}, \qquad
c\frac{\Delta t}{\Delta x} \le 1 \quad\text{(advection)}.$$

Compute the number and report it. If you violate it, the solution blows up; if you then
tighten `rtol` instead of $\Delta t$, you are treating a stability problem as an accuracy
problem and it will not work.

If CFL forces an impractically small $\Delta t$, switch to an **implicit** scheme
(Crank–Nicolson, backward Euler) which is unconditionally stable — at the cost of solving a
linear system each step. Say which you chose and why.

## Step 5 — Verify the physics is preserved

Numerical solutions drift. Check the invariants:

| Check | How |
|---|---|
| Mass / energy conservation | integrate $u$ over the domain at each output time; a closed system must hold it constant. **A violation above a few percent means the scheme leaks** — report the drift |
| Positivity | concentrations and temperatures must not go negative |
| Steady state | as $t\to\infty$, compare with the analytic or separately solved steady state |
| Symmetry | a symmetric problem must give a symmetric solution; asymmetry means a bug |
| Analytic case | if a special case has a closed-form solution, compare against it and report the maximum error |

The mass-conservation check is the single most informative test for a diffusion or
advection problem, and it is the one most often missing.

## Step 6 — Report the solution as a field, not a number

- Plot **space–time** representations: profiles at several times, or a heatmap of $u(x,t)$.
- Identify what the problem asks for: penetration depth, front position, time to reach a
  threshold, steady-state profile.
- Report those quantities with a convergence estimate (from the mesh refinement in Step 3).
- For a 2-D problem, plot the field at key times; a single final snapshot hides the dynamics.

Use `math-figure` for the export conventions.

## Rules

- Never solve a PDE without stating the boundary conditions and their type.
- Never use an explicit scheme without computing and reporting the CFL number.
- Never report a solution without a mesh-refinement check, or state that the mesh was
  verified elsewhere.
- Never present oscillatory output as physical behaviour without ruling out instability.
- Never reduce a 2-D problem to 1-D without justifying why the second dimension is negligible.
- Never omit the conservation check on a problem that should conserve mass or energy.
- Always state the discretisation order and the time integrator used.
