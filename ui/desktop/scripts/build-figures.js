#!/usr/bin/env node
/**
 * Runs every figure template and produces its preview image.
 *
 * Each template writes its own PDF and PNG, so this script simply drives them with
 * an output path inside the app, then copies the PNG into the repo tree next to the
 * script. Result:
 *
 *   crates/.../math_figure/assets/templates/<category>/<name>.pdf   (vector, skill asset)
 *   crates/.../math_figure/assets/templates/<category>/<name>.png   (preview, skill asset)
 *   ui/desktop/src/assets/figures/<category>/<name>.png             (gallery thumbnail)
 *
 * The previews are generated artefacts: re-run this instead of editing them, and
 * re-run it after changing a template.
 *
 * Requires `uv` on PATH; matplotlib is resolved by uv, no environment to prepare.
 *
 * Usage: node scripts/build-figures.js [--force]
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DESKTOP = path.join(__dirname, '..');
const TEMPLATES = path.join(
  DESKTOP,
  '..',
  '..',
  'crates',
  'goose',
  'src',
  'skills',
  'builtins',
  'math_figure',
  'assets',
  'templates'
);
const ASSETS = path.join(DESKTOP, 'src', 'assets', 'figures');

/** Template scripts, relative to the templates directory. */
const TEMPLATES_TO_BUILD = [
  'model-evaluation/roc_cross_validation.py',
  'model-evaluation/sensitivity_curves.py',
  'model-evaluation/model_radar.py',
  'model-evaluation/metric_heatmap.py',
  'combination/correlation_combined.py',
  'distribution/paired_distributions.py',
  'distribution/data_overview.py',
  'machine-learning/feature_importance_beeswarm.py',
  'spatial/response_surface_3d.py',
  'flowchart/five_band_roadmap.py',
  'flowchart/three_stage_pipeline.py',
  'flowchart/three_column_framework.py',
  'flowchart/hierarchical_structure.py',
  'flowchart/horizontal_pipeline.py',
];

function hasUv() {
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const force = process.argv.includes('--force');

  if (!fs.existsSync(TEMPLATES)) {
    console.error(`Templates directory not found: ${TEMPLATES}`);
    process.exitCode = 1;
    return;
  }
  if (!hasUv()) {
    console.error(
      'uv is required to run the templates (it resolves matplotlib): https://docs.astral.sh/uv/'
    );
    process.exitCode = 1;
    return;
  }

  let built = 0;
  for (const relative of TEMPLATES_TO_BUILD) {
    const script = path.join(TEMPLATES, relative);
    if (!fs.existsSync(script)) {
      console.log(`skip     ${relative} (not present)`);
      continue;
    }

    const base = relative.replace(/\.py$/, '');
    const repoPdf = path.join(TEMPLATES, `${base}.pdf`);
    const repoPng = path.join(TEMPLATES, `${base}.png`);
    const appPng = path.join(ASSETS, `${base}.png`);

    if (!force && fs.existsSync(appPng)) {
      console.log(`up to date ${relative}`);
      continue;
    }

    try {
      // The template writes <base>.pdf and <base>.png next to itself.
      execFileSync('uv', ['run', '--no-project', '--with', 'matplotlib', 'python', script, '-o', repoPdf], {
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch (error) {
      console.error(`FAILED   ${relative}`);
      const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
      if (output) console.error(output.split('\n').slice(-12).join('\n'));
      process.exitCode = 1;
      continue;
    }

    if (!fs.existsSync(repoPng)) {
      console.error(`FAILED   ${relative}: template did not write ${path.basename(repoPng)}`);
      process.exitCode = 1;
      continue;
    }

    // Only the PNG goes into the renderer bundle; PDFs stay with the skill.
    fs.mkdirSync(path.dirname(appPng), { recursive: true });
    fs.copyFileSync(repoPng, appPng);

    const size = fs.statSync(appPng).size;
    console.log(`built    ${relative} -> ${path.relative(DESKTOP, appPng)} (${size} bytes)`);
    built++;
  }

  console.log(`\n${built} template(s) built`);
}

if (require.main === module) main();
