#!/usr/bin/env node
/**
 * Packaged-content check (spec mathmodel-parity-and-beyond, requirement 7.1 / task 13.5):
 * the number of builtin skills in the shipped `goose.exe` must equal `content.skills` in the
 * `build-manifest.json` shipped next to it, otherwise packaging fails.
 *
 * The builtin skills are compiled into goose.exe, so the count is read back from the binary by
 * running `goose skills list` in an isolated environment (empty cwd + empty HOME/APPDATA), which
 * leaves only builtin skills. The comparison is against the manifest, not the source tree, so a
 * binary/manifest mismatch (a wrong goose.exe, an edited manifest) stops the package.
 *
 * Usage: node scripts/verify-packaged-content.js --bin <resources/bin directory>
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const binDir = argValue('--bin');
if (!binDir || !fs.existsSync(binDir)) {
  console.error('usage: node scripts/verify-packaged-content.js --bin <resources/bin directory>');
  process.exit(2);
}

const gooseExe = path.join(binDir, 'goose.exe');
const manifestPath = path.join(binDir, 'build-manifest.json');
if (!fs.existsSync(gooseExe)) {
  console.error(`missing ${gooseExe}`);
  process.exit(1);
}
if (!fs.existsSync(manifestPath)) {
  console.error(`missing ${manifestPath}`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (error) {
  console.error(`cannot parse ${manifestPath}: ${error.message}`);
  process.exit(1);
}
const expected = manifest?.content?.skills;
if (!Number.isInteger(expected) || expected < 0) {
  console.error(`build-manifest.json content.skills is missing or not a non-negative integer`);
  process.exit(1);
}

// Isolated environment so `goose skills list` reports only the compiled-in skills, not the
// machine's global or project skills.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelforge-content-check-'));
const isolatedEnv = { ...process.env };
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) {
  isolatedEnv[key] = workDir;
}

let output = '';
try {
  output = execFileSync(gooseExe, ['skills', 'list'], {
    cwd: workDir,
    env: isolatedEnv,
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (error) {
  console.error(`goose.exe skills list failed: ${error.message}`);
  if (error.stdout) console.error(error.stdout.toString());
  if (error.stderr) console.error(error.stderr.toString());
  process.exit(1);
} finally {
  fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// `goose skills list` prints one line per skill plus a header line.
const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0);
const actual = Math.max(0, lines.length - 1);

console.log(`builtin skills in packaged goose.exe: ${actual}`);
console.log(`build-manifest.json content.skills:    ${expected}`);
if (actual !== expected) {
  console.error(
    `packaged content mismatch: goose.exe reports ${actual} builtin skills, ` +
      `build-manifest.json records ${expected}`
  );
  process.exit(1);
}
console.log('ok   packaged builtin skills match build-manifest.json');
