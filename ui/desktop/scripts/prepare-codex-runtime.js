#!/usr/bin/env node
/**
 * Stages the Codex agent runtime that ships inside the Windows build (requirement 7.11–7.14):
 *
 *   src/bin/codex-acp.cmd                         command the kernel resolves as `codex-acp`
 *   src/bin/codex-runtime/node/node.exe, LICENSE  pinned Node.js that runs the adapter
 *   src/bin/codex-runtime/app/node_modules/...    `npm ci` of bundled-runtimes/codex
 *   src/bin/codex-runtime/runtime.json            versions, read by the app and checked by CI
 *   src/bin/codex-runtime/THIRD_PARTY_NOTICES.txt license texts of everything above
 *
 * The adapter gets its own node.exe because the RunAsNode fuse stays off in forge.config.ts,
 * so the app binary cannot double as a Node runtime.
 *
 * npm installs the Codex binary for the current platform only, so this must run on Windows.
 * Set MODELFORGE_SKIP_CODEX_RUNTIME=1 to build without the runtime.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execFileSync, execSync } = require('child_process');

const NODE_VERSION = '24.21.0';
const NODE_DIST = `node-v${NODE_VERSION}-win-x64`;
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.zip`;
// From https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
const NODE_ZIP_SHA256 = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541';

const ADAPTER_PACKAGE = '@agentclientprotocol/codex-acp';
const CODEX_PACKAGE = '@openai/codex';
const CODEX_PLATFORM_PACKAGE = '@openai/codex-win32-x64';
const CODEX_TARGET_TRIPLE = 'x86_64-pc-windows-msvc';

const desktopDir = path.join(__dirname, '..');
const lockDir = path.join(desktopDir, 'bundled-runtimes', 'codex');
const noticesDir = path.join(lockDir, 'notices');
const defaultBinDir = path.join(desktopDir, 'src', 'bin');

const ENTRY_SCRIPT = [
  '@echo off',
  'setlocal',
  'set "MF_CODEX_RUNTIME=%~dp0codex-runtime"',
  '"%MF_CODEX_RUNTIME%\\node\\node.exe" "%MF_CODEX_RUNTIME%\\app\\node_modules\\@agentclientprotocol\\codex-acp\\dist\\index.js" %*',
  'exit /b %ERRORLEVEL%',
  '',
].join('\r\n');

function runtimeLayout(binDir) {
  const root = path.join(binDir, 'codex-runtime');
  const modules = path.join(root, 'app', 'node_modules');
  return {
    binDir,
    root,
    entry: path.join(binDir, 'codex-acp.cmd'),
    nodeDir: path.join(root, 'node'),
    node: path.join(root, 'node', 'node.exe'),
    appDir: path.join(root, 'app'),
    adapterEntry: path.join(modules, ...ADAPTER_PACKAGE.split('/'), 'dist', 'index.js'),
    codexEntry: path.join(modules, ...CODEX_PACKAGE.split('/'), 'bin', 'codex.js'),
    codexBinary: path.join(
      modules,
      ...CODEX_PLATFORM_PACKAGE.split('/'),
      'vendor',
      CODEX_TARGET_TRIPLE,
      'bin',
      'codex.exe'
    ),
    manifest: path.join(root, 'runtime.json'),
    notices: path.join(root, 'THIRD_PARTY_NOTICES.txt'),
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };

/** Freshly written executables can stay locked briefly while antivirus scans them. */
function renameWithRetry(source, destination, attempts = 10) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      const retryable = error && (error.code === 'EPERM' || error.code === 'EBUSY');
      if (!retryable || attempt >= attempts) {
        throw error;
      }
      sleepSync(500);
    }
  }
}

/** Versions the build must produce, taken from the committed manifest and lockfile. */
function pinnedVersions() {
  const manifest = readJson(path.join(lockDir, 'package.json'));
  const adapterVersion = manifest.dependencies && manifest.dependencies[ADAPTER_PACKAGE];
  if (!/^\d+\.\d+\.\d+$/.test(adapterVersion || '')) {
    throw new Error(
      `${ADAPTER_PACKAGE} must be pinned to an exact version in bundled-runtimes/codex/package.json (found ${adapterVersion})`
    );
  }

  const lock = readJson(path.join(lockDir, 'package-lock.json'));
  const locked = (name) => lock.packages && lock.packages[`node_modules/${name}`];
  const lockedAdapter = locked(ADAPTER_PACKAGE);
  const lockedCodex = locked(CODEX_PACKAGE);
  if (!lockedAdapter || lockedAdapter.version !== adapterVersion) {
    throw new Error(
      `package-lock.json does not lock ${ADAPTER_PACKAGE}@${adapterVersion}; run npm install --package-lock-only in bundled-runtimes/codex`
    );
  }
  if (!lockedCodex || !locked(CODEX_PLATFORM_PACKAGE)) {
    throw new Error(`package-lock.json is missing ${CODEX_PACKAGE} or ${CODEX_PLATFORM_PACKAGE}`);
  }

  return {
    codexAcpVersion: adapterVersion,
    codexVersion: lockedCodex.version,
    nodeVersion: NODE_VERSION,
  };
}

