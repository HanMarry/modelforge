#!/usr/bin/env node
/**
 * Renders every extracted MathModel figure template once and copies the resulting PNG
 * into the renderer's asset folder, so the gallery shows what this build actually
 * produces rather than the cached previews shipped in the app bundle.
 *
 * Usage:
 *   node scripts/build-mathmodel-figures.js [--force] [--only <id>]
 *
 * Requires `uv` (the templates import scipy, and eight spatial ones also need
 * cartopy/shapely). Templates whose dependencies are unavailable are reported and
 * skipped rather than failing the whole build.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DESKTOP = path.join(__dirname, '..');
/** The MathModel templates are a skill of their own since the content extraction. */
const TEMPLATES = path.join(
  DESKTOP,
  '..',
  '..',
  'crates',
  'goose',
  'src',
  'skills',
  'builtins',
  'mathmodel_figure_templates'
);
const SCRIPTS = path.join(TEMPLATES, 'scripts', 'templates');
const RENDERER = path.join(TEMPLATES, 'scripts', 'render_template.py');
const ASSETS = path.join(DESKTOP, 'src', 'assets', 'figures', 'mathmodel');

/** Packages the templates import beyond the standard library. */
const CORE_PACKAGES = ['matplotlib', 'numpy', 'scipy'];
const SPATIAL_PACKAGES = ['cartopy', 'shapely'];

function templateIds() {
  return fs
    .readdirSync(SCRIPTS)
    .filter((name) => name.startsWith('make_') && name.endsWith('.py'))
    .map((name) => name.slice('make_'.length, -'.py'.length));
}

function needsSpatialStack(id) {
  const source = fs.readFileSync(path.join(SCRIPTS, `make_${id}.py`), 'utf8');
  return /\bcartopy\b|\bshapely\b/.test(source);
}

function main() {
  const force = process.argv.includes('--force');
  const onlyIndex = process.argv.indexOf('--only');
  const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : null;

  const hasUv = (() => {
    try {
      execFileSync('where', ['uv'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  if (!hasUv) {
    console.error('uv is required to render the figure templates (https://docs.astral.sh/uv/)');
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(ASSETS, { recursive: true });
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mathmodel-figs-'));

  let built = 0;
  let skipped = 0;
  let failed = 0;

  for (const id of templateIds()) {
    if (only && id !== only) continue;

    const target = path.join(ASSETS, `${id}.png`);
    if (!force && fs.existsSync(target)) {
      console.log(`up to date ${id}`);
      continue;
    }

    const project = path.join(workRoot, id);
    const packages = needsSpatialStack(id) ? [...CORE_PACKAGES, ...SPATIAL_PACKAGES] : CORE_PACKAGES;
    const args = ['run', '--no-project'];
    for (const pkg of packages) args.push('--with', pkg);
    args.push('python', RENDERER, id, '--project', project, '--overwrite');

    try {
      execFileSync('uv', args, {
        cwd: TEMPLATES,
        stdio: 'pipe',
        encoding: 'utf8',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
    } catch (error) {
      const log = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      // Missing cartopy/shapely is an environment limitation, not a broken template.
      if (/No module named '(cartopy|shapely)'/.test(log)) {
        console.log(`skip     ${id} (spatial stack unavailable)`);
        skipped++;
        continue;
      }
      // cartopy publishes no prebuilt wheel for this platform, so `uv` tries to build it
      // from source and needs MSVC. Also an environment limitation: the template is fine.
      // The message is wrapped across lines, so match on the URL rather than the sentence.
      if (/visualstudio\.microsoft\.com\/visual-cpp-build-tools/.test(log)) {
        console.log(`skip     ${id} (cartopy needs the MSVC build tools)`);
        skipped++;
        continue;
      }
      failed++;
      console.error(`FAILED   ${id}:`);
      console.error(log.split('\n').filter(Boolean).slice(-4).join('\n'));
      continue;
    }

    const produced = path.join(project, 'outputs', `${id}_replica.png`);
    if (!fs.existsSync(produced)) {
      failed++;
      console.error(`FAILED   ${id}: renderer produced no PNG`);
      continue;
    }

    fs.copyFileSync(produced, target);
    const kb = Math.round(fs.statSync(target).size / 1024);
    console.log(`built    ${id} (${kb} KB)`);
    built++;
  }

  fs.rmSync(workRoot, { recursive: true, force: true });
  console.log(`\n${built} rendered, ${skipped} skipped, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

if (require.main === module) main();
