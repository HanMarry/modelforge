---
name: data-prep
description: 建模前的数据体检与清洗，并留下可复核的记录。凡是要读入数据、合并表、处理缺失或异常，或用户说"数据很脏""帮我处理数据"时先加载本技能。含缺失值分类处理、离群点定性、量纲一致性、重复与特征泄漏检查，并产出数据质量表。
---

# Data Preparation

Use this skill before any modelling. The deliverable is a documented dataset plus a
short data-quality table for the paper — not a silently cleaned frame that nobody can
reproduce.

## Requirements

```bash
uv pip install numpy pandas openpyxl
```

`openpyxl` is what lets pandas read `.xlsx`; without it `read_excel` fails.

## Step 1 — Inspect before touching

```python
import pandas as pd
frame = pd.read_excel(path, sheet_name=None)   # dict of all sheets
for name, sheet in frame.items():
    print(name, sheet.shape)
    print(sheet.dtypes)
    print(sheet.head())
```

Record for every column: name, meaning, unit, type, allowed range. Competition
attachments frequently hide extra sheets, merged header rows, and units in the header
text — read the sheet list, do not assume the first sheet is the data.

Write this schema into the paper's data section. It is cheap and reviewers look for it.

## Step 2 — Missing values

Classify before filling:

| Pattern | Reasonable handling |
|---|---|
| Missing completely at random, few rows | drop the rows and report how many |
| Missing at random, related to another column | conditional imputation (group mean/median) |
| Time series gap | forward fill or interpolate — and say the gap existed |
| Missing because it means zero | fill 0, only if the problem says so |
| Large fraction missing (>30%) | drop the column; imputing most of a column invents data |

Never fill with the global mean when the data is grouped — it flattens real
between-group differences.

Report the missing count per column **before and after**. A table of "how much was
missing and what you did" is expected.

## Step 3 — Outliers

Decide which kind each outlier is, because the treatments differ:

- **Data-entry error** (impossible value, e.g. negative height): fix or drop, and say so.
- **Measurement noise**: winsorise or use a robust statistic.
- **Genuine extreme event**: keep it. Removing a real extreme because it is inconvenient
  changes the answer the problem is asking about.

Detect with the IQR rule or a z-score, then **report how many points were affected** and
whether conclusions change when they are retained. Present results both ways when the
outliers are borderline.

## Step 4 — Duplicates and consistency

- Exact duplicate rows: usually drop, but a duplicate in a transaction log may be real.
- Contradictory duplicates (same key, different value): these are a finding — report them.
- Unit consistency: check for mixed units within one column (km and m in the same column
  is common in real attachments).
- Categorical typos: `"北京"` vs `"北京市"` — normalise and list the mapping used.
- Date parsing: verify the assumed format; `03/04/2024` is ambiguous.

## Step 5 — Feature construction, without leakage

- Derive features from the problem's variables (rates, ratios, lags), not from the target.
- **Check for leakage**: a feature computed using the target, or using future
  information relative to a time-ordered split, will produce a beautiful model that
  fails on new data.
- Scale after splitting, fitting the scaler on the training set only.

## Step 6 — Split and freeze

- Split before fitting anything that learns parameters.
- For time series split strictly by time, never randomly.
- Fix the random seed, and write the exact cleaning script to `code/` so the paper's
  numbers can be regenerated from the raw attachment.

## Output: the data-quality table

```markdown
| Column | Meaning | Unit | Type | Missing (before → after) | Outliers | Treatment |
|---|---|---|---|---|---|---|
| T | 温度 | °C | float | 12 → 0 | 3 | 组内中位数填充 |
```

This table is what makes the rest of the paper credible. Adapt the header language to
the paper's language.

## Rules

- Never fabricate or silently impute data; every filled cell must be explainable.
- Never drop rows without reporting how many and why.
- Never scale or impute using the full dataset before splitting.
- Never let a derived feature see the target or the future.
- Keep the raw attachment untouched; write cleaned output to a separate file.
