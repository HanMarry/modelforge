---
name: multi-attribute-decision
description: 在多个冲突准则下做选择，而不只是排序。当问题含偏好、权重需要由决策者给出，或用户提到"多属性决策""ELECTRE""PROMETHEE""效用函数"时使用。含偏好信息必须显式获取（权重/效用/偏好函数/否决阈值）、加权和的完全补偿假设、ELECTRE 的不可比是合法答案、PROMETHEE 净流与权重扰动交叉验证。
---

# Multi-Attribute Decision Making

Use this skill when a choice must be made against several conflicting criteria and the
question is **what to recommend**. `evaluation-method` covers objective ranking (entropy
weights, TOPSIS); this skill covers the preference-based methods, the elicitation each one
requires, and how to defend a recommendation.

## Step 1 — Separate the two questions: ranking vs deciding

| Question | Method family |
|---|---|
| Score and rank alternatives on a fixed indicator set | TOPSIS / entropy weights (`evaluation-method`) |
| Model how much a decision-maker values each criterion level | **MAUT / MAVT** utility functions |
| Rank with partial preference information, allowing incomparability | **ELECTRE** (outranking) |
| Rank with a preference function per criterion, no incomparability | **PROMETHEE** |
| Aggregate several stakeholders' rankings | Borda, Copeland, or a distance-based consensus measure |

The first row uses only the data; the rest need **preference information** from a
decision-maker. Do not use an outranking method and then present the result as if it were
objective — the preferences are an input.

## Step 2 — Elicit and state the preferences

Every method below needs one of these, and it must be stated explicitly:

- **Weights** (relative importance). Where did they come from — an expert, a policy document,
  a survey, or your own judgement? Say which, and see `evaluation-method` for deriving them
  from data (entropy) or pairwise comparison (AHP, including the consistency check).
- **Utility functions** (MAUT): how value varies across a criterion's range. Linear is a
  choice; indifference and preference thresholds are choices too.
- **Preference functions** (PROMETHEE): usual, linear, level, or Gaussian, with the
  thresholds. The shape matters more than the weights in many applications.
- **Veto thresholds** (ELECTRE): the amount of bad performance on one criterion that
  disqualifies an alternative regardless of the others.

If no decision-maker is available, say so and present the result as *your* weighting with the
sensitivity analysis attached — never as a neutral finding.

## Step 3 — Weighted sum: use it, but know its limits

$$\text{Score}_i = \sum_j w_j \, u_j(x_{ij})$$

- **Normalise first** (per `evaluation-method`: scale each criterion, flip cost-type ones).
  A weighted sum of unnormalised criteria is meaningless.
- Its assumption is **full compensability**: a bad score on one criterion can always be
  offset by good scores on others. State this. If a decision-maker considers certain
  shortfalls unacceptable, a weighted sum cannot express that and you need ELECTRE's veto.
- Report the weights, the normalised matrix, and the final score with its rank.

## Step 4 — ELECTRE for outranking with vetoes

ELECTRE builds an outranking relation rather than a single score:

1. **Concordance**: the weighted share of criteria on which $a$ is at least as good as $b$.
2. **Discordance**: whether any criterion has $b$ so much better than $a$ that it vetoes the
   outranking.
3. $a$ outranks $b$ if concordance exceeds a threshold **and** no discordance veto applies.

The output is a **partial order**: some alternatives are incomparable, which is a legitimate
and often honest answer. Report the pairwise relation as a matrix or a graph — do not force it
into a total ranking unless the method's net-flow variant supports one. State the concordance
and discordance thresholds (0.7 / 0.3 are common; they are choices).

## Step 5 — PROMETHEE for a complete ranking

PROMETHEE avoids incomparability by computing preference degrees:

1. For each criterion, a **preference function** $P_j(a,b) \in [0,1]$ from the difference in
   performance, using the chosen shape and thresholds.
2. **Aggregated preference index** $\pi(a,b) = \sum_j w_j P_j(a,b)$.
3. **Positive flow** $\phi^+$ (how much $a$ outranks others, dominance) and **negative flow**
   $\phi^-$ (how much others outrank $a$, being dominated).
4. **Net flow** $\phi = \phi^+ - \phi^-$ gives the full ranking; $\phi^+$ vs $\phi^-$ plotted
   against each other shows which alternatives are dominated and which are on the trade-off
   frontier.

Report the preference function shape and thresholds per criterion, the weights, and the flows.
A PROMETHEE result with unstated thresholds is unreproducible.

## Step 6 — Stress the recommendation

Every one of these methods can be made to produce a preferred answer by choosing the
parameters. So the sensitivity analysis is not optional:

1. **Perturb the weights** ±10 %, ±20 % and record how often each alternative ranks first
   (`evaluation-method` has the frequency approach). Report "A is first in 94 % of 500
   perturbations", not "A is best".
2. **Change the method** — run weighted sum and one outranking method. If they disagree,
   say so and explain which criteria cause the disagreement. That disagreement is the
   interesting result.
3. **Swap the preference function or the thresholds** in PROMETHEE; check whether the top
   alternative changes.
4. **Report the near-ties**: alternatives within a small margin of each other should be
   presented as tied, with the tie-breaking criterion stated.

## Rules

- Never present a preference-based result as objective; name whose preferences and how they
  were obtained.
- Never run a weighted sum without normalising the criteria per direction.
- Never force an ELECTRE partial order into a full ranking without saying you did.
- Never report PROMETHEE without the preference function and thresholds per criterion.
- Never report a single winner without the weight-perturbation frequency and a second method.
- Never hide incomparability or a near-tie; both are legitimate outcomes that a decision-maker
  needs to see.
- Always report which criterion is decisive in the recommendation.
