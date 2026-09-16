#!/usr/bin/env node
/**
 * Guards the builtin SKILL.md files: each needs YAML frontmatter with `name` and
 * `description`, a name that matches the agentskills.io pattern, and a
 * description within the 1024-character limit. Also reports the supporting files
 * that `include_dir!` will bundle with each skill.
 *
 * Usage: node scripts/check-skills.js
 */
const fs = require('fs');
const path = require('path');

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

console.log(`\n${files.length - failures}/${files.length} skill files valid`);
if (failures) process.exitCode = 1;
