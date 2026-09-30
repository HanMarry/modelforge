#!/usr/bin/env node
/**
 * Publisher-metadata guard (spec mathmodel-parity-and-beyond, requirement 7.9): the installer
 * properties, the Windows "Programs and Features" publisher field, shortcut names and the
 * auto-update feed must name ModelForge and ModelForge's own update source — never the upstream
 * goose project (Block, Inc. / aaif-goose) or any third party. That covers the build-time
 * updater defaults (vite.main.config.mts) and the runtime feeds (src/utils/*Updater.ts) too.
 *
 * This is a pure check: it never writes, and reports every violation before exiting non-zero.
 * It is part of `brand:check` (`pnpm run brand:check`).
 *
 * Usage: node scripts/check-publisher-metadata.js [--check]
 */
const fs = require('fs');
const path = require('path');
const { parseCheckArgs } = require('./check-mode');

parseCheckArgs(process.argv, 'node scripts/check-publisher-metadata.js [--check]');

const ROOT = path.join(__dirname, '..');
const APP_UPDATE_YML = path.join(ROOT, 'src', 'app-update.yml');
const FORGE_CONFIG = path.join(ROOT, 'forge.config.ts');
const VITE_MAIN_CONFIG = path.join(ROOT, 'vite.main.config.mts');
const UPDATER_SOURCES = ['src/utils/autoUpdater.ts', 'src/utils/githubUpdater.ts'];

