---
name: inventory-and-supply-chain
description: 建模库存、订货与供应链决策。当问题是"订多少""什么时候补货""安全库存""缺货成本"时使用。含 EOQ 及其"无缺货"假设的边界、数量折扣逐段算总成本、报童模型的临界分位数（不要用均值需求）、安全库存必须用提前期需求方差、服务水平的两种定义、多品多期 MIP 与成本分解。
---

# Inventory and Supply Chain Modelling

Use this skill when the decision is **how much to order and when**. These problems look
simple and are usually answered wrongly, because the objective (cost per unit time, not cost
per order) and the demand model (random, not deterministic) are the parts that matter.

## Requirements

```bash
uv pip install numpy scipy matplotlib
uv pip install pulp          # for multi-item / multi-period MIP formulations
```

## Step 1 — Classify the problem and name the cost terms

Every model here is a cost trade-off. Write down which costs apply and their units **per
unit time**:

| Cost | Symbol | Typical basis |
|---|---|---|
| Ordering / setup | $K$ | per order placed |
| Unit purchase / production | $c$ | per unit |
| Holding | $h$ | per unit per unit time |
| Shortage / backorder / lost sale | $p$ or $b$ | per unit short |
| Fixed shortage (lost goodwill) | — | per stockout event |

Then classify:

| Demand | Lead time | Model |
|---|---|---|
| Deterministic, constant | deterministic | **EOQ / EPQ** |
| Deterministic with price breaks | deterministic | **quantity discounts** |
| Random, single period (perishable) | — | **newsvendor** |
| Random, continuous review | random | **(Q, R)** with safety stock |
| Random, periodic review | random | **(s, S)** / order-up-to level |
| Several echelons (plant → DC → store) | — | multi-echelon / MIP |

The single most common error is using EOQ when demand is random and shortage is possible;
EOQ has no notion of a stockout.

## Step 2 — EOQ, and what it actually assumes

$$Q^* = \sqrt{\frac{2KD}{h}}, \qquad N^* = \frac{D}{Q^*}, \qquad
\text{total cost} = \underbrace{\frac{KD}{Q}}_{\text{ordering}} + \underbrace{\frac{hQ}{2}}_{\text{holding}}$$

where $D$ is demand per unit time. State the assumptions: constant known demand, instantaneous
replenishment, no shortages, constant unit cost.

- **Check the total-cost objective is per unit time.** Dividing both terms by the cycle length
  is what makes them comparable; a cost "per order" comparison is a different (wrong) problem.
- The unit purchase cost $cD$ does not appear because it is independent of $Q$ — **unless**
  there is a quantity discount, in which case it enters and the optimum can jump to a break
  point.
- **Robustness is a feature worth reporting**: total cost is flat near $Q^*$, so a 20 % error in
  $Q$ costs only ~2 % more. Compute and state this — it justifies using EOQ despite its
  assumptions, and it is a genuinely useful result.

For quantity discounts, evaluate the total cost at each break point and at each feasible
EOQ, then take the minimum. **Do not just price at the largest discount** — the extra holding
cost often exceeds the saving.

**EPQ** replaces instantaneous replenishment with a production rate $r$:
$Q^* = \sqrt{2KD / [h(1 - D/r)]}$.

## Step 3 — The newsvendor problem when demand is random and single-period

For perishable or one-shot decisions (newspapers, seasonal goods, event supplies), the
trade-off is between over-ordering and under-ordering:

$$F(Q^*) = \frac{p - c}{p - s} = \frac{C_u}{C_u + C_o}$$

where $C_u$ is the underage cost (lost margin) and $C_o$ the overage cost (markdown loss).
**This is the critical fractile**: order the quantile of demand that equals the ratio of
underage to total mismatch cost.

- Get the direction right: a high margin relative to markdown loss (fashion) pushes the
  fractile high (over-order); a high markdown loss pushes it low.
- If the demand distribution is not normal, use the empirical quantile rather than fitting a
  normal — the tail is what the fractile needs.
- Report the **expected profit at $Q^*$** and the **cost of using the mean demand instead**
  (the classic error). The gap is usually large and makes the point.

## Step 4 — Continuous review with random demand: safety stock and reorder point

With lead-time demand $D_L$ (a random variable) and a service-level target:

$$R = \underbrace{\mu_{D_L}}_{\text{expected lead-time demand}} + \underbrace{z_\alpha \sigma_{D_L}}_{\text{safety stock}}$$

- **Define the service level.** Cycle service level (probability of no stockout per cycle)
  and **fill rate** (fraction of demand met from stock) are different numbers, and fill rate is
  what a customer experiences. Say which you used. A 95 % cycle service level typically gives
  a fill rate well above 95 %.
- **Lead-time demand variance**, not daily variance, enters the formula:
  $\sigma_{D_L}^2 = L\sigma_d^2 + \mu_d^2\sigma_L^2$ when both demand and lead time vary. Using
  the daily $\sigma$ with a 7-day lead time underestimates safety stock by a factor of √7 and
  is the most common error here.
- Report safety stock in **units and in money** (it is capital tied up), and the holding cost
  it adds.

## Step 5 — Multi-item and multi-period decisions as a MIP

When items compete for budget, warehouse space or a truck, the problem couples:

$$\min \sum_t \sum_i (h_i I_{it} + K_i y_{it}) \quad\text{s.t.}\quad
I_{i,t-1} + Q_{it} - I_{it} = d_{it}, \quad Q_{it} \le M y_{it}, \quad
\sum_i v_i I_{it} \le \text{capacity}$$

Formulate in `pulp` with binary $y_{it}$ for order placement, and report the optimality gap
(see `optimization-modeling`). Report the **capacity shadow price** — what one more unit of
warehouse space is worth — since that is the actionable number for an expansion decision.

## Step 6 — Report the policy, the cost, and the sensitivity

Every result should state:

1. The policy in operational terms ("order 480 units when stock falls to 220").
2. The expected total cost per unit time, **decomposed** into ordering, holding and shortage
   components — the decomposition shows what dominates and therefore what to attack.
3. The **service level achieved** (and which definition), plus expected stockouts per year.
4. **Sensitivity**: how the policy and cost change with ±20 % in demand variability, lead
   time, and holding cost. Lead time and its variability usually dominate safety stock; show it.
5. **Comparison against the current policy** (or EOQ) with the same service level — a policy
   comparison at different service levels is meaningless.

## Rules

- Never apply EOQ to random demand without acknowledging it ignores shortages.
- Never compare total costs per order rather than per unit time.
- Never quote a safety stock without stating the service-level definition, and never use the
  daily standard deviation for lead-time demand.
- Never take a quantity discount without evaluating total cost at each break point.
- Never use the mean demand for a newsvendor order; the answer is a quantile.
- Never get the newsvendor direction wrong: check whether the underage or overage cost is larger.
- Always report the cost decomposition so the dominant term is visible.
- Always compare against the existing or naive policy at the same service level.
