#!/usr/bin/env node
/**
 * Declares which paper-template directories the preview build should compile, and
 * resolves each one's entry file.
 *
 * The templates themselves are not generated here any more. Earlier revisions of this
 * script synthesised generic `ctexart` skeletons for the contests, but real templates now
 * ship with the project (extracted from the installed MathModel product, plus three
 * vendored upstream sources), and a synthesised skeleton is not a substitute for the
 * real contest layout.
 *
 * Entry-file resolution matters because the templates do not agree on a name:
 * `paper.tex`, `main.tex` and `document.tex` all occur, and the Typst one uses
 * `paper.typ`.
 *
 * Usage: node scripts/build-paper-templates.js --list
 */
const fs = require('fs');
const path = require('path');

const TEMPLATES = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'crates',
  'goose',
  'src',
  'skills',
  'builtins',
  'math_paper',
  'assets',
  'templates'
);

/**
 * Template directories to compile.
 *
 * Explicit rather than scanned: a directory that appears here has been reviewed for
 * licence. See `NOTICE.md` for the per-template provenance table.
 */
const EXISTING_TEMPLATES = [
  // Extracted from the installed MathModel product — 14 real contest templates.
  'apmcm',
  'apmcm-en',
  'changsanjiao',
  'cumcm',
  'diangongbei',
  'dongsansheng',
  'huashubei',
  'huawei',
  'huazhong',
  'mathorcup',
  'mcm',
  'shuweibei',
  'stats',
  'wuyi',
  // Vendored upstream sources (licence verified, LICENSE retained beside them).
  'cumcm-latex',
  'jxust-latex',
  'cumcm-typst',
];

/** Directories whose entry file is Typst rather than LaTeX. */
const TYPST_DIRECTORIES = new Set(['cumcm-typst']);

/** Entry-file candidates, in preference order, per engine. */
const LATEX_ENTRIES = ['paper.tex', 'main.tex', 'document.tex'];
const TYPST_ENTRIES = ['paper.typ', 'main.typ'];

/** Every template directory the preview build should compile. */
const ALL_TEMPLATE_DIRECTORIES = EXISTING_TEMPLATES;

/** Resolves a template directory's entry file, or null when it has none. */
function resolveEntry(directory) {
  const root = path.join(TEMPLATES, directory);
  const candidates = TYPST_DIRECTORIES.has(directory) ? TYPST_ENTRIES : LATEX_ENTRIES;
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(root, candidate))) return candidate;
  }
  return null;
}

/** The engine used to compile a directory. */
function resolveEngine(directory) {
  return TYPST_DIRECTORIES.has(directory) ? 'typst' : 'xelatex';
}

function main() {
  if (!process.argv.includes('--list')) {
    console.log('Template directories are declared in this file; nothing to generate.');
    console.log('Run with --list to print the inventory.\n');
  }

  let missing = 0;
  for (const directory of ALL_TEMPLATE_DIRECTORIES) {
    if (!fs.existsSync(path.join(TEMPLATES, directory))) {
      console.log(`MISSING  ${directory}`);
      missing++;
      continue;
    }
    const entry = resolveEntry(directory);
    const engine = resolveEngine(directory);
    console.log(`${entry ? 'ok      ' : 'NO ENTRY'}${directory.padEnd(16)} ${engine.padEnd(9)} ${entry ?? ''}`);
  }
  console.log(`\n${ALL_TEMPLATE_DIRECTORIES.length} director(ies), ${missing} missing`);
  if (missing) process.exitCode = 1;
}

module.exports = {
  ALL_TEMPLATE_DIRECTORIES,
  EXISTING_TEMPLATES,
  TYPST_DIRECTORIES,
  resolveEntry,
  resolveEngine,
};

if (require.main === module) main();
