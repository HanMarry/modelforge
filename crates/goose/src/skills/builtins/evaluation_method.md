---
name: evaluation-method
description: 建立可辩护的多准则评价与排序。当问题是"评价""打分""排序""选优""综合指标"时使用。含 AHP（必须报 CR ≤ 0.1）、熵权法、TOPSIS、灰色关联、PCA 赋权与秩聚合，并做权重扰动与稳健性检验。
---

# Multi-Criteria Evaluation and Ranking

Use this skill whenever a sub-question is "which is best", "rank these", or "score the
schemes". The deliverable is not a single number: it is a ranking plus the evidence that
the ranking is stable.

## Requirements

```bash
uv pip install numpy pandas
```

Everything else is a short vectorised implementation. Only reach for `scikit-learn`
when you need PCA for weighting.

## Step 1 — Fix the decision matrix

Write the problem as a matrix $X$ with one row per alternative and one column per
indicator. Before any computation:

- Record the **unit** and **direction** of each indicator (benefit = larger is better,
  cost = smaller is better).
- Check for missing entries. Impute deliberately and say how; a silently mean-filled
  cell can flip a ranking.
- Check for indicators that are the same quantity in different units. They double-count
  and must be merged.

State this table in the paper. Reviewers check it before they check your weights.

## Step 2 — Pick the weighting method and justify it

| Method | Use when | Fails when |
|---|---|---|
| Entropy weight | indicators are complete and you want objective weights | sample is small, or a column is near-constant (entropy → 0, weight explodes) |
| AHP | a hierarchy exists and expert judgement is legitimate | too many indicators (judgement matrix becomes inconsistent), no domain input available |
| PCA weighting | indicators are correlated and you want to collapse them | loadings are hard to interpret, or you need per-indicator meaning |
| Equal weights | no defensible basis, and you say so | you are hiding the fact that weights matter |
| Combined (AHP × entropy, normalised) | you want both expert and data input | you do not report both sets of weights separately too |

Do not choose entropy weights simply because they look objective — for a small sample
they are unstable. Compute two weightings where possible and report whether the final
ranking changes.

### Entropy weight

Standardise to proportions $p_{ij} = x_{ij} / \sum_i x_{ij}$ (after shifting so all
values are positive), then

$$e_j = -\frac{1}{\ln n}\sum_i p_{ij}\ln p_{ij}, \qquad w_j = \frac{1-e_j}{\sum_k (1-e_k)}.$$

Guard the log: a zero proportion must be skipped, not passed to `np.log`.

### AHP

Build the pairwise judgement matrix, normalise columns, average rows for the weight
vector, then compute $\lambda_{\max}$ and

$$CR = \frac{(\lambda_{\max}-n)/(n-1)}{RI},$$

with $RI$ from the standard table (n=3: 0.58, n=4: 0.90, n=5: 1.12, n=6: 1.24,
n=7: 1.32, n=8: 1.41). **$CR < 0.1$ or the matrix must be revised** — printing a
failed CR and carrying on is the single most common defect in these papers.

## Step 3 — Normalise by direction

Vector or min-max normalisation, applied per direction:

- benefit: $r_{ij} = (x_{ij} - \min_i x_{ij}) / (\max_i x_{ij} - \min_i x_{ij})$
- cost: $r_{ij} = (\max_i x_{ij} - x_{ij}) / (\max_i x_{ij} - \min_i x_{ij})$

If any denominator is zero, the indicator is constant — drop it and say so.

## Step 4 — Rank

**TOPSIS**: weighted matrix $v_{ij} = w_j r_{ij}$; ideal $v^+_j = \max_i v_{ij}$,
anti-ideal $v^-_j = \min_i v_{ij}$; distances $D^\pm_i$; closeness
$C_i = D^-_i/(D^+_i + D^-_i)$. Rank by $C_i$ descending.

**Grey relational analysis**: reference sequence = the ideal row; compute
$\xi_{ij} = \frac{\min\min|x_{0j}-x_{ij}| + \rho\max\max|\cdot|}{|x_{0j}-x_{ij}| + \rho\max\max|\cdot|}$
with $\rho = 0.5$, then average over indicators.

**Rank aggregation** (when you have several rankings): use Borda count or the mean
rank, and report the Spearman correlation between the input rankings. A low
correlation means the methods disagree, which is a finding, not something to average away.

## Step 5 — Report, and stress the result

The ranking alone is not enough. Include:

1. The decision matrix with units and directions.
2. The weights, with the method named.
3. The final score and rank per alternative.
4. **A stability check**: perturb the weights by ±10–20% (or re-run with a second
   weighting method) and report which alternatives change rank. State the conclusion as
   "A ranks first in X% of the perturbations" rather than asserting a bare ordering.
5. The AHP consistency ratio if AHP was used.

## Rules

- Never present a ranking without the weights that produced it.
- Never use AHP without reporting CR, or with CR ≥ 0.1.
- Never let a benefit indicator be treated as a cost (or vice versa); check every
  direction against the problem statement.
- If two alternatives are within noise of each other, say they are tied — do not
  invent a decisive margin.
- Put the evaluation code in `code/` and print the matrix, weights, and scores so every
  number in the paper is traceable.
