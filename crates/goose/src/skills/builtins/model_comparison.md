---
name: model-comparison
description: 公平地比较候选模型。当要在多个模型之间选一个，或用户说"哪个模型更好""对比一下"时使用。含指名真实基线、跨模型协议对齐（同切分/同预处理/同调参预算）、按决策选指标、差异的置信区间与配对检验，以及"两者不可区分"也要如实写。
---

# Model Comparison and Selection

Use this skill when a paper claims one model is better than another, or has to justify a
model choice. The deliverable is a comparison that a reviewer cannot pick apart: matched
protocol, correct metric, an actual baseline, and honest uncertainty.

## Requirements

```bash
uv pip install numpy pandas scikit-learn scipy
```

## Step 1 — Name a real baseline first

Every comparison needs a floor. Without one, "our model achieves R² = 0.94" says nothing.

| Task | Baseline |
|---|---|
| Regression | predict the training mean; or the previous value for a time series |
| Classification | the majority class; or logistic regression |
| Forecasting | naive ("tomorrow = today") and seasonal naive |
| Optimisation | the current plan / no-optimisation plan; or the LP relaxation |
| Evaluation / ranking | equal weights |

**State the baseline's score in the same table as your model.** If your model does not beat
it, that is the finding — report it rather than dropping the baseline.

## Step 2 — Match the protocol across models

A comparison is only valid if every model saw the same data:

- **Same split.** One split, shared by all models. Never re-split per model.
- **Same preprocessing.** Fit the scaler/imputer on the training set once, reuse it.
- **Same tuning budget.** If you tuned model A over 200 configurations and model B with
  defaults, the comparison measures your effort, not the models. Give each model a
  comparable search budget and say what it was.
- **Same metric definition.** Two different RMSE implementations (ddof, weighted) is a
  common source of fake differences.
- **Same evaluation set.** Report on a held-out set or by cross-validation; never on data
  used for fitting or tuning.

For time series, split by time and use rolling-origin evaluation for every model.

## Step 3 — Choose the metric the decision needs

| Situation | Appropriate metric | Not appropriate |
|---|---|---|
| Errors matter proportionally | MAPE, relative error | RMSE on varying scale |
| Large errors are much worse | RMSE | MAE |
| Typical error matters | MAE, median absolute error | RMSE |
| Imbalanced classes | PR-AUC, F1, balanced accuracy | accuracy |
| Ranking matters, not the value | Spearman, NDCG, AUC | RMSE |
| Cost of each error type differs | expected cost with a cost matrix | any symmetric metric |

Report **at least two** metrics: one the problem implies, one diagnostic (e.g. RMSE with
MAE, or AUC with precision/recall). A single number hides the failure mode.

State units. "RMSE = 0.31" is meaningless without saying 0.31 of what.

## Step 4 — Quantify the uncertainty in the difference

"Our model is better" needs a spread. With cross-validation you get one score per fold:

```python
# Paired comparison: the same folds for both models
diffs = np.array(scores_a) - np.array(scores_b)
mean_diff = diffs.mean()
# Paired t-test on fold differences, or a Wilcoxon signed-rank for few/non-normal folds
```

Report: the mean difference, a **confidence interval**, and the test result. A difference
with a CI spanning zero is **not** evidence of superiority — say "the two are
indistinguishable on this data" and pick on another ground (interpretability, runtime,
robustness).

With a single split and no folds, use bootstrap resampling of the test set to get a CI on
the metric difference. A bare point comparison is not evidence.

## Step 5 — Report the trade-offs, not just the winner

Accuracy is rarely the only axis. Include a table:

| Model | Primary metric | Runtime | Interpretability | Data needed | Robustness |
|---|---|---|---|---|---|
| Baseline (mean) | … | … | high | none | — |
| Linear | … | fast | high | low | medium |
| Random forest | … | medium | low | medium | high |
| XGBoost | … | medium | low | medium | high |

Then justify the choice in one or two sentences **against this table**. "XGBoost had the
best RMSE (0.284 vs 0.291, CI includes 0), but we selected the linear model because the
problem requires interpretable coefficients and the accuracy difference is not
significant" is a defensible sentence. "XGBoost is best" is not.

## Step 6 — Check the comparison is not an artefact

Before concluding, rule out the common causes of a fake win:

- **Leakage**: a feature computed from the target, or using future information in a time
  split, inflates the winner only if that model uses it more.
- **Overfitting to the test set**: if you compared 30 configurations on the test set, the
  winner's score is optimistic. Use a validation set for selection and the test set once.
- **Different effective sample sizes**: dropping rows with missing values per model means
  the models were not scored on the same observations.
- **Class imbalance** in a classification comparison: accuracy will favour the majority
  class; check per-class metrics.

## Rules

- Never claim superiority without a baseline in the same table.
- Never compare models trained, tuned or evaluated under different protocols.
- Never report a metric without its unit and the evaluation set it was computed on.
- Never call a difference significant from point estimates alone; report the interval.
- Never select a model on the test set and then report the test score as unbiased.
- If the honest conclusion is "the models are equivalent here", write that — it is a
  result, and it often makes the discussion section stronger.
