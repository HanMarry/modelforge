/**
 * Helpers for the installed-app smoke specs (spec mathmodel-parity-and-beyond, task 13.6;
 * requirement 7.2-7.5). They drive the packaged `ModelForge.exe` that the NSIS installer put on
 * the runner, not an `electron-forge start` dev build (compare tests/e2e/fixtures.ts).
 *
 * Two environments are kept apart on purpose:
 *
 * - The test runner (Node + Playwright) is harness tooling only. The workflow installs it outside
 *   the checkout and it never reaches the app.
 * - The app under test starts from a clean-machine environment: the standard Windows variables of
 *   the current user plus `MODELFORGE_SMOKE_APP_PATH`, a PATH with only the Windows system
 *   directories, Python and Typst. No Node, Rust or global ACP adapter is reachable from it
 *   (checked by `checkCleanEnvironment`).
 *
 * Playwright's `_electron.launch` cannot be used: the packaged app disables the Node inspector
 * fuse (`EnableNodeCliInspectArguments: false` in forge.config.ts). The app honours
 * `ENABLE_PLAYWRIGHT` + `PLAYWRIGHT_DEBUG_PORT` in packaged builds (main.ts), which opens the
 * Chromium remote-debugging port, so the renderer is driven over CDP instead.
 *
 * Environment set by the workflow:
 *   MODELFORGE_INSTALL_DIR        install directory (contains ModelForge.exe)
 *   MODELFORGE_EXE                optional, defaults to <install dir>\ModelForge.exe
 *   MODELFORGE_SMOKE_APP_PATH     PATH given to the app
 *   MODELFORGE_SMOKE_SCENARIO     primary | cn-user | cn-profile-sim
 *   MODELFORGE_SMOKE_STATE_DIR    where the specs keep state between tests and steps
 *   MODELFORGE_STUB_PORT          port of openai-stub.cjs on 127.0.0.1
 *   MODELFORGE_SMOKE_PROFILE_ROOT only for cn-profile-sim: a stand-in user profile directory
 *   MODELFORGE_INSTALLER          the NSIS installer (upgrade and uninstall specs reinstall it)
 *   MODELFORGE_SMOKE_EVIDENCE_DIR where the PowerShell helpers put screenshots and JSON results
 *   MODELFORGE_SMOKE_WIZARD_STRICT "0" for soft mode (see `WIZARD_STRICT`); strict otherwise
 */
import { chromium, type Browser, type Page, type TestInfo } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export interface SmokeConfig {
  exe: string;
  installDir: string;
  scenario: string;
  stubPort: number;
  stubUrl: string;
  stateDir: string;
  appPath: string;
  locale: string;
  /** Stand-in profile root (fallback scenario only); null means the real profile is used. */
  profileRoot: string | null;
  /** NSIS installer; empty when the workflow did not pass it. */
  installer: string;
  /** Screenshots and JSON results of the PowerShell helpers. */
  evidenceDir: string;
}

/** Null when the spec is not run by the smoke workflow (for example by `pnpm test-e2e`). */
export function smokeConfig(): SmokeConfig | null {
  const installDir = process.env.MODELFORGE_INSTALL_DIR ?? '';
  const exe =
    process.env.MODELFORGE_EXE ?? (installDir ? path.join(installDir, 'ModelForge.exe') : '');
  if (!exe) {
    return null;
  }
  const stubPort = Number(process.env.MODELFORGE_STUB_PORT ?? '47372');
  const scenario = process.env.MODELFORGE_SMOKE_SCENARIO ?? 'primary';
  const stateDir =
    process.env.MODELFORGE_SMOKE_STATE_DIR ?? path.join(os.tmpdir(), `modelforge-smoke-${scenario}`);
  return {
    exe,
    installDir: installDir || path.dirname(exe),
    scenario,
    stubPort,
    stubUrl: `http://127.0.0.1:${stubPort}`,
    stateDir,
    appPath: process.env.MODELFORGE_SMOKE_APP_PATH ?? '',
    locale: process.env.MODELFORGE_SMOKE_LOCALE ?? 'zh-CN',
    profileRoot: process.env.MODELFORGE_SMOKE_PROFILE_ROOT || null,
    installer: process.env.MODELFORGE_INSTALLER ?? '',
    evidenceDir: process.env.MODELFORGE_SMOKE_EVIDENCE_DIR ?? path.join(stateDir, 'evidence'),
  };
}

/** The directory of this file; the PowerShell helpers live in `scripts/` next to it. */
export const SMOKE_DIR = __dirname;

// ---------------------------------------------------------------------------------------------
// Clean-machine environment of the app
// ---------------------------------------------------------------------------------------------

/** Variables every Windows logon session has; everything else from the runner is dropped. */
const BASE_ENV_KEYS = [
  'ALLUSERSPROFILE',
  'APPDATA',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'COMPUTERNAME',
  'ComSpec',
  'DriverData',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'LOGONSERVER',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'PUBLIC',
  'SESSIONNAME',
  'SystemDrive',
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERDOMAIN_ROAMINGPROFILE',
  'USERNAME',
  'USERPROFILE',
  'windir',
];

/** Commands a clean student machine does not have (requirement 7.2). */
export const FORBIDDEN_COMMANDS = [
  'node',
  'npm',
  'npx',
  'pnpm',
  'corepack',
  'cargo',
  'rustc',
  'rustup',
  'codex',
  'codex-acp',
  'claude',
  'claude-code-acp',
  'claude-agent-acp',
];

/** Optional runtimes the smoke machine has installed (requirement 7.3). */
export const REQUIRED_COMMANDS = ['python', 'typst'];

/** Model id the stub lists; it matches neither goose's Responses-API nor any pricing entry. */
export const STUB_MODEL = 'stub-model';

/**
 * Strict mode (the default; MODELFORGE_SMOKE_WIZARD_STRICT is anything but "0"): wizard step 2
 * has to save the stub provider in the built-in kernel, its checks are hard assertions, and every
 * later flow (chat, Python, paper, upgrade) runs on that configuration alone; the harness
 * supplies no endpoint, model or key. Soft mode ("0") keeps a fallback for product regressions:
 * the wizard checks are soft and `ensureKernelSeeded` stands in for what the wizard did not save,
 * reported as a `harness-substitution` annotation, so the later flows are still covered.
 */
export const WIZARD_STRICT = process.env.MODELFORGE_SMOKE_WIZARD_STRICT !== '0';

/** Provider behind the "OpenAI" entry of wizard step 1; it takes any OpenAI-compatible address. */
export const WIZARD_PROVIDER = 'openai';

