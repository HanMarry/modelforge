#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function fail(message) {
  console.error(message);
  process.exit(1);
}

const appPath = process.argv[2];
if (!appPath) {
  fail('Usage: node scripts/verify-mac-update-resources.js <path-to-app>');
}

const updateConfigPath = path.join(appPath, 'Contents', 'Resources', 'app-update.yml');
if (!fs.existsSync(updateConfigPath)) {
  fail(`Missing ${updateConfigPath}`);
}

const updateConfig = fs.readFileSync(updateConfigPath, 'utf8');
const lines = updateConfig.split(/\r?\n/);

// The bundled feed must be ModelForge's own release repository (src/app-update.yml, kept in
// sync with DEFAULT_GITHUB_OWNER / DEFAULT_GITHUB_REPO in src/branding.ts), never upstream goose.
const requiredLines = [
  'provider: github',
  'owner: HanMarry',
  'repo: modelforge',
  'updaterCacheDirName: modelforge-updater',
];

for (const line of requiredLines) {
  if (!lines.includes(line)) {
    fail(`${updateConfigPath} is missing "${line}"`);
  }
}

console.log(`${updateConfigPath} is present and valid`);
