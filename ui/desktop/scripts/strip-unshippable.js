#!/usr/bin/env node
/**
 * Turns this tree from a *testing* build into a *distributable* one.
 *
 * The operator's requirement was that nothing from the installed product be lost, so that
 * tests run against the real content. That means the tree currently contains material that
 * cannot be redistributed:
 *
 *   fonts     29 proprietary Chinese typefaces bundled by the product's paper templates
 *             (KaiTi, SimSun, SimHei, LiSu, FangZheng, YaHei.Consolas, MONACO, …)
 *   examples  three contest problem sets — statements, attachments and result files are
 *             the organisers' copyright
 *   templates paper templates whose class files declare no licence at all
 *
 * Nothing here is deleted unless `--write` is passed: the default run is a manifest.
 *
 * Usage:
 *   node scripts/strip-unshippable.js            # show what would go
 *   node scripts/strip-unshippable.js --write    # actually remove it
 *
 * After stripping, regenerate what depended on it:
 *   pnpm run papers:catalog && pnpm run figures:catalog && pnpm run docs:check
 */
const fs = require('fs');
const path = require('path');
const { assertSafeRemoval } = require('./strip-safety');

const DESKTOP = path.join(__dirname, '..');
const REPO = path.join(DESKTOP, '..', '..');
const BUILTINS = path.join(REPO, 'crates', 'goose', 'src', 'skills', 'builtins');
const TEMPLATES = path.join(BUILTINS, 'math_paper', 'assets', 'templates');

const FONT_EXTENSIONS = new Set(['.ttf', '.ttc', '.otf', '.woff', '.woff2']);

/**
 * Paper templates classified by what their class file declares. `keep` is the set that
 * carries a redistributable licence; everything else goes unless the operator decides
 * otherwise. Mirrors the audit table in NOTICE.md.
 */
const TEMPLATE_LICENCES = {
  // LPPL 1.3+ declared in the class file
  changsanjiao: 'LPPL 1.3+',
  diangongbei: 'LPPL 1.3+',
  dongsansheng: 'LPPL 1.3+',
  mcm: 'LPPL 1.3+',
  shuweibei: 'LPPL 1.3+',
  // vendored from upstream repositories, LICENSE retained
  'cumcm-latex': 'MIT (vendored)',
  'jxust-latex': 'MIT (vendored)',
  'cumcm-typst': 'Apache-2.0 (vendored)',
  // no licence declared anywhere in the class file
  apmcm: 'none declared',
  'apmcm-en': 'none declared',
  cumcm: 'none declared',
  huawei: 'none declared',
  huazhong: 'none declared',
  wuyi: 'none declared',
  stats: 'none declared',
  huashubei: 'upstream repo declares no licence',
  mathorcup: 'upstream repo declares no licence',
};

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function collect() {
  const removals = [];

  // 1. Proprietary fonts inside the paper templates.
  for (const file of walk(TEMPLATES)) {
    if (FONT_EXTENSIONS.has(path.extname(file).toLowerCase())) {
      removals.push({ kind: 'font', file });
    }
  }

  // 2. Contest statements, attachments and results.
  for (const file of walk(path.join(BUILTINS, 'math_modeling', 'assets', 'examples'))) {
    removals.push({ kind: 'contest material', file });
  }

  // 3. Paper templates with no declared licence.
  for (const [directory, licence] of Object.entries(TEMPLATE_LICENCES)) {
    if (licence !== 'none declared' && !licence.includes('declares no licence')) continue;
    for (const file of walk(path.join(TEMPLATES, directory))) {
      removals.push({ kind: `template (${licence})`, file });
    }
  }

  return removals;
}

function main() {
  const write = process.argv.includes('--write');
  const removals = collect();

  const byKind = new Map();
  for (const item of removals) {
    byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
  }

  console.log(
    `${write ? 'removing' : 'would remove'} ${removals.length} file(s) that cannot be redistributed:\n`
  );
  for (const [kind, count] of [...byKind.entries()].sort()) {
    console.log(`  ${String(count).padStart(4)}  ${kind}`);
  }

  const kept = Object.entries(TEMPLATE_LICENCES).filter(
    ([, licence]) => licence !== 'none declared' && !licence.includes('declares no licence')
  );
  console.log(`\npaper templates kept (${kept.length}):`);
  for (const [directory, licence] of kept) console.log(`  ${directory.padEnd(16)} ${licence}`);

  if (!write) {
    console.log('\nnothing was deleted — pass --write to apply.');
    return;
  }

  const revision = assertSafeRemoval(REPO, removals.map((item) => item.file));
  console.log(`Recovery revision: ${revision}. Removed files can be restored from this commit.`);
  for (const item of removals) {
    fs.rmSync(item.file, { force: true });
  }

  // Drop directories that are now empty (fonts/, texfile/ of removed templates, …).
  const prune = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) prune(path.join(dir, entry.name));
    }
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  };
  prune(TEMPLATES);

  console.log(
    `\nremoved ${removals.length} file(s). Now regenerate:\n` +
      '  pnpm run papers:catalog && pnpm run papers:build && pnpm run docs:check && node scripts/check-skills.js'
  );
}

if (require.main === module) main();