/** API address typed into wizard step 2: the stub's OpenAI-compatible base URL. */
export function wizardAddress(cfg: SmokeConfig): string {
  return `${cfg.stubUrl}/v1`;
}

/** Dummy key of the soft-mode fallback; the wizard is given a key of its own. */
export const SMOKE_KERNEL_KEY = 'sk-modelforge-smoke-not-a-real-key';

/**
 * Soft-mode fallback variables. goose reads them before config.yaml and its secret store
 * (`resolve_base_url` in providers/openai_def.rs, `get_active_provider` / `get_active_model` in
 * config/providers.rs, `Config::get_param` / `get_secrets`), so the kernel talks to the stub
 * whatever the wizard left in its configuration.
 */
function fallbackKernelEnv(cfg: SmokeConfig): Record<string, string> {
  return {
    OPENAI_HOST: cfg.stubUrl,
    OPENAI_BASE_PATH: 'v1/chat/completions',
    OPENAI_API_KEY: SMOKE_KERNEL_KEY,
    GOOSE_PROVIDER: WIZARD_PROVIDER,
    GOOSE_MODEL: STUB_MODEL,
  };
}

/**
 * Extra environment for launches after the wizard. Empty in strict mode: the kernel has to find
 * the endpoint, model and key the wizard saved. In soft mode the fallback variables, once
 * `ensureKernelSeeded` found the wizard's configuration missing.
 */
export function kernelEnv(cfg: SmokeConfig): Record<string, string> {
  return !WIZARD_STRICT && readState(cfg).providerSeeded ? fallbackKernelEnv(cfg) : {};
}

function envLookup(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      map.set(key.toLowerCase(), value);
    }
  }
  return map;
}

/** Environment the app is started with; `debugPort` 0 is used for path calculations only. */
export function appEnv(
  cfg: SmokeConfig,
  debugPort: number,
  extra: Record<string, string> = {}
): Record<string, string> {
  const current = envLookup();
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = current.get(key.toLowerCase());
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.Path = cfg.appPath || current.get('path') || '';
  if (cfg.profileRoot) {
    const root = cfg.profileRoot;
    env.USERPROFILE = root;
    env.HOMEDRIVE = root.slice(0, 2);
    env.HOMEPATH = root.slice(2);
    env.APPDATA = path.join(root, 'AppData', 'Roaming');
    env.LOCALAPPDATA = path.join(root, 'AppData', 'Local');
    env.TEMP = path.join(root, 'AppData', 'Local', 'Temp');
    env.TMP = env.TEMP;
  }
  if (debugPort > 0) {
    env.ENABLE_PLAYWRIGHT = 'true';
    env.PLAYWRIGHT_DEBUG_PORT = String(debugPort);
  }
  // Harness choices, not part of a user's machine: a fixed UI language for the selectors, no
  // telemetry from CI, and loopback traffic kept off any proxy.
  env.GOOSE_LOCALE = cfg.locale;
  env.GOOSE_TELEMETRY_OFF = '1';
  env.NO_PROXY = '127.0.0.1,localhost';
  env.no_proxy = env.NO_PROXY;
  // Debug logs from the kernel (it inherits the app's environment), so a session that does not
  // start shows which extension the kernel is still waiting for.
  env.RUST_LOG = current.get('rust_log') || 'warn,goose=debug,mcp_client=debug';
  return { ...env, ...extra };
}

/** First match of `command` on a Windows PATH, honouring PATHEXT. */
export function findOnPath(command: string, pathValue: string, pathext: string): string | null {
  const extensions = pathext
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean);
  for (const dir of pathValue.split(';').map((entry) => entry.trim()).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${command}${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // Not there.
      }
    }
  }
  return null;
}

export interface CleanEnvironmentReport {
  path: string;
  forbiddenFound: string[];
  requiredMissing: string[];
  versions: Record<string, string>;
}

/** Requirement 7.2/7.3: what the app can reach on its PATH. */
export function checkCleanEnvironment(cfg: SmokeConfig): CleanEnvironmentReport {
  const env = appEnv(cfg, 0);
  const pathext = env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  const forbiddenFound: string[] = [];
  for (const command of FORBIDDEN_COMMANDS) {
    const found = findOnPath(command, env.Path, pathext);
    if (found) {
      forbiddenFound.push(`${command} -> ${found}`);
    }
  }
  const requiredMissing: string[] = [];
  const versions: Record<string, string> = {};
  for (const command of REQUIRED_COMMANDS) {
    const found = findOnPath(command, env.Path, pathext);
    if (!found) {
      requiredMissing.push(command);
      continue;
    }
    const probe = spawnSync(found, ['--version'], { env, encoding: 'utf8', timeout: 30_000 });
    versions[command] = `${(probe.stdout || probe.stderr || '').trim()} (${found})`;
  }
  return { path: env.Path, forbiddenFound, requiredMissing, versions };
}

// ---------------------------------------------------------------------------------------------
// On-disk locations (Windows)
// ---------------------------------------------------------------------------------------------

export interface AppPaths {
  home: string;
  appData: string;
  localAppData: string;
  /** Electron userData: productName "ModelForge" (package.json). */
  userData: string;
  settingsFile: string;
  recentDirsFile: string;
  credentialsFile: string;
  appLogsDir: string;
  updaterCache: string;
  /** Kernel directories: etcetera's Windows strategy, top level "Block", app "goose". */
  gooseRoot: string;
  gooseLocalRoot: string;
  gooseConfigFile: string;
  sessionsDb: string;
  gooseLogsDir: string;
}

export function appPaths(cfg: SmokeConfig): AppPaths {
  const env = appEnv(cfg, 0);
  const home = env.USERPROFILE || os.homedir();
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const userData = path.join(appData, 'ModelForge');
  const gooseRoot = path.join(appData, 'Block', 'goose');
  return {
    home,
    appData,
    localAppData,
    userData,
    settingsFile: path.join(userData, 'settings.json'),
    recentDirsFile: path.join(userData, 'recent-dirs.json'),
    credentialsFile: path.join(userData, 'agent-kernel-secrets.json'),
    appLogsDir: path.join(userData, 'logs'),
    updaterCache: path.join(localAppData, 'modelforge-updater'),
    gooseRoot,
    gooseLocalRoot: path.join(localAppData, 'Block', 'goose'),
    gooseConfigFile: path.join(gooseRoot, 'config', 'config.yaml'),
    sessionsDb: path.join(gooseRoot, 'data', 'sessions', 'sessions.db'),
    gooseLogsDir: path.join(gooseRoot, 'data', 'logs'),
  };
}

