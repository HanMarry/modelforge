---
name: mathmodel-figure-templates
description: Generate reproducible scientific figures from bundled MathModel templates, including model evaluation, statistical distributions, multivariate analysis, feature attribution, composition, networks, spatial grids, and time series. Use when the user invokes /mathmodel-figure-templates or requests a matching scientific chart; provides Python scripts, PNG/PDF/SVG export, previews, and data-mapping guidance.
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob
---

# MathModel Figure Templates

This skill ships with MathModel and contains ready-to-run Python/matplotlib scripts for the
figure templates available to the MathModel agent. Resolve paths relative to
the directory containing this `SKILL.md`; do not depend on a fixed home-directory or sandbox path.

## Fast Path

1. Match the requested chart in `references/figure-catalog.md`.
2. From the current project, run the renderer with the template id. Replace `<skill-directory>`
   with the actual directory containing this `SKILL.md`:

```bash
python3 "<skill-directory>/scripts/render_template.py" paired-raincloud --project "./绘图复刻"
```

3. The renderer copies the bundled template script into `绘图复刻/scripts/`, runs it there, and writes outputs to `绘图复刻/outputs/`.
4. Return the generated PNG/PDF/SVG paths and the copied script path to the user.

Use `--list` to show supported ids:

```bash
python3 "<skill-directory>/scripts/render_template.py" --list
```

## Output Contract

- Work under the current workspace unless the user gives another path.
- Default project folder: `绘图复刻`.
- Script path: `绘图复刻/scripts/make_<template>.py`.
- Outputs: `绘图复刻/outputs/<template>_replica.png`, `.pdf`, `.svg`.
- Use the bundled scripts as the first choice; edit the copied workspace script only when the user requests customization.
- The bundled scripts use deterministic simulated data. Do not claim simulated values reproduce a source study exactly.

## Complete scientific layouts

This skill contains 90 templates. The [complete layout guide](references/extended-chart-guide.md) lists 59 selected full chart layouts, including 15-panel effects with histograms, six-model marginal reports, and dense concentric heatmaps. The [catalog](references/figure-catalog.md) lists every id and preview. The [basic analysis guide](references/modeling-analysis.md) covers additional PCA and feature-attribution reports.

Bundled previews use lossless WebP at their original resolution; generated figures still export PNG/PDF/SVG.

When matching a reference image, inspect the relevant bundled preview before selecting a template. Preserve the complete panel count, arrangement, marginal plots, insets, categorical encodings, legends, colorbars, and linear/log scales. Do not silently simplify a composite chart into a single-panel approximation. The six-panel violin template uses a 2×3 arrangement. Preview numbers retain their original values after curation.

The additional standalone scripts use Python 3.10+, NumPy 2+, Matplotlib 3.8+, and SciPy 1.11+. Prefer the project environment and check installed versions before installing missing packages. No network access or external data is required for these layouts.

The guide distinguishes calculated metrics from supplied demonstration summaries. A rendered figure does not establish that a research model was trained. Use actual model outputs and measurements for analytical results, and remove the demonstration footer only after replacing every simulated input. Save the copied script together with PNG/PDF/SVG so the figure remains reproducible.

## Data-backed templates

- The SR-Weather templates copy a bundled SRTM elevation grid and Natural Earth country geometry; they require `scipy`, `cartopy`, and `shapely`.
- The Karst templates copy a southeastern-Yunnan boundary derivative, and the ESV templates copy a Ganjiang Upstream Basin boundary derivative.
- The biodiversity atlases copy a simplified Natural Earth public-domain world boundary.
- Data-backed SR-Weather, Karst, and ESV templates export TIFF in addition to PNG/PDF/SVG. Biodiversity atlases export PNG/PDF/SVG.
- Internal grids, classes, coefficients, and simulated measurements are deterministic reconstructions. Never present them as the source papers' measured values.

## When Customizing

If the user asks for changes, copy/run the nearest template first, then edit the copied file in `绘图复刻/scripts/`. Preserve:

- `MPLCONFIGDIR` before importing matplotlib.
- deterministic seeds for simulated data.
- PNG/PDF/SVG export.
- readable labels, legends, and high-DPI output.

Use `references/plot-recipes.md` for implementation patterns.
