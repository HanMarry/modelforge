---
name: clustering-analysis
description: 对无标签数据分群并论证分群合理。当问题是"分群""聚类""划分等级""客户分群"时使用。含先标准化并说明距离度量、k 的多个判据（肘部/轮廓/CH/DB）、按簇形状选算法、稳定性检验与零模型对比、簇画像表，以及下游使用时的信息泄漏。
---

# Clustering Analysis

Use this skill when there are no labels and the task is to find groups. The deliverable is
a clustering plus **evidence that the groups are real** — clustering algorithms always
return clusters, even on noise.

## Requirements

```bash
uv pip install numpy pandas scikit-learn scipy matplotlib
uv pip install scikit-learn-extra    # optional: k-medoids
```

## Step 1 — Scale and pick a distance, and justify both

- **Scale features** (standardise or min-max). K-means minimises Euclidean distance, so an
  unscaled variable in the thousands dominates one in the decimals and the clustering
  becomes "cluster by that one variable".
- Choose the metric to match the data: Euclidean for continuous comparable features,
  Manhattan for robustness to outliers, cosine for text or normalised vectors, Gower for
  mixed numeric/categorical.
- For categorical data, use k-modes or Gower — **K-means on one-hot encoding distorts the
  distance** (a binary variable becomes two columns and counts twice).

State the scaling, the metric and why. These two choices determine the result more than
the algorithm does.

## Step 2 — Standardise before comparing, then choose k with evidence

```python
from sklearn.preprocessing import StandardScaler
X_scaled = StandardScaler().fit_transform(X)
```

Then use **several** signals, not one:

| Method | What it tells you |
|---|---|
| Elbow (inertia vs k) | where added clusters stop buying much |
| Silhouette score | separation vs cohesion, per point and overall |
| Gap statistic | compared against a null reference |
| Calinski–Harabasz / Davies–Bouldin | alternative internal indices |
| Domain meaning | whether the groups correspond to something real |

Report the plot and the chosen k with the reason. **The elbow is often ambiguous** —
if your choice rests on it alone, say so.

```python
from sklearn.metrics import silhouette_score, davies_bouldin_score, calinski_harabasz_score
```

## Step 3 — Match the algorithm to the cluster shape you expect

| Expectation | Algorithm |
|---|---|
| Roughly spherical, similar size | K-means |
| Overlapping, probabilistic membership | Gaussian mixture |
| Arbitrary shape, noise present | DBSCAN / HDBSCAN |
| Hierarchical structure of interest | agglomerative (Ward) + dendrogram |
| Medoids (a real sample per cluster) | k-medoids / PAM |
| Density-varying | HDBSCAN |

K-means assumes convex, similarly-sized clusters. If the scatter plot shows elongated or
nested groups, K-means will split them arbitrarily — pick a density method and say why.

## Step 4 — Validate the clusters are not artefacts

- **Silhouette per point**: look at the distribution, not just the mean. A good mean with
  many negative values means many points are in the wrong cluster.
- **Stability**: cluster bootstrap resamples (or different seeds) and measure how often
  pairs of points stay together (e.g. adjusted Rand index between runs). Unstable
  clusters are not a finding.
- **Against a null**: compare your silhouette to the distribution from shuffled data. If
  the real data is not clearly better, there is no structure to find — report that.
- **Check cluster sizes**: a "cluster" of 3 points among 300 is usually an outlier group,
  not a segment.

## Step 5 — Interpret and profile the clusters

A cluster label is useless on its own. Characterise each one:

```markdown
| 簇 | 样本数 | 温度(均值) | 压力(均值) | 产量(均值) | 与整体的差异 |
|---|---|---|---|---|---|
| C1 | 120 | 85.2 (+1.1σ) | 1.02 (-0.3σ) | 42.1 (+0.9σ) | 高温高产出 |
```

Then name them descriptively ("高温高产出组"), and say what the grouping implies for the
problem. If two clusters differ only on a variable you scaled heavily, that is an artefact
of the scaling — check and report.

## Step 6 — Use the clusters downstream if the problem needs it

If clusters feed a later model, keep the split honest:

- Fit the clustering on the **training** data only, then assign test points by nearest
  centroid (or the model's predict) — refitting on all data leaks information.
- Report downstream performance with the clustering step inside the cross-validation, not
  before it.

## Rules

- Never cluster unscaled features without saying so, and never present the result as
  meaningful when one variable dominates.
- Never claim k was determined by the elbow alone without noting the ambiguity.
- Never present clusters without a stability check or a null comparison.
- Never name a cluster by its id; give it a descriptive label derived from the profile.
- Never use K-means on categorical data or on one-hot encodings without acknowledging the
  distance distortion.
- Never treat a cluster of outliers as a discovered segment.
- Report the algorithm, the metric, the scaling, k, and the validation indices — all five.