/** Parent folder for Projects: under Documents, with Chinese characters and a space. */
export function projectParentDir(cfg: SmokeConfig): string {
  return path.join(appPaths(cfg).home, 'Documents', 'ModelForge 项目');
}

export function hasCjkAndSpace(value: string): boolean {
  return /[\u4e00-\u9fff]/.test(value) && value.includes(' ');
}

// ---------------------------------------------------------------------------------------------
// State shared between tests and between workflow steps
// ---------------------------------------------------------------------------------------------

export interface SmokeState {
  firstShell?: string;
  firstShellMs?: number;
  /** Wizard step 2 ended with "连接成功" and no error, so the provider was saved. */
  wizardProviderSaved?: boolean;
  wizardCompleted?: boolean;
  /** Soft mode: the kernel runs on the harness fallback (`kernelEnv`), not the wizard's configuration. */
  providerSeeded?: boolean;
  projectDir?: string;
  exampleId?: string;
  /** How the Project was created: the wizard button, the same IPC called directly, or a folder. */
  projectVia?: 'wizard-button' | 'wizard-ipc' | 'folder';
  paperPdf?: string;
}

function stateFile(cfg: SmokeConfig): string {
  return path.join(cfg.stateDir, 'state.json');
}

export function readState(cfg: SmokeConfig): SmokeState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(cfg), 'utf8')) as SmokeState;
  } catch {
    return {};
  }
}

export function writeState(cfg: SmokeConfig, patch: Partial<SmokeState>): SmokeState {
  const next = { ...readState(cfg), ...patch };
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  fs.writeFileSync(stateFile(cfg), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function annotate(testInfo: TestInfo, type: string, description: string): void {
  testInfo.annotations.push({ type, description });
  console.log(`[${type}] ${description}`);
}

// ---------------------------------------------------------------------------------------------
// Launching and closing the installed app
// ---------------------------------------------------------------------------------------------

export interface LaunchedApp {
  page: Page;
  browser: Browser;
  child: ChildProcess;
  spawnedAt: number;
  /** When the renderer page of the main window became reachable. */
  windowAt: number;
  pageErrors: string[];
  consoleErrors: string[];
  snap: (name: string) => Promise<void>;
  /** Writes what the app and its kernel are doing (process tree, Node shim state) to the log. */
  diagnose: (reason: string) => Promise<void>;
  close: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function powershell(script: string, timeoutMs = 60_000): string {
  // EncodedCommand sidesteps quoting of the non-ASCII install path.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}

/** Stops ModelForge.exe and goose.exe started from the install directory (left-overs only). */
export function sweepAppProcesses(cfg: SmokeConfig): string {
  const dir = cfg.installDir.replace(/'/g, "''");
  return powershell(
    [
      `$dir = '${dir}'`,
      "$procs = Get-CimInstance Win32_Process -Filter \"Name='ModelForge.exe' OR Name='goose.exe'\" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) }",
      '$procs | ForEach-Object { Write-Output ("stopping " + $_.Name + " " + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
      'if ($procs) { Start-Sleep -Seconds 2 }',
    ].join('; ')
  );
}

/** A PowerShell single-quoted string literal. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The process tree under `rootPid` with each process's age and command line, so a stuck step
 * shows what the kernel was waiting for (for example an extension still being downloaded).
 * Command lines carry no secrets here: the kernel gets its keys through the environment.
 */
export function describeProcessTree(rootPid: number): string {
  return powershell(
    [
      `$root = ${Math.trunc(rootPid)}`,
      '$all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)',
      '$children = @{}',
      'foreach ($p in $all) {',
      '  $parent = [int]$p.ParentProcessId',
      '  if (-not $children.ContainsKey($parent)) { $children[$parent] = New-Object System.Collections.ArrayList }',
      '  [void]$children[$parent].Add($p)',
      '}',
      '$now = Get-Date',
      'function Show-Tree([int]$id, [int]$depth) {',
      '  if ($depth -gt 12 -or -not $children.ContainsKey($id)) { return }',
      '  foreach ($c in $children[$id]) {',
      '    $cmd = [string]$c.CommandLine',
      "    if ($cmd.Length -gt 500) { $cmd = $cmd.Substring(0, 500) + ' ...' }",
      '    $age = -1',
      '    if ($c.CreationDate) { $age = [int]($now - $c.CreationDate).TotalSeconds }',
      "    Write-Output ('{0}{1} {2} ({3} s) {4}' -f ('  ' * $depth), $c.ProcessId, $c.Name, $age, $cmd)",
      '    Show-Tree ([int]$c.ProcessId) ($depth + 1)',
      '  }',
      '}',
      '$self = $all | Where-Object { [int]$_.ProcessId -eq $root } | Select-Object -First 1',
      "if ($self) { Write-Output ('{0} {1}' -f $self.ProcessId, $self.Name) } else { Write-Output ('process {0} is gone' -f $root) }",
      'Show-Tree $root 1',
    ].join('\n')
  );
}

/**
 * State of the portable Node.js that the bundled `npx.cmd` shim downloads on first use
 * (src/platform/windows/bin/npx.cmd) and of the npx package cache, for the app's own profile.
 */
export function describeNodeShim(localAppData: string, temp: string): string {
  return powershell(
    [
      `$local = ${psQuote(localAppData)}`,
      `$temp = ${psQuote(temp)}`,
      "$nodeDir = Join-Path $local 'Goose\\node'",
      "Write-Output ('portable Node {0}: {1}' -f $nodeDir, (Test-Path -LiteralPath $nodeDir))",
      'if (Test-Path -LiteralPath $nodeDir) {',
      "  Get-ChildItem -LiteralPath $nodeDir -Filter 'node-v*.installed' -ErrorAction SilentlyContinue | ForEach-Object { Write-Output ('  marker ' + $_.Name) }",
      '}',
      "Get-ChildItem -LiteralPath $temp -Filter 'goose-node-*' -ErrorAction SilentlyContinue | ForEach-Object {",
      '  if ($_.PSIsContainer) {',
      '    $n = @(Get-ChildItem -LiteralPath $_.FullName -Recurse -File -ErrorAction SilentlyContinue).Count',
      "    Write-Output ('{0} (directory, {1} files)' -f $_.FullName, $n)",
      '  } else {',
      "    Write-Output ('{0} ({1} bytes, written {2:HH:mm:ss})' -f $_.FullName, $_.Length, $_.LastWriteTime)",
      '  }',
      '}',
      "$npx = Join-Path $local 'npm-cache\\_npx'",
      "if (Test-Path -LiteralPath $npx) { Write-Output ('npx cache entries: ' + @(Get-ChildItem -LiteralPath $npx -ErrorAction SilentlyContinue).Count) } else { Write-Output 'npx cache: none' }",
    ].join('\n')
  );
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function connectCdp(
  port: number,
  timeoutMs: number,
  exited: () => string | null
): Promise<Browser> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    const exit = exited();
    if (exit) {
      throw new Error(`ModelForge.exe ${exit} before its debugging port opened`);
    }
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5_000 });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(250);
    }
  }
  throw new Error(`could not attach to ModelForge over CDP within ${timeoutMs} ms: ${lastError}`);
}

async function firstAppPage(browser: Browser, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        const url = page.url();
        if (!url.startsWith('devtools:') && (url.startsWith('file:') || url.includes('main_window'))) {
          return page;
        }
      }
    }
    await sleep(200);
  }
  throw new Error(`no ModelForge window appeared within ${timeoutMs} ms`);
}

