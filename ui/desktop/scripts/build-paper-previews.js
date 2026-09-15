#!/usr/bin/env node
const { ALL_TEMPLATE_DIRECTORIES, resolveEntry, resolveEngine } = require('./build-paper-templates.js');

/**
 * Compiles every paper template and produces a first-page preview.
 *
 * Output: `ui/desktop/src/assets/papers/<dir>.png` for each template, and nothing else —
 * the skill's template folders are left exactly as they are on disk.
 *
 * Compiling here is the point: a paper skeleton that has never been run through xelatex
 * is a guess. If a template fails to compile, this script fails loudly with the LaTeX
 * error log instead of shipping a broken template.
 *
 * The compile runs in a throwaway copy of the template under the OS temp directory.
 * Earlier versions compiled in place, which left the produced PDF, `missfont.log` and a
 * duplicate `preview.png` inside `math_paper/assets/templates/<dir>/`. That is wrong for
 * assets the agent copies into a user project: the folder is a *source* template, a stale
 * `main.pdf` next to it invites the agent (and the user) to think the paper is already
 * written, and everything under that path is bundled into the binary by `include_dir!`
 * (3.2 MB of PDFs). The product's own template folders contain no build output either.
 *
 * Requires: xelatex and pdftoppm on PATH (TeX Live on Windows:
 *   E:\texlive2024\texlive\2024\bin\windows).
 *
 * Usage: node scripts/build-paper-previews.js [--force] [--only <dir>]
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
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
  'math_paper',
  'assets',
  'templates'
);
const ASSETS = path.join(DESKTOP, 'src', 'assets', 'papers');

/** Directories that hold a compilable paper skeleton (shared with the generator). */
const PAPER_DIRECTORIES = ALL_TEMPLATE_DIRECTORIES;

/**
 * Template directories whose entry file is Typst (`paper.typ`) rather than LaTeX
 * (`paper.tex`). Typst compiles in a single pass and needs no auxiliary cleanup.
 */
const TYPST_DIRECTORIES = new Set(['cumcm-typst']);

/**
 * The typst CLI is not required: when it is missing, Typst templates are reported as
 * skipped and the LaTeX ones still build. Resolution (not `--version`) is used because
 * some CLI builds exit non-zero for version probes.
 */
function findTypst() {
  const candidates = [
    process.env.TYPST,
    'typst',
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? '', 'modelforge-tools', 'typst-x86_64-pc-windows-msvc', 'typst.exe')
      : null,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'pipe', encoding: 'utf8' });
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Availability check by resolution rather than by running the tool: `pdftoppm
 * --version` exits non-zero on the Windows TeX Live build even though it works.
 */
function hasCommand(command) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** First `preview(-<page>).png` in a directory, or null. */
function findRenderedPreview(directory) {
  const rendered = fs
    .readdirSync(directory)
    .filter((name) => /^preview(-\d+)?\.png$/.test(name))
    .map((name) => path.join(directory, name))
    .sort()[0];
  return rendered ?? null;
}

function main() {
  const force = process.argv.includes('--force');
  const onlyIndex = process.argv.indexOf('--only');
  const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : null;

  if (!hasCommand('xelatex')) {
    console.error('xelatex is required to compile the paper templates (install TeX Live).');
    process.exitCode = 1;
    return;
  }
  if (!hasCommand('pdftoppm')) {
    console.error('pdftoppm is required to render the previews (part of poppler / TeX Live).');
    process.exitCode = 1;
    return;
  }

  const typst = findTypst();
  if (!typst) {
    console.log('typst CLI not found — Typst templates will be skipped (set TYPST=<path> to enable)');
  }

  let compiled = 0;
  let failed = 0;

  for (const directory of PAPER_DIRECTORIES) {
    if (only && directory !== only) continue;

    const root = path.join(TEMPLATES, directory);
    const entry = resolveEntry(directory);
    const isTypst = resolveEngine(directory) === 'typst';
    if (!entry) {
      console.log(`skip     ${directory} (no LaTeX or Typst entry file)`);
      continue;
    }
    if (isTypst && !typst) {
      console.log(`skip     ${directory} (typst CLI unavailable)`);
      continue;
    }

    const appPreview = path.join(ASSETS, `${directory}.png`);

    if (!force && fs.existsSync(appPreview)) {
      console.log(`up to date ${directory}`);
      continue;
    }

    // Compile a throwaway copy: the template folder under the skill is a source asset and
    // must stay free of build output (see the header comment).
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelforge-paper-'));
    const work = path.join(workdir, directory);

    try {
      fs.cpSync(root, work, { recursive: true });

      // LaTeX writes <entry base>.pdf, so main.tex produces main.pdf — not paper.pdf.
      const base = path.basename(entry, path.extname(entry));
      const pdf = path.join(work, `${base}.pdf`);

      try {
        if (isTypst) {
          execFileSync(typst, ['compile', entry], {
            cwd: work,
            stdio: 'pipe',
            encoding: 'utf8',
          });
        } else {
          // Two passes so cross-references and the table of contents settle.
          for (let pass = 0; pass < 2; pass++) {
            execFileSync('xelatex', ['-interaction=nonstopmode', '-halt-on-error', entry], {
              cwd: work,
              stdio: 'pipe',
              encoding: 'utf8',
            });
          }
        }
      } catch (error) {
        failed++;
        const log = `${error.stdout ?? ''}${error.stderr ?? ''}`;
        const logFile = path.join(work, isTypst ? 'typst.log' : `${base}.log`);
        const detail = fs.existsSync(logFile)
          ? fs
              .readFileSync(logFile, 'utf8')
              .split('\n')
              .filter((line) => line.startsWith('!'))
              .slice(0, 5)
              .join('\n')
          : log.split('\n').slice(-12).join('\n');
        console.error(`FAILED   ${directory}:`);
        console.error(detail || '(no error detail captured)');
        process.exitCode = 1;
        continue;
      }

      // First page only: the gallery shows one thumbnail per template.
      execFileSync(
        'pdftoppm',
        ['-png', '-r', '110', '-f', '1', '-l', '1', `${base}.pdf`, 'preview'],
        { cwd: work, stdio: 'pipe', encoding: 'utf8' }
      );

      const rendered = findRenderedPreview(work);
      if (!rendered) {
        failed++;
        console.error(`FAILED   ${directory}: pdftoppm produced no preview`);
        process.exitCode = 1;
        continue;
      }

      fs.mkdirSync(ASSETS, { recursive: true });
      fs.copyFileSync(rendered, appPreview);

      const pages = execFileSync('pdfinfo', [pdf], { encoding: 'utf8' })
        .split('\n')
        .find((line) => line.startsWith('Pages:'))
        ?.replace('Pages:', '')
        .trim();
      console.log(
        `built    ${directory} -> ${path.basename(appPreview)} ` +
          `(${fs.statSync(appPreview).size} bytes, ${pages ?? '?'} pages)`
      );
      compiled++;
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  }

  console.log(`\n${compiled} template(s) compiled, ${failed} failed`);
}

if (require.main === module) main();