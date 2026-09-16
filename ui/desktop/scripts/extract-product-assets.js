#!/usr/bin/env node
/**
 * Extracts content from an installed MathModel desktop app into this repository.
 *
 * The app ships real content we should reuse rather than re-author: figure templates,
 * competition paper templates, the draw.io diagram toolkit, the literature/data/doctor
 * scripts, the skill-creator pack, and the bundled example problems. Hand-written
 * equivalents are never quite the same thing, so where the real file exists we take it.
 *
 * What is deliberately NOT copied unless asked for:
 *
 *  - **Embedded fonts** (`*.ttf`, `*.ttc`, `*.otf`) — roughly 118 MB of KaiTi, SimSun,
 *    SimHei, FangZheng and other proprietary Chinese typefaces whose licences do not
 *    permit redistribution. Pass `--include-fonts` for a local tree that needs them.
 *  - **Contest statements and attachments** (`resources/builtin-examples/`) — the
 *    organisers' copyrighted material. Pass `--include-examples` to copy them for local
 *    use; `NOTICE.md` records that they are not licensed for redistribution.
 *
 * Usage:
 *   node scripts/extract-product-assets.js --app "<install dir>" [--dry-run]
 *     [--include-fonts] [--include-examples] [--only <label>]
 */
const fs = require('fs');
const path = require('path');

const DESKTOP = path.join(__dirname, '..');
const BUILTINS = path.join(DESKTOP, '..', '..', 'crates', 'goose', 'src', 'skills', 'builtins');

/** Font extensions that are proprietary in this product and must not be redistributed. */
const FONT_EXTENSIONS = new Set(['.ttf', '.ttc', '.otf', '.woff', '.woff2']);

/** Paths skipped entirely, with the reason. */
const SKIP_DIRECTORIES = [
  { match: /[\\/]node_modules([\\/]|$)/, reason: 'not an asset' },
  { match: /[\\/]__pycache__([\\/]|$)/, reason: 'build artefact' },
  { match: /[\\/]\.git([\\/]|$)/, reason: 'not an asset' },
];

/**
 * Files the product ships but this fork cannot honour, so they are left out rather than
 * copied as decoration.
 */
const SKIP_FILES = [
  {
    match: /(^|[\\/])SKILL\.md$/,
    reason: 'skill bodies are adopted into a top-level <stem>.md by hand, so the copy inside the asset folder would be dead weight',
  },
  {
    // Re-extracting would silently drop them, so the file is left alone once it exists.
    match: /[\\/]doctor[\\/]references[\\/]install\.md$/,
    reason: 'local additions are appended to this file (cartopy/MSVC, fonts, uv index) — delete it first for a pristine copy',
  },
];

/**
 * What to copy: `from` is relative to the app's `resources/`, `to` is relative to the
 * repository's builtins directory (`resources` may be omitted by using `fromSkills`).
 */
const JOBS = [
  {
    label: 'figure templates',
    fromSkills: 'mathmodel-figure-templates',
    to: 'mathmodel_figure_templates',
    note: '90 templates, 4 reference guides, Natural Earth geometry, and the 90 bundled previews',
  },
  {
    label: 'paper templates',
    fromSkills: 'mma-paper/assets/template',
    to: 'math_paper/assets/templates',
    note: '14 real contest templates (fonts handled separately)',
  },
  {
    label: 'diagram toolkit',
    fromSkills: 'paper-diagram',
    to: 'paper_diagram',
    note: '5 layout templates with content JSON, 8 Python scripts, 11 references, Tabler icons',
  },
  {
    label: 'doctor skill',
    fromSkills: 'doctor',
    to: 'doctor',
    note: 'check_environment.py + install guide; SKILL.md body adopted separately',
  },
  {
    label: 'paper-search skill',
    fromSkills: 'paper-search',
    to: 'paper_search',
    note: 'the product’s paper_search.py (search / verify / bib)',
  },
  {
    label: 'data-search skill',
    fromSkills: 'data-search',
    to: 'data_search',
    note: 'record_source.py, source routing, agent manifest',
  },
  {
    label: 'skill-creator',
    fromSkills: 'skill-creator',
    to: 'skill_creator',
    note: 'SKILL.md + 3 scripts + 2 references, carries its own LICENSE.txt',
  },
  {
    label: 'metaheuristic skill',
    fromSkills: 'metaheuristic-optimization',
    to: 'metaheuristic_optimization',
    note: 'agent manifest for the MEALPY skill',
  },
  {
    label: 'example problems',
    from: 'builtin-examples',
    to: 'math_modeling/assets/examples',
    optionalFlag: 'includeExamples',
    note: 'three real contest problem sets (statements, attachments, results)',
  },
  {
    label: 'pdf viewer',
    from: 'pdfjs',
    to: '../ui/desktop/vendor/pdfjs',
    note: 'the PDF.js build the product previews papers with (Apache-2.0); not wired into a viewer yet',
  },
];