export interface LaunchOptions {
  args?: string[];
  /** Budget for the window to appear (CDP attach + first renderer page). */
  windowTimeoutMs?: number;
  /** Extra variables on top of `appEnv` (for example `kernelEnv(cfg)`). */
  env?: Record<string, string>;
}

export async function launchApp(
  cfg: SmokeConfig,
  testInfo: TestInfo,
  label: string,
  options: LaunchOptions = {}
): Promise<LaunchedApp> {
  const leftovers = sweepAppProcesses(cfg);
  if (leftovers) {
    console.log(`[harness] ${leftovers}`);
  }
  const port = await freePort();
  const env = appEnv(cfg, port, options.env ?? {});
  const args = [...(options.args ?? [])];
  if (cfg.profileRoot) {
    const userData = path.join(env.APPDATA, 'ModelForge');
    for (const dir of [env.APPDATA, env.LOCALAPPDATA, env.TEMP, userData]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    args.push(`--user-data-dir=${userData}`);
  }

  const logPath = testInfo.outputPath(`${label}-app-output.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.createWriteStream(logPath, { flags: 'a' });
  log.write(`[harness] ${new Date().toISOString()} launching ${cfg.exe} ${JSON.stringify(args)}\n`);
  log.write(`[harness] Path=${env.Path}\n`);
  log.write(`[harness] extra env: ${Object.keys(options.env ?? {}).join(', ') || '(none)'}\n`);

  const spawnedAt = Date.now();
  // Started from the install directory, as the Start menu shortcut does.
  const child = spawn(cfg.exe, args, {
    cwd: cfg.installDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  child.stdout?.on('data', (chunk: Buffer) => log.write(chunk));
  child.stderr?.on('data', (chunk: Buffer) => log.write(chunk));
  let exitInfo: string | null = null;
  child.on('exit', (code, signal) => {
    exitInfo = `exited with code ${code} (signal ${signal})`;
    log.write(`\n[harness] app ${exitInfo}\n`);
  });
  child.on('error', (error) => {
    exitInfo = `failed to start: ${error.message}`;
    log.write(`\n[harness] app ${exitInfo}\n`);
  });

  const windowTimeoutMs = options.windowTimeoutMs ?? 90_000;
  let browser: Browser;
  let page: Page;
  try {
    browser = await connectCdp(port, windowTimeoutMs, () => exitInfo);
    page = await firstAppPage(browser, Math.max(5_000, windowTimeoutMs - (Date.now() - spawnedAt)));
  } catch (error) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    log.end();
    await testInfo.attach(`${label}-app-output.log`, { path: logPath, contentType: 'text/plain' });
    throw error;
  }
  const windowAt = Date.now();
  log.write(`[harness] window reachable after ${windowAt - spawnedAt} ms\n`);

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => {
    pageErrors.push(`${error.name}: ${error.message}`);
    log.write(`[pageerror] ${error.stack ?? error.message}\n`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      const text = `[console.${message.type()}] ${message.text()}`;
      if (message.type() === 'error') {
        consoleErrors.push(text);
      }
      log.write(`${text}\n`);
    }
  });

  let closed = false;
  const snap = async (name: string) => {
    try {
      const file = testInfo.outputPath(`${label}-${name}.png`);
      await page.screenshot({ path: file, fullPage: false, timeout: 15_000 });
      await testInfo.attach(`${label}-${name}.png`, { path: file, contentType: 'image/png' });
    } catch (error) {
      log.write(`[harness] screenshot ${name} failed: ${String(error)}\n`);
    }
  };

  const diagnose = async (reason: string) => {
    const lines = [
      `[diagnose] ${new Date().toISOString()} ${reason.split('\n')[0].slice(0, 300)}`,
      `[diagnose] ${Math.round((Date.now() - spawnedAt) / 1000)} s after launch; processes under the app:`,
      child.pid ? describeProcessTree(child.pid) : '(the app has no pid)',
      '[diagnose] portable Node of the npx shim and the npx cache:',
      describeNodeShim(env.LOCALAPPDATA || '', env.TEMP || ''),
    ];
    const text = `${lines.join('\n')}\n`;
    log.write(text);
    console.log(text);
    await testInfo
      .attach(`${label}-diagnose.txt`, { body: text, contentType: 'text/plain' })
      .catch(() => {});
  };

  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    // Close the window as a user would; on Windows the app quits with its last window.
    await page.evaluate(() => window.close()).catch(() => {});
    let exited = await waitForExit(child, 15_000);
    await browser.close().catch(() => {});
    if (!exited) {
      log.write('[harness] app did not quit after its window closed; killing the process tree\n');
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      exited = await waitForExit(child, 10_000);
    }
    const swept = sweepAppProcesses(cfg);
    if (swept) {
      log.write(`[harness] ${swept}\n`);
    }
    log.end();
    await new Promise((resolve) => log.once('close', resolve).once('error', resolve));
    await testInfo.attach(`${label}-app-output.log`, { path: logPath, contentType: 'text/plain' });
  };

  return {
    page,
    browser,
    child,
    spawnedAt,
    windowAt,
    pageErrors,
    consoleErrors,
    snap,
    diagnose,
    close,
  };
}

/** Runs `body` with a freshly launched app; screenshots on failure, always closes the app. */
export async function withApp<T>(
  cfg: SmokeConfig,
  testInfo: TestInfo,
  label: string,
  options: LaunchOptions,
  body: (app: LaunchedApp) => Promise<T>
): Promise<T> {
  const app = await launchApp(cfg, testInfo, label, options);
  try {
    return await body(app);
  } catch (error) {
    await app.diagnose(String(error)).catch(() => {});
    await app.snap('failure');
    throw error;
  } finally {
    await app.close();
  }
}

// ---------------------------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------------------------

export type Shell = 'wizard' | 'main' | `error: ${string}`;

/** Waits for the first meaningful screen: the onboarding wizard, the main window, or an error. */
export async function waitForShell(
  page: Page,
  timeoutMs: number,
  expected?: 'wizard' | 'main'
): Promise<Shell> {
  const deadline = Date.now() + timeoutMs;
  const wizard = page.getByText(/第 \d 步\/共 4 步/).first();
  const main = page.locator('[data-testid="chat-input"]').first();
  const guardError = page
    .getByText(/无法连接到 ModelForge 服务器|Unable to connect to ModelForge server/)
    .first();
  const crash = page.getByRole('heading', { name: /^(嘎！|Honk!)$/ }).first();
  while (Date.now() < deadline) {
    // During the wizard's final transition, its old text can remain mounted briefly after the
    // main page is already visible. Callers that know the expected destination must wait for
    // that destination instead of accepting the stale wizard as the shell.
    if (expected === 'main') {
      if (await main.isVisible().catch(() => false)) return 'main';
    } else if (expected === 'wizard') {
      if (await wizard.isVisible().catch(() => false)) return 'wizard';
    } else {
      if (await wizard.isVisible().catch(() => false)) return 'wizard';
      if (await main.isVisible().catch(() => false)) return 'main';
    }
    if (await guardError.isVisible().catch(() => false)) return 'error: guard could not reach the kernel';
    if (await crash.isVisible().catch(() => false)) return 'error: renderer crash screen';
    await sleep(200);
  }
  return `error: neither the wizard nor the main window appeared within ${timeoutMs} ms`;
}

export interface DismissOptions {
  /** Leave the "unfinished tasks" prompt open, for the test that checks it (task 25.5). */
  keepResumePrompt?: boolean;
}

/** Closes first-run prompts that sit on top of the main window (telemetry consent, announcements). */
export async function dismissInterruptions(
  page: Page,
  options: DismissOptions = {}
): Promise<string[]> {
  const dismissed: string[] = [];
  for (const name of [/^(不用了|No thanks)$/, /^(知道了！|Got it!)$/]) {
    const button = page.getByRole('button', { name }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 5_000 }).catch(() => {});
      dismissed.push(String(name));
    }
  }
  if (options.keepResumePrompt) {
    return dismissed;
  }

  // A previous interrupted task can open an app-level modal on startup. Do not inspect, start,
  // or synthesize that task: dismiss each card through the product's own "Do not resume" action.
  // The modal may contain more than one task, and it closes only after the last dismissal is
  // persisted, so re-query the first button after every click.
  const resumeDialog = page
    .getByRole('dialog')
    .filter({ hasText: /未完成的任务|Unfinished tasks/ })
    .first();
  const dismissResume = resumeDialog
    .getByRole('button', { name: /^(放弃恢复|Do not resume)$/ })
    .first();
  while (await dismissResume.isVisible().catch(() => false)) {
    await dismissResume.click({ timeout: 10_000 });
    dismissed.push('unfinished task resume');
    await sleep(200);
  }
  return dismissed;
}

export async function sendChat(page: Page, text: string): Promise<void> {
  await dismissInterruptions(page);
  const input = page.locator('[data-testid="chat-input"]').first();
  await input.waitFor({ state: 'visible', timeout: 60_000 });
  await input.click();
  await input.fill(text);
  await input.press('Enter');
}

/**
 * Waits for an assistant message matching `pattern`. Clicks "allow once" when the app asks for
 * tool approval (the default mode is auto, so it should not) and reports that it did.
 */
export async function waitForAssistant(
  page: Page,
  testInfo: TestInfo,
  pattern: RegExp,
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const messages = page.locator('[data-testid="message-container"].assistant');
  const approve = page.getByRole('button', { name: /^(仅此次允许|允许一次|Allow Once)$/ }).first();
  let seen: string[] = [];
  while (Date.now() < deadline) {
    await dismissInterruptions(page);
    if (await approve.isVisible().catch(() => false)) {
      annotate(testInfo, 'tool-approval', 'the app asked to approve a tool call; clicked "allow once"');
      await approve.click({ timeout: 5_000 }).catch(() => {});
    }
    seen = await messages.allInnerTexts().catch(() => seen);
    const hit = seen.find((text) => pattern.test(text));
    if (hit !== undefined) {
      return hit;
    }
    await sleep(1_000);
  }
  // Tells "the message never left the input because the session was still being created" apart
  // from "the model was asked but its reply did not arrive".
  const creatingSession = await page
    .getByText(/正在加载对话|loading conversation/i)
    .first()
    .isVisible()
    .catch(() => false);
  const unsent = await page
    .locator('[data-testid="chat-input"]')
    .first()
    .inputValue({ timeout: 5_000 })
    .catch(() => '');
  throw new Error(
    `no assistant message matched ${pattern} within ${timeoutMs} ms` +
      `; session still being created ("正在加载对话…" shown): ${creatingSession ? 'yes' : 'no'}` +
      `; message still in the chat input: ${unsent.trim() ? 'yes' : 'no'}` +
      `; assistant messages so far:\n` +
      seen.join('\n---\n').slice(-4_000)
  );
}

// ---------------------------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------------------------

export interface StubRequest {
  at: string;
  method: string;
  path: string;
  /** Whether an Authorization header was sent (its value is never logged). */
  auth?: boolean;
  /** Chat requests: the `model` of the request body. */
  model?: string;
  nonces?: string[];
  offeredTools?: number;
  offeredToolNames?: string[];
  toolResults?: { toolCallId: string | null; text: string }[];
  reply?: { kind: string; name?: string; arguments?: unknown; text?: string };
  error?: string;
}

export function newNonce(): string {
  return crypto.randomBytes(6).toString('hex');
}

/** Marker that makes the stub answer with one call of `tool` (see openai-stub.cjs). */
export function toolDirective(tool: string, args: Record<string, unknown>): string {
  return `MFSMOKE_TOOL:${Buffer.from(JSON.stringify({ tool, arguments: args }), 'utf8').toString('base64url')}`;
}

export async function stubRequests(cfg: SmokeConfig, nonce?: string): Promise<StubRequest[]> {
  const url = `${cfg.stubUrl}/__requests${nonce ? `?nonce=${encodeURIComponent(nonce)}` : ''}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`stub request log unavailable: HTTP ${response.status}`);
  }
  return (await response.json()) as StubRequest[];
}

