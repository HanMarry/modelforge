#!/usr/bin/env node
'use strict';
/**
 * Markdown summary of a Windows smoke run (spec mathmodel-parity-and-beyond, task 13.6), for
 * the job summary of .github/workflows/modelforge-windows-smoke.yml.
 *
 *   node summarize-results.cjs --results <dir> [--out <file>]
 *
 * Reads, under <dir>:
 *   <scenario>/report.json   Playwright JSON report (windows-smoke/playwright.config.ts)
 *   **\/*.json               results of the PowerShell helpers in windows-smoke/scripts
 *                            (Install-ModelForge, Uninstall-ModelForge, Invoke-AsLocalUser,
 *                            Run-AsUserInner), recognised by their fields
 *
 * and these variables set by the workflow (all optional):
 *   SMOKE_INSTALLER, SMOKE_PACKAGE_RUN_ID, SMOKE_PACKAGE_RUN_URL, SMOKE_PACKAGE_SHA,
 *   SMOKE_TEST_SHA, MODELFORGE_SMOKE_WIZARD_STRICT,
 *   SMOKE_STEP_OUTCOMES   "name=outcome;name=outcome" (steps.<id>.outcome of each scenario)
 *
 * Appends the summary to $GITHUB_STEP_SUMMARY when set, writes it to --out (default
 * <dir>/summary.md) and prints it. Always exits 0: the workflow's gate step decides the job
 * result, and a broken summary must not hide the test outcome.
 */
const fs = require('node:fs');
const path = require('node:path');

/** Scenario directories in the order the workflow runs them. */
const KNOWN_SCENARIOS = ['primary', 'upgrade', 'uninstall', 'cn-user', 'cn-profile-sim'];

/** Annotation types worth a line in the summary (see harness.ts and the specs). */
const NOTABLE_ANNOTATIONS = [
  'product-defect',
  'harness-substitution',
  'unverified',
  'unexpected',
  'left-behind',
  'tool-approval',
  'not-first-launch',
];

/** Informational annotations shown as key facts. */
const FACT_ANNOTATIONS = ['first-shell', 'restart-shell', 'wizard-mode', 'wizard-endpoint'];

const MAX_ERROR_CHARS = 300;
const MAX_NOTE_CHARS = 240;
const MAX_NOTES = 40;