function requiredFiles(layout) {
  return [layout.node, layout.adapterEntry, layout.codexEntry, layout.codexBinary, layout.notices];
}

function isStaged(layout, expected) {
  if (!requiredFiles(layout).every((file) => fs.existsSync(file))) {
    return false;
  }
  try {
    const staged = readJson(layout.manifest);
    return (
      staged.codexAcpVersion === expected.codexAcpVersion &&
      staged.codexVersion === expected.codexVersion &&
      staged.nodeVersion === expected.nodeVersion
    );
  } catch {
    return false;
  }
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

/** Extracts only `members` from the zip; Windows' bsdtar reads zip archives directly. */
function extractFromZip(zipPath, destination, members) {
  const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (fs.existsSync(systemTar)) {
    execFileSync(systemTar, ['-xf', zipPath, '-C', destination, ...members], { stdio: 'inherit' });
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

async function stageNode(stagingRoot, downloadDir) {
  const zipPath = path.join(downloadDir, `${NODE_DIST}.zip`);
  console.log(`Downloading Node.js ${NODE_VERSION} from ${NODE_URL}`);
  await download(NODE_URL, zipPath);

  const actual = sha256File(zipPath);
  if (actual !== NODE_ZIP_SHA256) {
    throw new Error(
      `Node.js ${NODE_VERSION} checksum mismatch: expected ${NODE_ZIP_SHA256}, got ${actual}`
    );
  }

  const extractDir = path.join(downloadDir, 'node');
  fs.mkdirSync(extractDir, { recursive: true });
  extractFromZip(zipPath, extractDir, [`${NODE_DIST}/node.exe`, `${NODE_DIST}/LICENSE`]);

  const nodeDir = path.join(stagingRoot, 'node');
  fs.mkdirSync(nodeDir, { recursive: true });
  for (const name of ['node.exe', 'LICENSE']) {
    const source = path.join(extractDir, NODE_DIST, name);
    if (!fs.existsSync(source)) {
      throw new Error(`Node.js archive did not contain ${name}`);
    }
    fs.copyFileSync(source, path.join(nodeDir, name));
  }
}

function stageAdapter(stagingRoot) {
  const appDir = path.join(stagingRoot, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  for (const name of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(lockDir, name), path.join(appDir, name));
  }
  console.log('Installing the pinned Codex ACP adapter (npm ci)');
  // Fixed command line, no user input: npm verifies every tarball against the lockfile.
  execSync('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', {
    cwd: appDir,
    stdio: 'inherit',
  });
}

function listPackages(nodeModulesDir) {
  const packages = [];
  if (!fs.existsSync(nodeModulesDir)) {
    return packages;
  }
  for (const entry of fs.readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    const dirs = entry.name.startsWith('@')
      ? fs
          .readdirSync(path.join(nodeModulesDir, entry.name), { withFileTypes: true })
          .filter((child) => child.isDirectory())
          .map((child) => path.join(nodeModulesDir, entry.name, child.name))
      : [path.join(nodeModulesDir, entry.name)];
    for (const dir of dirs) {
      const manifestPath = path.join(dir, 'package.json');
      if (fs.existsSync(manifestPath)) {
        const manifest = readJson(manifestPath);
        packages.push({ dir, name: manifest.name, version: manifest.version, license: manifest.license });
      }
      packages.push(...listPackages(path.join(dir, 'node_modules')));
    }
  }
  return packages;
}

function licenseFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(licen[cs]e|notice|copying)(\.|-|$)/i.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function writeNotices(stagingRoot, versions) {
  const rule = '='.repeat(78);
  const sections = [
    'ModelForge bundled Codex runtime: third-party notices',
    '',
    'Everything under codex-runtime/ is redistributed unmodified under the licenses below.',
    '',
  ];
  const addSection = (title, bodies) => {
    sections.push(rule, title, rule, '');
    for (const body of bodies) {
      sections.push(body.trimEnd(), '');
    }
  };

  addSection(`Node.js ${versions.nodeVersion} (MIT)`, [
    fs.readFileSync(path.join(stagingRoot, 'node', 'LICENSE'), 'utf8'),
  ]);
  addSection(`OpenAI Codex CLI ${versions.codexVersion} (Apache-2.0)`, [
    'Source: https://github.com/openai/codex (tag rust-v' + versions.codexVersion + ')',
    fs.readFileSync(path.join(noticesDir, 'openai-codex-NOTICE.txt'), 'utf8'),
    fs.readFileSync(path.join(noticesDir, 'openai-codex-LICENSE.txt'), 'utf8'),
  ]);

  const packages = listPackages(path.join(stagingRoot, 'app', 'node_modules')).sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)
  );
  for (const pkg of packages) {
    const files = licenseFiles(pkg.dir);
    const bodies = files.map((file) => fs.readFileSync(file, 'utf8'));
    if (bodies.length === 0) {
      bodies.push(
        pkg.name.startsWith(CODEX_PACKAGE)
          ? 'No license file ships in this package; the OpenAI Codex CLI notice and license above apply.'
          : `No license file ships in this package. Declared license: ${pkg.license || 'unknown'}.`
      );
    }
    addSection(`${pkg.name}@${pkg.version} (${pkg.license || 'license not declared'})`, bodies);
  }

  fs.writeFileSync(path.join(stagingRoot, 'THIRD_PARTY_NOTICES.txt'), sections.join('\n'), 'utf8');
}

function verifyStaging(stagingRoot, expected) {
  const layout = runtimeLayout(path.dirname(stagingRoot));
  const relocate = (file) => path.join(stagingRoot, path.relative(layout.root, file));
  const missing = [layout.node, layout.adapterEntry, layout.codexEntry, layout.codexBinary]
    .map(relocate)
    .filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    throw new Error(`Bundled Codex runtime is incomplete, missing:\n  ${missing.join('\n  ')}`);
  }

  const modules = path.join(stagingRoot, 'app', 'node_modules');
  const installed = (name) => readJson(path.join(modules, ...name.split('/'), 'package.json')).version;
  const adapterVersion = installed(ADAPTER_PACKAGE);
  const codexVersion = installed(CODEX_PACKAGE);
  if (adapterVersion !== expected.codexAcpVersion || codexVersion !== expected.codexVersion) {
    throw new Error(
      `Installed versions drifted from the lockfile: ${ADAPTER_PACKAGE}@${adapterVersion}, ${CODEX_PACKAGE}@${codexVersion}`
    );
  }
}