export interface KernelChatUse {
  requests: number;
  /** Distinct request paths: the address the kernel resolved plus goose's chat path. */
  paths: string[];
  /** Distinct `model` values. */
  models: string[];
  /** Requests without an Authorization header, i.e. without the key. */
  withoutKey: number;
  /** Distinct tool names the kernel offered the model in these requests. */
  offeredToolNames: string[];
}

/**
 * How the kernel called the stub for the chat message tagged with `nonce`. With the wizard's
 * configuration (`OPENAI_BASE_URL` <stub>/v1) the path is /v1/chat/completions, the model is
 * the one typed in step 2, and every request carries the key from the kernel's secret store.
 */
export async function kernelChatUse(cfg: SmokeConfig, nonce: string): Promise<KernelChatUse> {
  const posts = (await stubRequests(cfg, nonce)).filter((entry) => entry.method === 'POST');
  return {
    requests: posts.length,
    paths: [...new Set(posts.map((entry) => entry.path))],
    models: [...new Set(posts.map((entry) => entry.model ?? ''))],
    withoutKey: posts.filter((entry) => !entry.auth).length,
    offeredToolNames: [...new Set(posts.flatMap((entry) => entry.offeredToolNames ?? []))].sort(),
  };
}

// ---------------------------------------------------------------------------------------------
// App bridge calls (same IPC the UI uses), for steps that would need a native dialog
// ---------------------------------------------------------------------------------------------

