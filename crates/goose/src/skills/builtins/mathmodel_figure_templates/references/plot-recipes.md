# Plot Recipes

Use bundled scripts first. These notes are only for customization after a template has been copied into the workspace.

- SHAP composite: stacked horizontal mean-absolute importance bars plus class/model beeswarm strips and a feature-value colorbar.
- Paired raincloud: half-violins, jittered observations, box geometry, mean diamonds, and connected mean trends.
- ROC with CI: fold curves interpolated to a shared FPR grid, mean curve, standard-deviation band, AUC mean ± sd legend, and diagonal baseline.
- Taylor diagram: polar coordinates with angle `arccos(correlation)` and radius as model standard deviation.
- Correlation grid: lower scatter/fitted CI, diagonal histograms, upper coefficient cells with diverging colors and stars.
- Prediction marginal grid: predicted-vs-actual scatter plus top/right histograms and KDE-like curves.
- 3D tuning surface: `mpl_toolkits.mplot3d`, smooth response surface, colorbar, and checked camera angle.
- Split violin + correlation matrix: signed lower-triangle marker matrix plus left/right half-violin distribution comparison.
- Circular heatmap: polar bars, flipped outer labels, central legend, and ring-specific color scales.
- Chord diagram: outer `Wedge` sectors and translucent Bezier `PathPatch` ribbons.
- Urban cooling composite: stacked city bars, raincloud metric panels, city legend, and boxplots with connected means.
- Diurnal LST atlas: repeated raster-map panels, shared discrete temperature keys, and compact ridgeline distributions.
- Morphology–temperature small multiples: stable row/column semantics, shared seasonal colors, fitted linear or nonlinear response curves, and simulated uncertainty where applicable.
- Feature-importance bubble grid: encode model contribution with both marker size and color while keeping daytime/nighttime grouping explicit.
- SHAP interaction composite: conditional dependence panels with per-panel color variables and aligned zero-reference lines.
- Prediction comparison grid: train/test scatter panels, 1:1 reference lines, direct metric labels, and consistent model ordering.
- Spatial model-evaluation atlas: one column per method, metric-specific shared color scales, geographic context panels, and direct aggregate labels.
- Weather downscaling atlas: coarse-to-fine seasonal rows, consistent geographic extents, method columns, shared temperature scales, and city-scale zoom groups.
- ES-to-SDG Sankey: stable left/middle/right node ordering, normalized ribbon thickness, explicit goal colors, and direct level labels.
- Land-use scenario map: deterministic classified rasters clipped to a public boundary, fixed categorical colors, repeated map/inset grammar, and a shared legend.
- Ecosystem-service atlas: metric columns, historical/scenario rows, per-metric continuous color scales, shared boundary clipping, and compact row titles.
- Hotspot scenario map: continuous total-index maps paired with a symmetric seven-class Getis–Ord Gi* palette, scenario-aligned columns, a shared north arrow, and a scale bar.
- Gridded ESV zone atlas: clip square cells to a public multi-county boundary, keep a fixed five-class palette across years, repeat compact legends after alternating panels, and preserve editable grid and county vectors.
- Local Moran scenario map: standardize a continuous field, compute rook-neighbor spatial lags, encode the four Moran quadrants plus a pale non-significant class, and keep cross-quadrant cells sparse.
- SHAP decision heatmaps: align one model-output trace with a clustered feature-by-instance diverging heatmap, add a compact mean-absolute-importance strip, and use one color scale per cohort.
- PDP interaction grid: align three marginal-response curves above three pairwise contour maps; preserve rug marks, shared response semantics, contour labels, and separate vertical colorbars.
- Global delta atlas: combine Natural Earth boundaries, deterministic forest-grid points, a latitude profile, and three zone-specific histogram/KDE panels.
- Global correlation atlas: combine a global diverging correlation map, a latitude profile, and three paired horizontal coefficient panels with consistent sign colors.
