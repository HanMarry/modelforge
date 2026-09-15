---
name: queueing-and-simulation
description: 建模排队、等待与服务系统。当问题涉及"排队""等待时间""服务台数量""拥堵"时使用。含 M/M/1、M/M/c、M/G/1 公式、Little's 定律校验、SimPy 离散事件仿真、预热期与重复次数设置、置信区间报告。
---

# Queueing and Discrete-Event Simulation

Use this skill when arrivals and service create waiting, or when the system is stochastic
and too irregular for a formula. The deliverable is either a justified closed-form result
or a simulation with the right number of replications and a confidence interval.

## Requirements

```bash
uv pip install numpy scipy matplotlib
uv pip install simpy            # discrete-event simulation
```

## Step 1 — Decide: formula or simulation

Reach for the closed form **first** when the system is a standard queue:

| System | Condition | Key results |
|---|---|---|
| M/M/1 | Poisson arrivals, exponential service, one server | $\rho=\lambda/\mu$, $L=\rho/(1-\rho)$, $W=L/\lambda$ |
| M/M/c | c identical servers, shared queue | Erlang-C for waiting probability |
| M/M/1/K | finite capacity, losses allowed | blocking probability |
| M/G/1 | general service distribution | Pollaczek–Khinchine formula |

Notation is Kendall's: arrivals/service/servers. **The formulas assume exponential
service and Poisson arrivals** — test those assumptions before quoting the result, and
say what you tested.

Simulate when: the discipline is not FIFO, servers are heterogeneous, the network has
several stages, arrivals are non-stationary, or there are priorities and reneging.

## Step 2 — State the model parameters

Write down, with units: arrival rate $\lambda$ (per hour), service rate $\mu$, number of
servers, queue capacity, service discipline, and the initial state. Always compute and
report **utilisation** $\rho = \lambda/(c\mu)$. If $\rho \ge 1$ the queue grows without
bound — that is a finding about the system's capacity, not a simulation bug.

## Step 3 — Verify Little's law as a check

$$L = \lambda W$$

applies to any stable queueing system, regardless of distribution. Use it to validate
your simulation: measure the mean number in system and the mean time in system and check
the identity holds within sampling error. If it does not, the measurement logic is wrong.

## Step 4 — Simulate correctly

```python
import simpy

def customer(env, server, service_time, stats):
    arrive = env.now
    with server.request() as request:
        yield request
        wait = env.now - arrive
        yield env.timeout(service_time)
        stats["wait"].append(wait)

env = simpy.Environment()
server = simpy.Resource(env, capacity=c)
env.process(arrival_process(env, server, stats))
env.run(until=horizon)
```

Three things decide whether the numbers mean anything:

1. **Warm-up.** A simulation started empty is not in steady state. Discard the initial
   transient — plot the running mean and choose the point where it stabilises. State the
   warm-up length you discarded.
2. **Replications.** One long run gives no confidence interval. Run $n \ge 30$
   independent replications with **different seeds**, and report the mean and a 95 %
   confidence interval across replications. Use the replication means, not the pooled
   observations, to compute the interval — pooled observations are correlated.
3. **Common random numbers.** When comparing two configurations, use the same random
   streams so the difference is measured against the same arrival pattern. This reduces
   the variance of the comparison substantially.

## Step 5 — Analyse the output properly

- Report each performance measure as **mean ± 95 % CI** across replications.
- Do not fit a distribution to the output and pretend it is the sampling distribution;
  use the replication-based interval.
- Report the **fraction of customers who waited**, not only the mean wait — a mean can be
  dominated by a few very long waits.
- Report tail behaviour: the 95th percentile wait is often the operationally relevant
  number.
- If you sweep a parameter (number of servers, arrival rate), show the CI at each point
  and whether the CIs overlap before claiming a difference.

## Step 6 — Connect back to the decision

State the operational answer: minimum servers to keep the 95th-percentile wait under a
target, the cost of that configuration, and the trade-off curve between service level and
cost. The queue metrics are inputs to that decision, not the conclusion.

## Rules

- Never report a single simulation run.
- Never use M/M/c formulas for a service distribution that is clearly not exponential
  (a constant service time is M/D/c, and the wait is roughly half of M/M/c).
- Never ignore warm-up; a transient-dominated mean is wrong in a predictable direction.
- Never compare two configurations from different random streams when common random
  numbers are available.
- Never report $\rho \ge 1$ as a valid steady-state result.
- Always state the number of replications, the horizon, and the warm-up discarded.