export interface CreatedProject {
  projectDir: string;
  exampleId: string;
  title: string;
}

/**
 * Creates a Project from the first locally available example through the IPC the wizard's
 * "创建并打开" button uses, and remembers it as the most recent folder. The wizard picks the
 * parent folder with a native dialog, which CDP cannot drive; this is the only substitution.
 */
export async function createExampleProject(page: Page, parentDir: string): Promise<CreatedProject> {
  fs.mkdirSync(parentDir, { recursive: true });
  const result = await page.evaluate(async (parent: string) => {
    interface Entry {
      needsDownload?: boolean;
      manifest: { id: string; title: string };
    }
    interface Bridge {
      examplesList: () => Promise<Entry[]>;
      projectCreateFromExample: (request: {
        exampleId: string;
        name: string;
        parentDir: string;
      }) => Promise<{ ok: boolean; data?: { projectDir: string }; error?: unknown }>;
      addRecentDir: (dir: string) => Promise<boolean>;
    }
    const bridge = (window as unknown as { electron: Bridge }).electron;
    const local = (await bridge.examplesList()).filter((entry) => !entry.needsDownload);
    if (local.length === 0) {
      return { ok: false as const, error: 'no locally available example' };
    }
    const entry = local[0];
    const created = await bridge.projectCreateFromExample({
      exampleId: entry.manifest.id,
      name: entry.manifest.title,
      parentDir: parent,
    });
    if (!created.ok || !created.data) {
      return { ok: false as const, error: JSON.stringify(created.error) };
    }
    await bridge.addRecentDir(created.data.projectDir);
    return {
      ok: true as const,
      projectDir: created.data.projectDir,
      exampleId: entry.manifest.id,
      title: entry.manifest.title,
    };
  }, parentDir);
  if (!result.ok) {
    throw new Error(`creating the example Project failed: ${result.error}`);
  }
  return { projectDir: result.projectDir, exampleId: result.exampleId, title: result.title };
}

export async function listRecentDirs(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { electron: { listRecentDirs: () => Promise<string[]> } }).electron.listRecentDirs()
  );
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

export function writeProjectFile(projectDir: string, relative: string, content: string): string {
  const target = path.join(projectDir, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

export interface RunRecordSummary {
  file: string;
  exitCode: unknown;
  failure: unknown;
  command: unknown;
  codePath: unknown;
}

/** Run_Records of the Project (`.modelforge/runs/<runId>.json`), newest first. */
export function runRecords(projectDir: string): RunRecordSummary[] {
  const dir = path.join(projectDir, '.modelforge', 'runs');
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.meta.json') && !name.startsWith('.'))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .map((file) => {
      try {
        const record = JSON.parse(fs.readFileSync(file, 'utf8')) as {
          exitCode?: unknown;
          failure?: unknown;
          command?: unknown;
          code?: { path?: unknown };
        };
        return {
          file,
          exitCode: record.exitCode,
          failure: record.failure ?? null,
          command: record.command,
          codePath: record.code?.path,
        };
      } catch (error) {
        return { file, exitCode: undefined, failure: `unparsable: ${String(error)}`, command: null, codePath: null };
      }
    });
}

export function sha256File(file: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/** Relative path -> SHA-256 of every file under `root` (forward slashes). */
export function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out[path.relative(root, full).split(path.sep).join('/')] = sha256File(full) ?? '';
      }
    }
  };
  if (fs.existsSync(root)) {
    walk(root);
  }
  return out;
}

/** Block mappings of goose's config.yaml: scalars as their text, nested mappings as objects. */
export interface GooseConfigMap {
  [key: string]: string | GooseConfigMap;
}

/** Text of a YAML scalar as serde_yaml writes it: plain, 'single' or "double" quoted. */
function yamlScalar(raw: string): string {
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return String(JSON.parse(text));
    } catch {
      return text.slice(1, -1);
    }
  }
  return text;
}

