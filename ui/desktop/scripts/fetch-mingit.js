#!/usr/bin/env node
/**
 * Stages MinGit (a minimal Git for Windows distribution) inside the Windows build
 * (spec mathmodel-parity-and-beyond, requirement 11.2, packaged by requirement 7.1):
 *
 *   src/bin/mingit/cmd/git.exe        the launcher the checkpoint code resolves
 *   src/bin/mingit/mingw64/...        the git runtime it launches
 *   src/bin/mingit/LICENSE.txt        GPLv2 (git is GPLv2; shipped verbatim)
 *
 * MinGit is downloaded from the official git-for-windows release, checked against a
 * SHA-256 pinned in this script, and extracted as a standalone executable tree — it is
 * invoked as an independent `git.exe` process, never linked into the app.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execFileSync } = require('child_process');

const MINGIT_VERSION = '2.56.0';
const MINGIT_TAG = 'v2.56.0.windows.1';
const MINGIT_DIST = `MinGit-${MINGIT_VERSION}-64-bit`;
const MINGIT_URL = `https://github.com/git-for-windows/git/releases/download/${MINGIT_TAG}/${MINGIT_DIST}.zip`;
// From the git-for-windows release notes (https://github.com/git-for-windows/git/releases/tag/v2.56.0.windows.1).
const MINGIT_ZIP_SHA256 = '064b440ff870ed5198527e8f3a92cdf5bd2fd0fedf5e718af95e3fdaddeff718';

const desktopDir = path.join(__dirname, '..');
const licenseDir = path.join(desktopDir, 'bundled-runtimes', 'mingit');
const defaultBinDir = path.join(desktopDir, 'src', 'bin');

const RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };

function mingitLayout(binDir) {
  return {
    binDir,
    root: path.join(binDir, 'mingit'),
    launcher: path.join(binDir, 'mingit', 'cmd', 'git.exe'),
    git: path.join(binDir, 'mingit', 'mingw64', 'bin', 'git.exe'),
    license: path.join(binDir, 'mingit', 'LICENSE.txt'),
  };
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function download(url, destination, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        const { statusCode = 0, headers } = response;
        if (statusCode >= 300 && statusCode < 400 && headers.location && redirectsLeft > 0) {
          response.resume();
          download(new URL(headers.location, url).toString(), destination, redirectsLeft - 1)
            .then(resolve)
            .catch(reject);
          return;
        }
        if (statusCode !== 200) {
          response.resume();
          reject(new Error(`Failed to download ${url}: HTTP ${statusCode}`));
          return;
        }
        const file = fs.createWriteStream(destination);
        response.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

/** Windows' bsdtar reads zip archives directly; PowerShell Expand-Archive is the fallback. */
function extractFromZip(zipPath, destination) {
  const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (fs.existsSync(systemTar)) {
    execFileSync(systemTar, ['-xf', zipPath, '-C', destination], { stdio: 'inherit' });
    return;
  }
  const quote = (value) => `'${value.replace(/'/g, "''")}'`;
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(destination)} -Force`,
    ],
    { stdio: 'inherit' }
  );
}

function isStaged(layout) {
  return [layout.launcher, layout.git, layout.license].every((file) => fs.existsSync(file));
}

async function ensureMinGit(options = {}) {
  const { binDir = defaultBinDir, force = false } = options;
  if (process.platform !== 'win32') {
    // MinGit is Windows-only; other platforms use the system git for checkpoints.
    return;
  }

  const layout = mingitLayout(binDir);
  if (!force && isStaged(layout)) {
    console.log(`MinGit ${MINGIT_VERSION} already staged at ${path.relative(desktopDir, layout.root)}`);
    return;
  }

  fs.mkdirSync(binDir, { recursive: true });
  // Stage next to the destination so the final swap is a rename on the same volume.
  const stagingRoot = path.join(binDir, `.mingit-staging-${process.pid}`);
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelforge-mingit-'));
  const zipPath = path.join(downloadDir, `${MINGIT_DIST}.zip`);
  fs.rmSync(stagingRoot, RM_OPTIONS);
  try {
    console.log(`Downloading MinGit ${MINGIT_VERSION} from ${MINGIT_URL}`);
    await download(MINGIT_URL, zipPath);

    const actual = sha256File(zipPath);
    if (actual !== MINGIT_ZIP_SHA256) {
      throw new Error(
        `MinGit ${MINGIT_VERSION} checksum mismatch: expected ${MINGIT_ZIP_SHA256}, got ${actual}`
      );
    }

    fs.mkdirSync(stagingRoot, { recursive: true });
    extractFromZip(zipPath, stagingRoot);

    if (!fs.existsSync(path.join(stagingRoot, 'cmd', 'git.exe'))) {
      throw new Error(`MinGit archive did not contain cmd/git.exe`);
    }
    if (!fs.existsSync(path.join(stagingRoot, 'mingw64', 'bin', 'git.exe'))) {
      throw new Error(`MinGit archive did not contain mingw64/bin/git.exe`);
    }

    fs.copyFileSync(
      path.join(licenseDir, 'LICENSE.GPLv2.txt'),
      path.join(stagingRoot, 'LICENSE.txt')
    );

    fs.rmSync(layout.root, RM_OPTIONS);
    fs.renameSync(stagingRoot, layout.root);
    console.log(`Staged MinGit ${MINGIT_VERSION} at ${path.relative(desktopDir, layout.root)}`);
  } finally {
    fs.rmSync(stagingRoot, RM_OPTIONS);
    fs.rmSync(downloadDir, RM_OPTIONS);
  }
}

if (require.main === module) {
  ensureMinGit({ force: process.argv.includes('--force') }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { ensureMinGit, mingitLayout, MINGIT_VERSION };
