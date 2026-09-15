---
name: classification-modeling
description: 建立与评估分类模型。当问题是"判断类别""预测是否""分类准确率""识别"时使用。含类别平衡检查、先切分后重采样、按决策选指标（不平衡时用 PR-AUC 而非 ROC-AUC）、阈值必须显式选择并说明依据、类别权重优先于 SMOTE、概率校准与混淆矩阵。
---

# Classification Modelling

Use this skill when the outcome is categorical. The deliverable is a model plus a decision
threshold, both justified — an unthresholded probability and an accuracy figure is not a
classification result.

## Requirements

```bash
uv pip install numpy pandas scikit-learn matplotlib
uv pip install imbalanced-learn    # only when resampling is genuinely needed
```

## Step 1 — Look at the class balance before anything else

```python
print(y.value_counts(normalize=True))
```

If one class is under ~10 %, **accuracy is the wrong metric** and will mislead: predicting
the majority class everywhere can score 0.95 and be useless. Say the balance in the paper —
a reviewer needs it to interpret every later number.

## Step 2 — Split before you resample

- Split first (`train_test_split(..., stratify=y)`), then resample **only the training
  set**. Resampling before splitting leaks synthetic copies of test rows into training and
  inflates the score.
- `stratify=y` keeps the class ratio in both folds. Without it, a small class can be
  missing from one fold.

## Step 3 — Choose metrics from the decision, not from habit

| Situation | Report |
|---|---|
| Both error types similar cost | F1, balanced accuracy, MCC |
| Missing a positive is costly (fault, disease) | **recall** for the positive class, plus the operating threshold |
| A false alarm is costly | **precision**, plus the threshold |
| Ranking quality matters | ROC-AUC; **PR-AUC** when classes are imbalanced |
| Need a single summary | MCC (balanced, unlike F1 for skewed classes) |

Always report the **confusion matrix** alongside whichever summary you chose — it is the
only view that shows which error you are actually making.

```python
from sklearn.metrics import classification_report, confusion_matrix, matthews_corrcoef
print(confusion_matrix(y_test, y_pred))
print(classification_report(y_test, y_pred, digits=3))
```

**ROC-AUC is optimistic under imbalance** because the false-positive rate has a large
denominator. Prefer PR-AUC there and say so.

## Step 4 — Pick the threshold deliberately

Most classifiers output a probability; 0.5 is a default, not a decision.

1. Plot the precision–recall trade-off across thresholds.
2. Choose the threshold from the problem's cost structure, or from a required recall
   ("we must catch 90 % of failures"), and **state the rule**.
3. Report the metric **at that threshold**, not at 0.5.
4. If the problem gives no cost information, report the full curve and say the threshold
   is a policy choice.

Reporting AUC alone hides the threshold problem entirely; a paper that does only that has
not answered "what would this system actually do".

## Step 5 — Handle imbalance the right way, in this order

1. **Do nothing**, and use the right metric — often sufficient.
2. **Class weights**: `class_weight="balanced"` (sklearn) changes the loss without
   fabricating data. Prefer this to resampling.
3. **Resampling**: SMOTE or random oversampling on the training set only. Report the
   before/after counts, and be aware SMOTE interpolates between neighbours, which is
   invalid for categorical features.
4. **Anomaly detection** instead of classification, when the minority class is genuinely
   rare and unrepresentative.

Never resample the test set. Never report an accuracy improvement from resampling without
also reporting precision and recall — resampling trades one error type for the other.

## Step 6 — Calibrate if you report probabilities

A model can rank well and still output miscalibrated probabilities (a "0.9" that happens
40 % of the time). If the paper uses the probabilities for anything beyond ranking:

```python
from sklearn.calibration import CalibratedClassifierCV
calibrated = CalibratedClassifierCV(base, method="isotonic", cv=5).fit(X_tr, y_tr)
```

Check with a reliability diagram and the Brier score. State whether probabilities are
calibrated; if they are not, use them only for ranking.

## Step 7 — Report what the model learned

- **Feature importance**: permutation importance is more trustworthy than impurity-based
  importance for correlated features; say which you used.
- **Per-class performance**, not just the aggregate — a model that is excellent on the
  majority class and useless on the minority is not a good model.
- **Decision curve / cost analysis** when the problem has explicit costs: translate the
  confusion matrix into the problem's units (missed failures, false alarms per day).

## Rules

- Never report accuracy alone on an imbalanced dataset.
- Never resample before splitting, or resample the test set at all.
- Never report AUC without the confusion matrix at a stated threshold.
- Never leave the threshold implicit when the paper's recommendation depends on it.
- Never present miscalibrated probabilities as if they were frequencies.
- Never use SMOTE on categorical features, or on time-ordered data without a temporal
  resampling scheme.
- Compare against a real baseline (`DummyClassifier` with `strategy="most_frequent"`) and
  report it — see `model-comparison`.