/** Key and the rest of a `key: value` line, or null for anything else. */
function yamlKeyLine(content: string): { key: string; rest: string } | null {
  const quoted = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(?:\s+(.*))?$/.exec(content);
  if (quoted) {
    return { key: yamlScalar(quoted[1]), rest: (quoted[2] ?? '').trim() };
  }
  const plain = /^([^\s'"#][^:]*?)\s*:(?:\s+(.*))?$/.exec(content);
  if (plain) {
    return { key: plain[1], rest: (plain[2] ?? '').trim() };
  }
  return null;
}

/**
 * The block mappings of goose's config.yaml (serde_yaml output), enough to compare what the app
 * saved; not a general YAML parser. Sequences and block scalars are skipped, flow collections
 * are kept as their text.
 */
export function parseGooseConfig(text: string): GooseConfigMap {
  const root: GooseConfigMap = {};
  // Open mappings, innermost last, with the indentation of the key that opened each.
  const open: { indent: number; map: GooseConfigMap }[] = [{ indent: -1, map: root }];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const indentOf = (line: string) => line.length - line.trimStart().length;
  // Index of the last line nested under the line at `index` (blank lines included).
  const endOfNested = (index: number, indent: number) => {
    let last = index;
    while (
      last + 1 < lines.length &&
      (lines[last + 1].trim() === '' || indentOf(lines[last + 1]) > indent)
    ) {
      last += 1;
    }
    return last;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const content = lines[index].trim();
    if (content === '' || content.startsWith('#') || content === '---' || content === '...') {
      continue;
    }
    const indent = indentOf(lines[index]);
    if (content === '-' || content.startsWith('- ')) {
      // A sequence item, with whatever is nested in it.
      index = endOfNested(index, indent);
      continue;
    }
    const entry = yamlKeyLine(content);
    if (!entry) {
      continue;
    }
    while (open.length > 1 && open[open.length - 1].indent >= indent) {
      open.pop();
    }
    const parent = open[open.length - 1].map;
    if (entry.rest === '') {
      const child: GooseConfigMap = {};
      parent[entry.key] = child;
      open.push({ indent, map: child });
      continue;
    }
    // A scalar (block scalars `|` / `>` only by their indicator); lines nested under it are
    // its continuation.
    parent[entry.key] = /^[|>]/.test(entry.rest) ? '' : yamlScalar(entry.rest);
    index = endOfNested(index, indent);
  }
  return root;
}

/** goose's config.yaml, or an empty mapping when there is none. */
export function readGooseConfig(file: string): GooseConfigMap {
  try {
    return parseGooseConfig(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function scalarAt(config: GooseConfigMap, ...keys: string[]): string | null {
  let value: string | GooseConfigMap | undefined = config;
  for (const key of keys) {
    if (typeof value !== 'object') {
      return null;
    }
    value = value[key];
  }
  return typeof value === 'string' ? value : null;
}

/**
 * What wizard step 2 leaves in the kernel's config.yaml (wizardProviderSetup.ts):
 *
 * - ACP `providers/config/save` stores the address as `OPENAI_BASE_URL` (the endpoint field of
 *   the OpenAI provider) and the key in the kernel's secret store, never in config.yaml;
 * - ACP `defaults/save` makes the provider the default through `set_active_provider`
 *   (crates/goose/src/config/providers.rs): `active_provider: <id>` and
 *   `providers.<id>: { enabled: true, model: <model>, configured: true }`. The legacy
 *   `GOOSE_PROVIDER` / `GOOSE_MODEL` keys are not written; goose reads them only when these
 *   are missing.
 */
export interface WizardKernelConfig {
  activeProvider: string | null;
  model: string | null;
  enabled: string | null;
  configured: string | null;
  baseUrl: string | null;
  /** Whether config.yaml holds an `OPENAI_API_KEY` (it belongs in the secret store). */
  keyInConfigFile: boolean;
}

export function readWizardKernelConfig(cfg: SmokeConfig): WizardKernelConfig {
  const config = readGooseConfig(appPaths(cfg).gooseConfigFile);
  return {
    activeProvider: scalarAt(config, 'active_provider'),
    model: scalarAt(config, 'providers', WIZARD_PROVIDER, 'model'),
    enabled: scalarAt(config, 'providers', WIZARD_PROVIDER, 'enabled'),
    configured: scalarAt(config, 'providers', WIZARD_PROVIDER, 'configured'),
    baseUrl: scalarAt(config, 'OPENAI_BASE_URL'),
    keyInConfigFile: 'OPENAI_API_KEY' in config,
  };
}

/** The configuration after the specs chose OpenAI and typed the stub's address and model. */
export function expectedWizardKernelConfig(cfg: SmokeConfig): WizardKernelConfig {
  return {
    activeProvider: WIZARD_PROVIDER,
    model: STUB_MODEL,
    enabled: 'true',
    configured: 'true',
    baseUrl: wizardAddress(cfg),
    keyInConfigFile: false,
  };
}

/** How the kernel's configuration differs from what the wizard should have saved. */
export function wizardKernelConfigProblems(cfg: SmokeConfig): string[] {
  const saved = readWizardKernelConfig(cfg);
  const expected = expectedWizardKernelConfig(cfg);
  return (Object.keys(expected) as (keyof WizardKernelConfig)[])
    .filter((field) => saved[field] !== expected[field])
    .map(
      (field) =>
        `${field} is ${JSON.stringify(saved[field])}, expected ${JSON.stringify(expected[field])}`
    );
}

/** Entry ids and ciphertexts of the desktop credential store (`{ version, entries }`). */
export function readCredentialEntries(file: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      version?: number;
      entries?: Record<string, string>;
    };
    if (parsed.entries && typeof parsed.entries === 'object') {
      return { ...parsed.entries };
    }
    // Version 1 files are a flat map.
    const { version: _version, ...flat } = parsed as Record<string, unknown>;
    void _version;
    return Object.fromEntries(
      Object.entries(flat).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    );
  } catch {
    return null;
  }
}

export interface SessionRow {
  id: string;
  name: string;
  sessionType: string;
  archived: boolean;
  messages: number;
}

/** Sessions in the kernel's sessions.db, read from a copy (node:sqlite, Node >= 22.13). */
export async function readSessions(dbPath: string): Promise<SessionRow[]> {
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-sessions-'));
  try {
    const copy = path.join(tmp, 'sessions.db');
    fs.copyFileSync(dbPath, copy);
    if (fs.existsSync(`${dbPath}-wal`)) {
      fs.copyFileSync(`${dbPath}-wal`, `${copy}-wal`);
    }
    const sqlite = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (file: string) => {
        prepare: (sql: string) => { all: () => Record<string, unknown>[] };
        close: () => void;
      };
    };
    const db = new sqlite.DatabaseSync(copy);
    try {
      return db
        .prepare(
          'SELECT s.id AS id, s.name AS name, s.session_type AS session_type, s.archived_at AS archived_at, ' +
            '(SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messages ' +
            'FROM sessions s ORDER BY s.id'
        )
        .all()
        .map((row) => ({
          id: String(row.id),
          name: String(row.name ?? ''),
          sessionType: String(row.session_type),
          archived: row.archived_at !== null && row.archived_at !== undefined,
          messages: Number(row.messages),
        }));
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}

/**
 * Sessions a user sees in the history: not archived, with messages, and of a type the history
 * lists (the desktop's ACP sessions are `user` when it sends client metadata, else `acp`).
 */
export function visibleSessions(rows: SessionRow[]): SessionRow[] {
  return rows.filter(
    (row) =>
      ['user', 'acp', 'scheduled'].includes(row.sessionType) && !row.archived && row.messages > 0
  );
}

// ---------------------------------------------------------------------------------------------
// Desktop settings and harness-side configuration
// ---------------------------------------------------------------------------------------------

/** Reads a JSON file written by the app or a PowerShell helper (tolerates a UTF-8 BOM). */
export function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as T;
  } catch {
    return null;
  }
}

export interface OnboardingRecord {
  completed?: boolean;
  steps?: Record<string, string>;
}

export function readOnboarding(cfg: SmokeConfig): OnboardingRecord | null {
  const settings = readJsonFile<{ onboarding?: OnboardingRecord }>(appPaths(cfg).settingsFile);
  return settings?.onboarding ?? null;
}

/**
 * Soft-mode fallback; strict mode never calls it. When wizard step 2 did not leave the stub
 * provider in the kernel (`wizardKernelConfigProblems`), later launches get the variables of
 * `fallbackKernelEnv` through `kernelEnv`; config.yaml stays as the wizard wrote it. When the
 * wizard did not finish, an onboarding completion record is written, or the wizard would come
 * back and cover the chat input. Run only while the app is closed. What the harness supplied is
 * reported once as an annotation, so the summary shows what the product did not do.
 */
export function ensureKernelSeeded(cfg: SmokeConfig, testInfo: TestInfo): void {
  if (WIZARD_STRICT) {
    throw new Error('ensureKernelSeeded is the soft-mode fallback; strict mode runs on what the wizard saved');
  }
  const paths = appPaths(cfg);
  const substituted: string[] = [];
  const state = readState(cfg);
  if (!state.providerSeeded) {
    const problems = wizardKernelConfigProblems(cfg);
    if (state.wizardProviderSaved !== true) {
      problems.push('wizard step 2 did not save the provider');
    }
    if (problems.length > 0) {
      writeState(cfg, { providerSeeded: true });
      substituted.push(
        `kernel pointed at the stub through ${Object.keys(fallbackKernelEnv(cfg)).join(', ')} ` +
          `(environment) because ${problems.join('; ')}`
      );
    }
  }

  const onboarding = readOnboarding(cfg);
  if (onboarding?.completed !== true) {
    const settings = readJsonFile<Record<string, unknown>>(paths.settingsFile) ?? {};
    settings.onboarding = {
      completed: true,
      steps: { provider: 'skipped', key: 'skipped', environment: 'skipped', example: 'skipped' },
    };
    fs.mkdirSync(path.dirname(paths.settingsFile), { recursive: true });
    fs.writeFileSync(paths.settingsFile, JSON.stringify(settings, null, 2), 'utf8');
    substituted.push('settings.onboarding (wizard did not complete)');
  }
  if (substituted.length > 0) {
    annotate(testInfo, 'harness-substitution', substituted.join('; '));
  }
}

/**
 * The Project the flows run in. Normally created by the wizard test; when that test did not get
 * that far, a plain folder under the same parent is used and reported.
 */
export function ensureProject(cfg: SmokeConfig, testInfo: TestInfo): string {
  const state = readState(cfg);
  if (state.projectDir && fs.existsSync(state.projectDir)) {
    return state.projectDir;
  }
  const dir = path.join(projectParentDir(cfg), '冒烟 项目');
  fs.mkdirSync(dir, { recursive: true });
  const recentFile = appPaths(cfg).recentDirsFile;
  const recent = readJsonFile<{ dirs?: string[] }>(recentFile)?.dirs ?? [];
  fs.mkdirSync(path.dirname(recentFile), { recursive: true });
  fs.writeFileSync(
    recentFile,
    JSON.stringify({ dirs: [dir, ...recent.filter((entry) => entry !== dir)].slice(0, 10) }),
    'utf8'
  );
  annotate(testInfo, 'harness-substitution', `no Project from the wizard; using the folder ${dir}`);
  writeState(cfg, { projectDir: dir, projectVia: 'folder' });
  return dir;
}

// ---------------------------------------------------------------------------------------------
// PowerShell helpers (scripts/*.ps1)
// ---------------------------------------------------------------------------------------------

export interface HelperResult<T> {
  exitCode: number | null;
  output: string;
  result: T | null;
  resultFile: string;
}

/** Profile variables of the user whose data the app and its uninstaller use. */
const PROFILE_ENV_KEYS = ['USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'];

/**
 * The profile variables the app is started with, for helpers that must act on the same user's
 * data: the uninstaller removes %APPDATA% / %LOCALAPPDATA% folders read from its environment
 * (build/installer.nsh). Empty unless a stand-in profile is used (cn-profile-sim). Otherwise the
 * harness already runs with the profile of the user under test: the runner account in the
 * primary scenario, the new local user in cn-user (Run-AsUserInner.ps1 sets the variables from
 * that user's logon token before starting Playwright).
 */
export function profileEnv(cfg: SmokeConfig): Record<string, string> {
  if (!cfg.profileRoot) {
    return {};
  }
  const env = appEnv(cfg, 0);
  return Object.fromEntries(
    PROFILE_ENV_KEYS.filter((key) => env[key] !== undefined).map((key) => [key, env[key]])
  );
}

/** `base` with `extra` on top; Windows variable names are case-insensitive. */
function mergeEnv(
  base: Record<string, string | undefined>,
  extra: Record<string, string>
): Record<string, string | undefined> {
  const replaced = new Set(Object.keys(extra).map((key) => key.toLowerCase()));
  const kept = Object.entries(base).filter(([key]) => !replaced.has(key.toLowerCase()));
  return { ...Object.fromEntries(kept), ...extra };
}

/**
 * Runs `scripts/<name>` with Windows PowerShell 5.1 (UI Automation and the NSIS installer are
 * driven from there). `-ResultFile` is added; the script writes its JSON result to it. `env`
 * goes on top of the harness's own environment; the script and what it starts inherit it.
 */
export function runHelper<T>(
  cfg: SmokeConfig,
  name: string,
  params: Record<string, string>,
  timeoutMs: number,
  env: Record<string, string> = {}
): HelperResult<T> {
  fs.mkdirSync(cfg.evidenceDir, { recursive: true });
  const resultFile = path.join(
    cfg.evidenceDir,
    `${path.basename(name, '.ps1')}-${Date.now()}.json`
  );
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(SMOKE_DIR, 'scripts', name),
  ];
  for (const [key, value] of Object.entries({ ...params, ResultFile: resultFile })) {
    args.push(`-${key}`, value);
  }
  const exe = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const run = spawnSync(exe, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: false,
    env: mergeEnv(process.env, env),
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}${run.error ? `\n${String(run.error)}` : ''}`;
  console.log(`[helper ${name}] exit ${run.status}\n${output.trim()}`);
  return { exitCode: run.status, output, result: readJsonFile<T>(resultFile), resultFile };
}
