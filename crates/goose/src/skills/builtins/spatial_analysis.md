---
name: spatial-analysis
description: 处理带地理坐标的问题。当数据含经纬度、行政区、栅格，或用户说"地图""空间分布""选址""区域差异"时使用。含 CRS 与投影选择、距离度量、IDW/Kriging 插值与交叉验证、Moran's I 与冷热点分析、选址与覆盖。
---

# Spatial Analysis

Use this skill when data carries coordinates, addresses, or administrative regions, or
when the question is about location, coverage, accessibility, or regional patterns. The
deliverable is a defined coordinate system, an appropriate distance metric, and a map
that a reader can verify.

## Requirements

```bash
uv pip install numpy pandas scipy matplotlib
uv pip install geopandas shapely      # vector data and geometry operations
uv pip install pyproj                 # coordinate transformation
uv pip install pykrige                # kriging interpolation
```

Chinese coordinate data is usually in **GCJ-02** (a.k.a. Mars coordinates) while GPS
returns **WGS-84**. They differ by tens to hundreds of metres. Convert deliberately and
say which system the final map uses.

## Step 1 — Fix coordinate systems before measuring anything

- Identify the source CRS of the data (`EPSG:4326` is lat/lon degrees). Confirm it.
- **Project before computing distances.** Degrees are not metres: one degree of longitude
  is ~111 km at the equator and ~85 km in Beijing. Compute in a projected CRS
  (e.g. UTM, or the local Gauss–Kruger / CGCS2000 zone for China):

```python
import geopandas as gpd
points = gpd.GeoDataFrame(frame, geometry=gpd.points_from_xy(frame.lon, frame.lat), crs="EPSG:4326")
projected = points.to_crs(projected_crs)          # metres
projected["area_m2"] = projected.geometry.area
```

State the source CRS, the projected CRS, and the units of every distance in the paper.

## Step 2 — Choose the distance metric to match the problem

| Situation | Metric |
|---|---|
| free movement, open area | Euclidean |
| movement along a street network | network distance (build the graph — see `graph-and-network`) |
| travel by car or public transport | travel time from a routing engine |
| accessibility / service radius | Euclidean or network buffer, **state which** |

Euclidean distance across a city with a river is wrong, and reviewers notice. If you use
Euclidean, justify it (open terrain, short radii) or state the limitation.

## Step 3 — Interpolate only when you must, and report the error

Scattered observations → continuous surface:

- **IDW** — simple, fast; the power parameter controls smoothness, so report it and show
  the sensitivity to it.
- **Kriging** — statistically principled, gives an error surface; requires fitting a
  variogram, so report the model (spherical/exponential) and its parameters.
- **Thin-plate spline / RBF** — smooth surfaces, can overshoot.

**Validate by leave-one-out cross-validation** and report RMSE/MAE in the variable's
units. An interpolated map without a validation error is decoration. Never extrapolate
far outside the observed convex hull without flagging it.

## Step 4 — Test for spatial structure rather than assuming it

- **Moran's I** (global): is there spatial autocorrelation at all? Report I, the expected
  value under randomness, and the pseudo p-value from permutation.
- **Local Moran / Getis-Ord Gi***: where are the clusters (hot spots, cold spots,
  outliers)? These give the map that belongs in the paper.
- Report the **spatial weights matrix** you used (queen/rook contiguity or k-nearest) —
  the result depends on it, and changing it is a robustness check.

If Moran's I is near zero, the honest finding is "no spatial pattern"; do not go looking
for a cluster that a different weights matrix would produce.

## Step 5 — Site selection and coverage

For "where to place facilities to cover demand":

1. Define coverage (radius or travel time) and the objective (minimise facilities,
   maximise covered demand, minimise mean travel distance).
2. Solve it as a location problem — maximal covering and p-median are integer programs;
   see `optimization-modeling` for the formulation and the optimality-gap reporting.
3. Report the **uncovered demand** explicitly, not just the coverage percentage.
4. Test robustness: how much coverage is lost if one facility is removed, and how much
   the answer moves if the coverage radius changes by ±10 %.

## Step 6 — Maps that can be checked

- Always include a scale bar, north arrow, legend, and a coordinate-grid or lat/lon label.
- Show the **projection** in the caption, since distances on the map depend on it.
- Use a perceptually uniform, colour-blind-safe palette; do not use a rainbow scale for
  a continuous variable.
- Overlay the underlying data points on any interpolated surface so the reader can see
  where evidence exists and where the map is extrapolating.

See `math-figure` for the export and caption conventions (vector PDF/SVG plus PNG).

## Rules

- Never compute distances or areas in degrees.
- Never mix CRS or datum silently; state every transformation applied.
- Never present an interpolated surface without a cross-validated error.
- Never report a hot-spot map without naming the weights matrix and the significance
  threshold.
- Never use Euclidean distance for a network-constrained problem without saying so.
- Never ignore the modifiable areal unit problem: conclusions at district level may not
  hold at city level, and the paper should say which scale the result applies to.
