---
name: statistical-testing
description: 为建模结论选择并报告正确的统计检验。当需要做显著性检验、相关性检验、方差分析，或用户说"有没有显著差异""p 值""检验一下"时使用。含检验选型、前提检查、效应量与置信区间、多重比较校正、回归诊断与 VIF。
---

# Statistical Testing

Use this skill whenever a conclusion is of the form "A differs from B", "X is related to
Y", or "the effect is significant". The deliverable is the correct test, its assumptions
checked, and the effect size reported alongside the p-value.

## Requirements

```bash
uv pip install numpy pandas scipy statsmodels
```

## Step 1 — State the hypothesis before choosing the test

Write $H_0$ and $H_1$ in the problem's own words, and fix the significance level
($\alpha = 0.05$ unless the problem says otherwise). Deciding the test after seeing
which one gives p < 0.05 is p-hacking; state the test choice and the reason in the paper.

## Step 2 — Choose by data structure, not by habit

| Question | Parametric | Non-parametric alternative |
|---|---|---|
| one mean vs a value | one-sample t-test | Wilcoxon signed-rank |
| two independent groups | Welch's t-test | Mann–Whitney U |
| two paired measurements | paired t-test | Wilcoxon signed-rank |
| three or more groups | one-way ANOVA | Kruskal–Wallis |
| two categorical variables | — | chi-square / Fisher exact (small counts) |
| association between two continuous variables | Pearson r | Spearman ρ |
| repeated measures, same subjects | RM-ANOVA | Friedman |

Default to **Welch's** t-test rather than Student's: it does not assume equal variances
and costs almost nothing when they are equal.

## Step 3 — Check the assumptions you are relying on

- **Normality**: Shapiro–Wilk for n < 50, otherwise inspect a QQ plot. With large n the
  central limit theorem covers the mean, but not for heavily skewed data.
- **Equal variances**: Levene's test before Student's t-test or ANOVA.
- **Independence**: verify from the study design, not from the data. Repeated measures on
  the same subject are not independent — using an unpaired test there invalidates the
  p-value.
- **Expected counts**: chi-square needs expected count ≥ 5 in each cell; otherwise use
  Fisher's exact test.

Report which checks you ran and their outcomes. If an assumption fails, switch to the
non-parametric alternative rather than proceeding.

## Step 4 — Report the effect size, not just p

A p-value answers "is there an effect", never "how big". Always pair it with:

- mean difference with a **95 % confidence interval** (this is what the paper should quote);
- **Cohen's d** for mean comparisons ($0.2$ small, $0.5$ medium, $0.8$ large);
- **η²** for ANOVA, **Cramér's V** for chi-square, **r** (or r²) for correlation.

State the direction and magnitude in words: "the treated group averaged 0.42 units higher
(95 % CI 0.18–0.66, d = 0.71)". A p-value alone is not a result.

## Step 5 — Correct for multiple comparisons

If you test many hypotheses, the chance of a false positive compounds. Either:

- **Bonferroni** (divide α by the number of tests) — simple, conservative;
- **Benjamini–Hochberg** FDR — better when there are many tests and you accept a
  controlled false-discovery rate.

Say how many tests you ran and which correction was applied. Running twenty correlations
and reporting the one with p = 0.04 without correction is the most common statistical
defect in these papers.

## Step 6 — Regression: test the model, not only the coefficients

For a regression-based sub-question also report:

- **residual plots** (residuals vs fitted, QQ) — patterns mean the functional form is wrong;
- **multicollinearity**: VIF per predictor; VIF > 10 means the coefficients are unstable,
  so drop or combine predictors;
- **R² and adjusted R²**, plus RMSE in the response's units;
- **outlier influence**: Cook's distance, and whether conclusions change without the top
  few influential points.

Correlation is not causation — where the problem asks for a causal claim, state the
assumption that licenses it or decline to make it.

## Rules

- Never report a p-value without the test name, the sample size, and the effect size.
- Never test normality with a test designed for something else, and never skip the check
  when the test depends on it.
- Never run many tests and report the significant one without a correction.
- Never write "significant" as a synonym for "large" — it means "unlikely under $H_0$".
- Never present a correlation as a causal mechanism.
- Report exact p-values (p = 0.032), not just "p < 0.05", and say when p is below the
  reporting precision (p < 0.001).