// The upstream goose project's GitHub coordinates (Block, Inc., now aaif-goose/goose) and company,
// which must not appear as the publisher or update source. "goose" is matched only next to an
// owner/repo/maintainer field so it does not flag the many legitimate uses of the word
// (goose.exe, goose-docs, etc.).
const FORBIDDEN_OWNER = /owner\s*[:=]\s*['"`]?(?:block|aaif-goose)\b/i;
const FORBIDDEN_REPO = /\b(?:name|repo)\s*[:=]\s*['"`]goose['"`]/i;
const FORBIDDEN_ENTITY = /(?:maintainer|authors|publisherName|author)\s*[:=]\s*['"`][^'"`]*block[^'"`]*['"`]/i;
const FORBIDDEN_UPDATE_HOST = /(?:block|goose)[-.]?(?:update|updates|download)|api\.update\.goose/i;

const violations = [];

function checkFile(file, label, rules) {
  const text = fs.readFileSync(file, 'utf8');
  for (const { pattern, message } of rules) {
    if (pattern.test(text)) {
      violations.push(`${label}: ${message}`);
    }
  }
}

function reportRequired(file, label, required) {
  const text = fs.readFileSync(file, 'utf8');
  for (const { pattern, message } of required) {
    if (!pattern.test(text)) {
      violations.push(`${label}: missing ${message}`);
    }
  }
}

// app-update.yml: the auto-update feed must be ModelForge's own GitHub release, not upstream.
const updateYml = fs.readFileSync(APP_UPDATE_YML, 'utf8');
checkFile(APP_UPDATE_YML, 'src/app-update.yml', [
  { pattern: FORBIDDEN_OWNER, message: 'owner is upstream goose ("block" / "aaif-goose")' },
  { pattern: FORBIDDEN_REPO, message: 'repo is "goose" (upstream goose repository)' },
  { pattern: FORBIDDEN_UPDATE_HOST, message: 'update source points at an upstream host' },
]);
reportRequired(APP_UPDATE_YML, 'src/app-update.yml', [
  { pattern: /owner:\s*HanMarry/, message: 'owner: HanMarry (ModelForge update source)' },
  { pattern: /repo:\s*modelforge/, message: 'repo: modelforge (ModelForge update source)' },
  {
    pattern: /updaterCacheDirName:\s*modelforge-updater/,
    message: 'updaterCacheDirName: modelforge-updater (removed by build/installer.nsh)',
  },
]);

// forge.config.ts: publisher, maker maintainers/authors and the NSIS publisher must be ModelForge.
checkFile(FORGE_CONFIG, 'forge.config.ts', [
  {
    pattern: FORBIDDEN_OWNER,
    message: 'GitHub publisher owner is upstream goose ("block" / "aaif-goose")',
  },
  { pattern: FORBIDDEN_REPO, message: 'GitHub publisher repo is "goose" (upstream goose repository)' },
  { pattern: FORBIDDEN_ENTITY, message: 'publisher/author/maintainer names "Block" (upstream company)' },
  { pattern: FORBIDDEN_UPDATE_HOST, message: 'an update URL points at an upstream host' },
]);
reportRequired(FORGE_CONFIG, 'forge.config.ts', [
  {
    pattern: /owner:\s*process\.env\.GITHUB_OWNER\s*\|\|\s*['"]HanMarry['"]/,
    message: 'GitHub publisher owner default of HanMarry',
  },
  {
    pattern: /name:\s*process\.env\.GITHUB_REPO\s*\|\|\s*['"]modelforge['"]/,
    message: 'GitHub publisher repo default of modelforge',
  },
  {
    pattern: /maintainer:\s*['"]ModelForge Team['"]/,
    message: 'Linux maker maintainer "ModelForge Team"',
  },
  {
    pattern: /publisherName:\s*['"]ModelForge Team['"]/,
    message: 'NSIS updater publisherName "ModelForge Team"',
  },
  {
    pattern: /updaterCacheDirName:\s*['"]modelforge-updater['"]/,
    message: 'NSIS updaterCacheDirName "modelforge-updater" (removed by build/installer.nsh)',
  },
  {
    // The maker reads only getAppBuilderConfig and hands its result to app-builder-lib, so
    // the installer options must sit under `nsis` there; anything else silently builds a
    // one-click installer without build/installer.nsh's uninstall prompt (requirement 7.10).
    pattern:
      /getAppBuilderConfig:[\s\S]*?\bnsis:\s*\{[\s\S]*?oneClick:\s*false[\s\S]*?include:\s*['"]build\/installer\.nsh['"]/,
    message:
      'maker-nsis getAppBuilderConfig returning nsis.oneClick false and nsis.include build/installer.nsh',
  },
]);
checkFile(FORGE_CONFIG, 'forge.config.ts', [
  {
    pattern: /getAdditionalConfig\s*:/,
    message: 'getAdditionalConfig, which @felixrieseberg/electron-forge-maker-nsis ignores',
  },
]);

// vite.main.config.mts bakes the updater settings into the main bundle. A default owner there
// switches the update channel on for every build (isUpdateChannelConfigured), so it must stay
// empty and must never name the upstream repository.
checkFile(VITE_MAIN_CONFIG, 'vite.main.config.mts', [
  { pattern: /aaif-goose/i, message: 'bakes the upstream goose owner into the updater' },
  {
    pattern: /\|\|\s*['"`]goose['"`]/i,
    message: 'bakes an upstream goose repo/bundle name default',
  },
]);
reportRequired(VITE_MAIN_CONFIG, 'vite.main.config.mts', [
  {
    pattern: /JSON\.stringify\(\s*process\.env\.GITHUB_OWNER\s*\|\|\s*(['"])\1\s*\)/,
    message: "an empty GITHUB_OWNER default (process.env.GITHUB_OWNER || '')",
  },
]);

// The runtime update feeds must take owner/repo from getUpdateRepository, not a literal.
for (const source of UPDATER_SOURCES) {
  checkFile(path.join(ROOT, source), source, [
    {
      pattern: FORBIDDEN_OWNER,
      message: 'update feed owner is upstream goose ("block" / "aaif-goose")',
    },
    { pattern: FORBIDDEN_REPO, message: 'update feed repo is "goose" (upstream goose repository)' },
  ]);
}

if (violations.length) {
  console.log('publisher metadata check failed:');
  for (const violation of violations) console.log(`  - ${violation}`);
  process.exitCode = 1;
} else {
  console.log('ok   publisher metadata is ModelForge, not upstream goose/Block');
}
