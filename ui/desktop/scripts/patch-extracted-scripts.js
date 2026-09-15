#!/usr/bin/env node
/**
 * Adds a UTF-8 console guard to the extracted Python scripts.
 *
 * Why: on Windows the console defaults to a legacy code page (GBK on a Chinese system).
 * Every one of the extracted diagram scripts prints Chinese text or a ✓, and that raises
 * `UnicodeEncodeError` — in `roadmap_5band.py` the checkmark print happens *before* the
 * .drawio is written, so the render silently produced nothing. `paper_search.py` died the
 * same way while printing a title with an accent.
 *
 * The guard reconfigures stdout/stderr to UTF-8 and is additive: no layout logic, no
 * output text and no file contents change. It is recorded as a local adaptation in
 * NOTICE.md so the divergence from the product copy stays visible.
 *
 * Usage: node scripts/patch-extracted-scripts.js [--check]
 */
const fs = require('fs');
const path = require('path');

const BUILTINS = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'crates',
  'goose',
  'src',
  'skills',
  'builtins'
);

/** Scripts that print non-ASCII and therefore need the guard. */
const TARGETS = [
  'paper_diagram/scripts/check_layout.py',
  'paper_diagram/scripts/export_figure.py',
  'paper_diagram/scripts/framework_3col.py',
  'paper_diagram/scripts/preview_html.py',
  'paper_diagram/scripts/roadmap_3phase.py',
  'paper_diagram/scripts/roadmap_5band.py',
  'paper_diagram/scripts/stageflow_3col.py',
  'paper_diagram/scripts/taskflow_land.py',
  'paper_search/scripts/paper_search.py',
];

const MARKER = 'def enable_utf8_stdout(';

const GUARD = `def enable_utf8_stdout():
    """Reconfigure the console streams to UTF-8.

    Added in this fork: on Windows the console uses a legacy code page (GBK on a Chinese
    system), so printing Chinese text or a checkmark raises UnicodeEncodeError. In the
    diagram scripts that print happens before the .drawio is written, which made a
    successful render look like a failure. Output text is unchanged.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass


`;

function patch(file, checkOnly) {
  const source = fs.readFileSync(file, 'utf8');
  const relative = path.relative(BUILTINS, file);

  if (source.includes(MARKER)) {
    const callsGuard = /def main\([^)]*\):\s*\n(\s*)enable_utf8_stdout\(\)/.test(source);
    return { relative, status: callsGuard ? 'already patched' : 'HAS GUARD BUT NOT CALLED' };
  }

  const mainMatch = source.match(/^def main\(/m);
  if (!mainMatch) return { relative, status: 'NO main() — needs a manual look' };

  let patched = source;
  if (!/^import sys$/m.test(patched)) {
    // preview_html.py does not import sys
    patched = patched.replace(/^import /m, 'import sys\nimport ');
  }
  patched =
    patched.slice(0, mainMatch.index) + GUARD + patched.slice(mainMatch.index);
  patched = patched.replace(
    /^(def main\([^)]*\):\r?\n)(\s*)/m,
    (_, head, indent) => `${head}${indent}enable_utf8_stdout()\n${indent}`
  );

  if (!patched.includes('enable_utf8_stdout()')) {
    return { relative, status: 'FAILED to insert the call' };
  }
  if (!checkOnly) fs.writeFileSync(file, patched, 'utf8');
  return { relative, status: checkOnly ? 'would patch' : 'patched' };
}

function main() {
  const checkOnly = process.argv.includes('--check');
  let problems = 0;

  for (const relative of TARGETS) {
    const file = path.join(BUILTINS, relative);
    if (!fs.existsSync(file)) {
      console.log(`MISSING  ${relative}`);
      problems++;
      continue;
    }
    const result = patch(file, checkOnly);
    console.log(`${result.status.padEnd(26)} ${result.relative}`);
    if (/FAILED|NO main|NOT CALLED/.test(result.status)) problems++;
  }

  if (problems) process.exitCode = 1;
}

if (require.main === module) main();
