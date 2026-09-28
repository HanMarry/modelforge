#!/usr/bin/env node
/**
 * Guards the builtin SKILL.md files: each needs YAML frontmatter with `name` and
 * `description`, a name that matches the agentskills.io pattern, and a
 * description within the 1024-character limit. Also reports the supporting files
 * that `include_dir!` will bundle with each skill, and fails if any of them is contest
 * material (a statement PDF, an attachment, a real problem folder).
 *
 * `--check` is the CI mode: the same checks, with every file write refused (see
 * `check-mode.js`). The script never writes either way; the flag turns that into a
 * guarantee.
 *
 * Usage: node scripts/check-skills.js [--check]
 */
const fs = require('fs');
const path = require('path');
const { enforceReadOnly, parseCheckArgs } = require('./check-mode');

const { check } = parseCheckArgs(process.argv, 'node scripts/check-skills.js [--check]');
if (check) {
  enforceReadOnly();
  console.log('read-only check mode: file writes are refused\n');
}

const dir = path.join(__dirname, '..', '..', '..', 'crates', 'goose', 'src', 'skills', 'builtins');

const REQUIRED = ['name', 'description'];

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) fields[key] = value;
  }
  return fields;
}

let failures = 0;
const files = fs.readdirSync(dir).filter((name) => name.endsWith('.md')).sort();

for (const file of files) {
  const full = path.join(dir, file);
  const text = fs.readFileSync(full, 'utf8');
  const fields = parseFrontmatter(text);
  const problems = [];

  if (!fields) {
    problems.push('missing YAML frontmatter');
  } else {
    for (const key of REQUIRED) {
      if (!fields[key]) problems.push(`missing required field "${key}"`);
    }
    if (fields.name && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fields.name)) {
      problems.push(`name "${fields.name}" violates the agentskills.io pattern`);
    }
    if (fields.description && fields.description.length > 1024) {
      problems.push(`description is ${fields.description.length} chars (max 1024)`);
    }
  }

  const skillDir = full.replace(/\.md$/, '');
  const supporting = fs.existsSync(skillDir)
    ? fs
        .readdirSync(skillDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(skillDir, path.join(entry.parentPath ?? entry.path, entry.name)))
    : [];

  if (problems.length) {
    failures++;
    console.log(`FAIL ${file}`);
    for (const problem of problems) console.log(`     - ${problem}`);
  } else {
    const suffix = supporting.length ? ` +${supporting.length} supporting files` : '';
    console.log(`ok   ${file} (${fields ? fields.name : '?'})${suffix}`);
  }
}

// Contest material (spec requirements 9.6, 7.1). Everything under builtins/ is compiled
// into goose by `include_dir!`, so an organiser's statement or attachment here would be
// redistributed with every kernel build. Local study copies of real problems belong in
// the git-ignored ui/desktop/resources/builtin-examples/ instead.
const EXAMPLES_DIR = path.join('math_modeling', 'assets', 'examples');
const CONTEST_NAME =
  /国赛|华数杯|高教杯|高教社杯|美赛|mcm|icm|mathorcup|电工杯|深圳杯|亚太|apmcm|数维杯|五一|华中杯|长三角|东三省|统计建模|华为杯|研赛/i;

/** Why `relative` (a path under builtins/) looks like contest material, or null. */
function contestReason(relative) {
  const segments = relative.split(path.sep);
  const name = segments[segments.length - 1];
  if (relative.startsWith(EXAMPLES_DIR + path.sep)) return 'under math_modeling/assets/examples/';
  if (/\.pdf$/i.test(name) && (/[A-Fa-f]题/.test(name) || /赛题|题目|题面/.test(name))) {
    return 'contest statement PDF';
  }
  if (/^附件/.test(name)) return 'contest attachment';
  const folder = segments
    .slice(0, -1)
    .find((dir) => /^(19|20)\d{2}/.test(dir) && CONTEST_NAME.test(dir) && dir.includes('题'));
  return folder ? `inside contest problem folder ${folder}/` : null;
}

const contest = fs
  .readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => path.relative(dir, path.join(entry.parentPath ?? entry.path, entry.name)))
  .map((relative) => ({ relative, reason: contestReason(relative) }))
  .filter((file) => file.reason)
  .sort((a, b) => (a.relative < b.relative ? -1 : 1));

if (contest.length) {
  console.log('FAIL contest material under builtins/ (compiled into goose by include_dir!)');
  for (const file of contest) {
    console.log(`     - ${file.relative.split(path.sep).join('/')}: ${file.reason}`);
  }
  console.log(
    '     move it to ui/desktop/resources/builtin-examples/ (git-ignored, local use only)'
  );
} else {
  console.log('ok   no contest statements or attachments under builtins/');
}

console.log(`\n${files.length - failures}/${files.length} skill files valid`);
if (failures || contest.length) process.exitCode = 1;