function shouldSkip(filePath) {
  for (const rule of SKIP_DIRECTORIES) {
    if (rule.match.test(filePath)) return rule.reason;
  }
  for (const rule of SKIP_FILES) {
    if (rule.match.test(filePath)) return rule.reason;
  }
  if (FONT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return 'proprietary font — cannot redistribute';
  }
  return null;
}

function copyTree(source, target, state, options) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);

    const skip = shouldSkip(from);
    if (skip) {
      if (skip.startsWith('proprietary font') && options.includeFonts) {
        // explicitly requested: copy anyway, and say so in the report
        state.fonts.push(to);
      } else {
        state.skipped.push({ path: from, reason: skip });
        continue;
      }
    }

    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyTree(from, to, state, options);
    } else {
      state.copied.push(to);
      state.bytes += fs.statSync(from).size;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

function main() {
  const appIndex = process.argv.indexOf('--app');
  const app = appIndex >= 0 ? process.argv[appIndex + 1] : null;
  const dryRun = process.argv.includes('--dry-run');
  const onlyIndex = process.argv.indexOf('--only');
  const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : null;
  const options = {
    includeFonts: process.argv.includes('--include-fonts'),
    includeExamples: process.argv.includes('--include-examples'),
  };

  if (!app) {
    console.error('usage: node scripts/extract-product-assets.js --app "<install dir>" [--dry-run]');
    process.exitCode = 1;
    return;
  }

  const resources = path.join(app, 'resources');
  const skillsRoot = path.join(resources, 'builtin-skills');
  if (!fs.existsSync(skillsRoot)) {
    console.error(`builtin-skills not found under ${skillsRoot}`);
    process.exitCode = 1;
    return;
  }

  let totalFiles = 0;
  let totalBytes = 0;

  for (const job of JOBS) {
    if (only && job.label !== only) continue;
    if (job.optionalFlag && !options[job.optionalFlag]) {
      console.log(`skipped   ${job.label.padEnd(18)} (pass --${job.optionalFlag.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} to include)`);
      continue;
    }

    const source = job.fromSkills
      ? path.join(skillsRoot, job.fromSkills)
      : path.join(resources, job.from);
    const target = path.join(BUILTINS, job.to);

    if (!fs.existsSync(source)) {
      console.error(`MISSING   ${job.label}: ${source}`);
      process.exitCode = 1;
      continue;
    }

    const state = { copied: [], skipped: [], fonts: [], bytes: 0 };
    if (!dryRun) fs.mkdirSync(target, { recursive: true });
    copyTree(source, target, state, options);

    totalFiles += state.copied.length;
    totalBytes += state.bytes;

    console.log(
      `${dryRun ? 'would copy' : 'copied    '} ${job.label.padEnd(18)} ` +
        `${String(state.copied.length).padStart(4)} files, ` +
        `${(state.bytes / 1024 / 1024).toFixed(1).padStart(6)} MB -> ${job.to}`
    );
    if (job.note) console.log(`           ${job.note}`);
    if (state.fonts.length) {
      console.log(`           ⚠ included ${state.fonts.length} proprietary font file(s) as requested`);
    }
    if (state.skipped.length) {
      // Match the font reason exactly: other reasons mention fonts in passing
      // ("… cartopy/MSVC, fonts, uv index"), which used to be counted as font files.
      const fonts = state.skipped.filter((s) => s.reason.startsWith('proprietary font')).length;
      const bodies = state.skipped.filter((s) => s.reason.includes('SKILL.md')).length;
      const other = state.skipped.length - fonts - bodies;
      console.log(
        `           skipped ${state.skipped.length}: ${fonts} font file(s), ` +
          `${bodies} skill body/bodies, ${other} other`
      );
    }
  }

  console.log(
    `\n${dryRun ? 'would copy' : 'copied'} ${totalFiles} file(s), ` +
      `${(totalBytes / 1024 / 1024).toFixed(1)} MB in total`
  );

  if (!options.includeFonts) {
    console.log('\nfonts skipped — the product bundles ~118 MB of proprietary Chinese typefaces.');
    console.log('pass --include-fonts only for a local tree that will not be redistributed.');
  }
  if (!options.includeExamples) {
    console.log('\nbuiltin-examples skipped — contest statements are the organisers’ copyright.');
    console.log('pass --include-examples for local use; see NOTICE.md before distributing.');
  }
}

if (require.main === module) main();