async function prepareCodexRuntime(options = {}) {
  const { binDir = defaultBinDir, force = false } = options;
  if (process.env.MODELFORGE_SKIP_CODEX_RUNTIME === '1') {
    console.log('MODELFORGE_SKIP_CODEX_RUNTIME=1: building without the bundled Codex runtime');
    return;
  }
  if (process.platform !== 'win32') {
    throw new Error(
      'The bundled Codex runtime must be staged on Windows: npm installs the Codex binary for the host platform only. Set MODELFORGE_SKIP_CODEX_RUNTIME=1 to skip it.'
    );
  }

  const layout = runtimeLayout(binDir);
  const expected = pinnedVersions();
  if (!force && isStaged(layout, expected)) {
    fs.writeFileSync(layout.entry, ENTRY_SCRIPT, 'utf8');
    console.log(
      `Bundled Codex runtime already staged (codex-acp ${expected.codexAcpVersion}, codex ${expected.codexVersion}, node ${expected.nodeVersion})`
    );
    return;
  }

  fs.mkdirSync(binDir, { recursive: true });
  // Staged next to the destination so the final swap is a rename on the same volume.
  const stagingRoot = path.join(binDir, `.codex-runtime-staging-${process.pid}`);
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelforge-codex-runtime-'));
  fs.rmSync(stagingRoot, RM_OPTIONS);
  try {
    await stageNode(stagingRoot, downloadDir);
    stageAdapter(stagingRoot);
    verifyStaging(stagingRoot, expected);
    writeNotices(stagingRoot, expected);
    fs.writeFileSync(
      path.join(stagingRoot, 'runtime.json'),
      JSON.stringify(expected, null, 2) + '\n',
      'utf8'
    );

    fs.rmSync(layout.root, RM_OPTIONS);
    renameWithRetry(stagingRoot, layout.root);
    fs.writeFileSync(layout.entry, ENTRY_SCRIPT, 'utf8');
    console.log(
      `Staged bundled Codex runtime: codex-acp ${expected.codexAcpVersion}, codex ${expected.codexVersion}, node ${expected.nodeVersion}`
    );
  } finally {
    fs.rmSync(stagingRoot, RM_OPTIONS);
    fs.rmSync(downloadDir, RM_OPTIONS);
  }
}

if (require.main === module) {
  prepareCodexRuntime({ force: process.argv.includes('--force') }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { prepareCodexRuntime, runtimeLayout, pinnedVersions, NODE_VERSION };