function parseArgs(argv) {
  const args = { results: '', out: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--results') args.results = argv[++i] || '';
    else if (arg === '--out') args.out = argv[++i] || '';
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

function clip(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Safe inside a Markdown table cell or list item. */
function md(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n+/g, ' ')
    .trim();
}

function duration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

function yesNo(value) {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return '?';
}

// ---------------------------------------------------------------------------------------------
// Playwright reports
// ---------------------------------------------------------------------------------------------

function collectTests(suite, out) {
  for (const spec of suite.specs || []) {
    for (const test of spec.tests || []) {
      const results = test.results || [];
      const last = results[results.length - 1] || {};
      const seen = new Set();
      const annotations = [];
      for (const annotation of [...(test.annotations || []), ...(last.annotations || [])]) {
        const key = `${annotation.type}\u0000${annotation.description ?? ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          annotations.push({ type: String(annotation.type), description: String(annotation.description ?? '') });
        }
      }
      out.push({
        title: spec.title,
        status: last.status || (test.status === 'skipped' ? 'skipped' : 'unknown'),
        durationMs: results.reduce((sum, result) => sum + (result.duration || 0), 0),
        errors: (last.errors || []).map((error) => stripAnsi(error.message || error.value || '')).filter(Boolean),
        annotations,
      });
    }
  }
  for (const child of suite.suites || []) {
    collectTests(child, out);
  }
  return out;
}

function readScenario(dir, name) {
  const reportFile = path.join(dir, 'report.json');
  const report = readJson(reportFile);
  if (!report) {
    return { name, present: fs.existsSync(reportFile), report: null, tests: [], errors: [] };
  }
  const tests = [];
  for (const suite of report.suites || []) collectTests(suite, tests);
  const errors = (report.errors || []).map((error) => stripAnsi(error.message || error.value || '')).filter(Boolean);
  return { name, present: true, report, tests, errors };
}

const STATUS_LABEL = {
  passed: '✅ passed',
  failed: '❌ failed',
  timedOut: '⏱️ timed out',
  interrupted: '⚠️ interrupted',
  skipped: '⏭️ skipped',
  unknown: '❔ unknown',
};

function counts(tests) {
  const out = { passed: 0, failed: 0, skipped: 0 };
  for (const test of tests) {
    if (test.status === 'passed') out.passed += 1;
    else if (test.status === 'skipped') out.skipped += 1;
    else out.failed += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// PowerShell helper results
// ---------------------------------------------------------------------------------------------

function findJsonFiles(root, depth = 5) {
  const out = [];
  const walk = (dir, level) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Playwright's own output (attachments, HTML report) holds no helper results.
        if (level < depth && !['html', 'artifacts', 'node_modules', 'state'].includes(entry.name)) {
          walk(full, level + 1);
        }
      } else if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'report.json') {
        out.push(full);
      }
    }
  };
  walk(root, 0);
  return out.sort();
}

function helperKind(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  if ('mode' in result && 'promptSeen' in result) return 'uninstall';
  if ('exeWriteTimeUtc' in result && 'installer' in result) return 'install';
  if ('sid' in result && 'userName' in result) return 'local-user';
  if ('identity' in result && 'userProfile' in result) return 'local-user-inner';
  return null;
}

function helperRow(kind, result) {
  const ok = result.ok === true ? '✅' : '❌';
  switch (kind) {
    case 'install':
      return {
        what: 'Install-ModelForge',
        ok,
        details: [
          `exit ${result.exitCode ?? '?'}`,
          result.displayVersion ? `version ${result.displayVersion}` : '',
          result.durationMs ? `took ${duration(result.durationMs)}` : '',
          `Apps & features ${yesNo(result.uninstallEntryPresent)}`,
          `Start menu ${yesNo(result.startMenuShortcutPresent)}`,
          `desktop ${yesNo(result.desktopShortcutPresent)}`,
          `dir ${result.installDir || ''}`,
        ],
        error: result.error,
      };
    case 'uninstall':
      return {
        what: `Uninstall-ModelForge (${result.mode})`,
        ok,
        details: [
          `UI Automation ${yesNo(result.uiaAvailable)}`,
          `prompt ${yesNo(result.promptSeen)}`,
          result.answered ? `answered ${result.answered}` : '',
          `files left ${(result.remainingFiles || []).length}`,
          `Apps & features left ${yesNo(result.uninstallEntryPresent)}`,
          `shortcuts left ${yesNo(result.startMenuShortcutPresent || result.desktopShortcutPresent)}`,
        ],
        error: result.error,
      };
    case 'local-user':
      return {
        what: 'Invoke-AsLocalUser',
        ok,
        details: [`stage ${result.stage}`, `exit ${result.exitCode ?? '?'}`, result.profileDir ? `profile ${result.profileDir}` : ''],
        error: result.error,
      };
    case 'local-user-inner':
      return {
        what: 'Run-AsUserInner',
        ok,
        details: [`stage ${result.stage}`, `as ${result.identity}`, `profile ${result.userProfile}`, `exit ${result.exitCode ?? '?'}`],
        error: result.error,
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------------------------

function parseOutcomes(value) {
  const out = [];
  for (const part of String(value || '').split(';')) {
    const [name, outcome] = part.split('=').map((item) => (item || '').trim());
    if (name) out.push({ name, outcome: outcome || 'not run' });
  }
  return out;
}

function outcomeLabel(outcome) {
  if (outcome === 'success') return '✅ success';
  if (outcome === 'failure') return '❌ failure';
  if (outcome === 'skipped' || outcome === '') return '⏭️ skipped';
  if (outcome === 'cancelled') return '⚠️ cancelled';
  return md(outcome);
}

function buildSummary(resultsDir, env) {
  const lines = [];
  lines.push('## ModelForge Windows smoke');
  lines.push('');

  const meta = [];
  if (env.SMOKE_INSTALLER) meta.push(`installer \`${path.basename(env.SMOKE_INSTALLER)}\``);
  if (env.SMOKE_PACKAGE_RUN_ID) {
    const run = env.SMOKE_PACKAGE_RUN_URL
      ? `[${env.SMOKE_PACKAGE_RUN_ID}](${env.SMOKE_PACKAGE_RUN_URL})`
      : env.SMOKE_PACKAGE_RUN_ID;
    meta.push(`package run ${run}`);
  }
  if (env.SMOKE_PACKAGE_SHA) meta.push(`built from \`${env.SMOKE_PACKAGE_SHA.slice(0, 9)}\``);
  if (env.SMOKE_TEST_SHA) meta.push(`tests from \`${env.SMOKE_TEST_SHA.slice(0, 9)}\``);
  meta.push(`wizard step 2: ${env.MODELFORGE_SMOKE_WIZARD_STRICT === '1' ? 'strict' : 'soft'}`);
  lines.push(meta.join(' · '));
  if (env.SMOKE_PACKAGE_SHA && env.SMOKE_TEST_SHA && env.SMOKE_PACKAGE_SHA !== env.SMOKE_TEST_SHA) {
    lines.push('');
    lines.push('> The installer and the tests come from different commits.');
  }
  lines.push('');

  const outcomes = parseOutcomes(env.SMOKE_STEP_OUTCOMES);
  if (outcomes.length > 0) {
    lines.push('| Step | Outcome |');
    lines.push('|---|---|');
    for (const { name, outcome } of outcomes) lines.push(`| ${md(name)} | ${outcomeLabel(outcome)} |`);
    lines.push('');
  }

  // Scenarios: the known ones in order, then any other directory with a report.
  let names = [...KNOWN_SCENARIOS];
  try {
    for (const entry of fs.readdirSync(resultsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !names.includes(entry.name) && fs.existsSync(path.join(resultsDir, entry.name, 'report.json'))) {
        names.push(entry.name);
      }
    }
  } catch {
    lines.push(`No results directory at \`${md(resultsDir)}\`.`);
    return lines.join('\n');
  }
  const scenarios = names
    .map((name) => readScenario(path.join(resultsDir, name), name))
    .filter((scenario) => scenario.present || fs.existsSync(path.join(resultsDir, scenario.name)));

  lines.push('| Scenario | Passed | Failed | Skipped | Duration |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const scenario of scenarios) {
    if (!scenario.report) {
      lines.push(`| ${md(scenario.name)} | – | – | – | no report.json |`);
      continue;
    }
    const c = counts(scenario.tests);
    lines.push(
      `| ${md(scenario.name)} | ${c.passed} | ${c.failed > 0 ? `**${c.failed}**` : 0} | ${c.skipped} | ${duration(scenario.report.stats?.duration)} |`
    );
  }
  if (scenarios.length === 0) lines.push('| (none) | – | – | – | no scenario ran |');
  lines.push('');

  // Per-test status, failures first within each scenario.
  const failures = [];
  const notes = [];
  const facts = [];
  for (const scenario of scenarios) {
    for (const error of scenario.errors) failures.push(`- **${md(scenario.name)}** (run): ${md(clip(error.split('\n')[0], MAX_ERROR_CHARS))}`);
    for (const test of scenario.tests) {
      const where = `**${md(scenario.name)}** › ${md(test.title)}`;
      if (!['passed', 'skipped'].includes(test.status)) {
        const first = test.errors[0] ? clip(test.errors[0].split('\n').filter(Boolean).slice(0, 2).join(' '), MAX_ERROR_CHARS) : '(no error message)';
        const more = test.errors.length > 1 ? ` (+${test.errors.length - 1} more)` : '';
        failures.push(`- ${where} — ${STATUS_LABEL[test.status] || md(test.status)}: ${md(first)}${more}`);
      }
      for (const annotation of test.annotations) {
        if (NOTABLE_ANNOTATIONS.includes(annotation.type)) {
          notes.push(`- ${where} — \`${md(annotation.type)}\`: ${md(clip(annotation.description, MAX_NOTE_CHARS))}`);
        } else if (FACT_ANNOTATIONS.includes(annotation.type)) {
          facts.push(`- ${md(scenario.name)} — \`${md(annotation.type)}\`: ${md(clip(annotation.description, MAX_NOTE_CHARS))}`);
        }
      }
      if (test.status === 'skipped') {
        const reason = test.annotations.find((annotation) => annotation.type === 'skip');
        if (reason?.description) notes.push(`- ${where} — skipped: ${md(clip(reason.description, MAX_NOTE_CHARS))}`);
      }
    }
  }

  if (failures.length > 0) {
    lines.push('### Failures');
    lines.push('');
    lines.push(...failures);
    lines.push('');
  }
  if (notes.length > 0) {
    lines.push('### Product defects, substitutions and unverified steps');
    lines.push('');
    lines.push(...notes.slice(0, MAX_NOTES));
    if (notes.length > MAX_NOTES) lines.push(`- … ${notes.length - MAX_NOTES} more in the report`);
    lines.push('');
  }
  if (facts.length > 0) {
    lines.push('### Key facts');
    lines.push('');
    lines.push(...facts.slice(0, MAX_NOTES));
    lines.push('');
  }

  // Helper results.
  const rows = [];
  for (const file of findJsonFiles(resultsDir)) {
    const result = readJson(file);
    const kind = helperKind(result);
    if (!kind) continue;
    const row = helperRow(kind, result);
    if (row) rows.push({ ...row, file: path.relative(resultsDir, file) });
  }
  if (rows.length > 0) {
    lines.push('### Installer and uninstaller runs');
    lines.push('');
    lines.push('| Result file | Script | OK | Details |');
    lines.push('|---|---|---|---|');
    for (const row of rows) {
      const details = row.details.filter(Boolean).join(', ');
      const error = row.error ? `; error: ${clip(row.error, MAX_ERROR_CHARS)}` : '';
      lines.push(`| ${md(row.file)} | ${md(row.what)} | ${row.ok} | ${md(details + error)} |`);
    }
    lines.push('');
  }

  lines.push('Screenshots, app and kernel logs and the full reports are in the `modelforge-windows-smoke` artifact.');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.results) {
    process.stdout.write('usage: node summarize-results.cjs --results <dir> [--out <file>]\n');
    return;
  }
  const resultsDir = path.resolve(args.results);
  let summary;
  try {
    summary = buildSummary(resultsDir, process.env);
  } catch (error) {
    summary = `## ModelForge Windows smoke\n\nThe summary could not be built: ${md(error && error.stack ? error.stack : String(error))}`;
  }
  const text = `${summary}\n`;
  const out = args.out || path.join(resultsDir, 'summary.md');
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, text, 'utf8');
  } catch (error) {
    process.stderr.write(`cannot write ${out}: ${error.message}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text, 'utf8');
    } catch (error) {
      process.stderr.write(`cannot append to GITHUB_STEP_SUMMARY: ${error.message}\n`);
    }
  }
  process.stdout.write(text);
}

if (require.main === module) {
  main();
}

module.exports = { buildSummary, collectTests, helperKind };
