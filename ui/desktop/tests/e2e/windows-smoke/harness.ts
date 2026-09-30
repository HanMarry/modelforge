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
 * Dummy key for the stub. The onboarding wizard keeps the key it tested in the desktop
 * credential store only, and the built-in kernel never reads that store, so the harness hands
 * this key to the kernel through the environment (see `ensureKernelSeeded`).
 */
export const SMOKE_KERNEL_KEY = 'sk-modelforge-smoke-not-a-real-key';

/** Environment for launches after the kernel has been pointed at the stub. */
export function kernelEnv(): Record<string, string> {
  return { OPENAI_API_KEY: SMOKE_KERNEL_KEY };
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
  /** The XDG-style paths build/installer.nsh removes; goose does not use them on Windows. */
  legacyGooseConfig: string;
  legacyGooseData: string;
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
    legacyGooseConfig: path.join(home, '.config', 'goose'),
    legacyGooseData: path.join(home, '.local', 'share', 'goose'),
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
  wizardProviderSaved?: boolean;
  wizardCompleted?: boolean;
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
  /** Extra variables on top of `appEnv` (for example `kernelEnv()`). */
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

  return { page, browser, child, spawnedAt, windowAt, pageErrors, consoleErrors, snap, close };
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
export async function waitForShell(page: Page, timeoutMs: number): Promise<Shell> {
  const deadline = Date.now() + timeoutMs;
  const wizard = page.getByText(/第 \d 步\/共 4 步/).first();
  const main = page.locator('[data-testid="chat-input"]').first();
  const guardError = page
    .getByText(/无法连接到 ModelForge 服务器|Unable to connect to ModelForge server/)
    .first();
  const crash = page.getByRole('heading', { name: /^(嘎！|Honk!)$/ }).first();
  while (Date.now() < deadline) {
    if (await wizard.isVisible().catch(() => false)) return 'wizard';
    if (await main.isVisible().catch(() => false)) return 'main';
    if (await guardError.isVisible().catch(() => false)) return 'error: guard could not reach the kernel';
    if (await crash.isVisible().catch(() => false)) return 'error: renderer crash screen';
    await sleep(200);
  }
  return `error: neither the wizard nor the main window appeared within ${timeoutMs} ms`;
}

/** Closes first-run prompts that sit on top of the main window (telemetry consent, announcements). */
export async function dismissInterruptions(page: Page): Promise<string[]> {
  const dismissed: string[] = [];
  for (const name of [/^(不用了|No thanks)$/, /^(知道了！|Got it!)$/]) {
    const button = page.getByRole('button', { name }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 5_000 }).catch(() => {});
      dismissed.push(String(name));
    }
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
  throw new Error(
    `no assistant message matched ${pattern} within ${timeoutMs} ms; assistant messages so far:\n` +
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

/**
 * Sets top-level keys of goose's flat config.yaml (harness fallback only). Existing lines for
 * those keys are replaced; everything else is kept as it is.
 */
export function upsertGooseConfig(file: string, values: Record<string, string>): void {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const keys = new Set(Object.keys(values));
  const kept = text.split(/\r?\n/).filter((line) => {
    const match = /^([A-Za-z0-9_]+)\s*:/.exec(line);
    return !(match && keys.has(match[1]));
  });
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') {
    kept.pop();
  }
  for (const [key, value] of Object.entries(values)) {
    kept.push(`${key}: ${JSON.stringify(value)}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${kept.join('\n')}\n`, 'utf8');
}

/** Top-level scalar values of goose's config.yaml, for comparisons (not a YAML parser). */
export function readGooseConfigScalars(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) {
    return out;
  }
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (match) {
      out[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  }
  return out;
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
 * Points the kernel at the stub. The wizard stores the default provider (`GOOSE_PROVIDER`) but
 * neither the endpoint nor the key it tested reaches goose's own configuration, so without this
 * the built-in kernel cannot answer. Run only while the app is closed. Every value the harness
 * had to supply is reported as an annotation, so the summary shows what the product did not.
 */
export function ensureKernelSeeded(cfg: SmokeConfig, testInfo: TestInfo): void {
  const paths = appPaths(cfg);
  const current = readGooseConfigScalars(paths.gooseConfigFile);
  const values: Record<string, string> = {
    OPENAI_HOST: cfg.stubUrl,
    OPENAI_BASE_PATH: 'v1/chat/completions',
    GOOSE_MODEL: STUB_MODEL,
  };
  const substituted = ['OPENAI_HOST', 'OPENAI_BASE_PATH', 'GOOSE_MODEL', 'OPENAI_API_KEY (env)'];
  if (current.GOOSE_PROVIDER !== 'openai') {
    values.GOOSE_PROVIDER = 'openai';
    substituted.push(`GOOSE_PROVIDER (was ${current.GOOSE_PROVIDER ?? 'unset'})`);
  }
  upsertGooseConfig(paths.gooseConfigFile, values);

  const onboarding = readOnboarding(cfg);
  if (onboarding?.completed !== true) {
    // Without a completion record the wizard would come back and cover the chat input.
    const settings = readJsonFile<Record<string, unknown>>(paths.settingsFile) ?? {};
    settings.onboarding = {
      completed: true,
      steps: { provider: 'skipped', key: 'skipped', environment: 'skipped', example: 'skipped' },
    };
    fs.mkdirSync(path.dirname(paths.settingsFile), { recursive: true });
    fs.writeFileSync(paths.settingsFile, JSON.stringify(settings, null, 2), 'utf8');
    substituted.push('settings.onboarding (wizard did not complete)');
  }
  if (!readState(cfg).providerSeeded) {
    annotate(testInfo, 'harness-substitution', `kernel pointed at the stub by the harness: ${substituted.join(', ')}`);
  }
  writeState(cfg, { providerSeeded: true });
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

/**
 * Runs `scripts/<name>` with Windows PowerShell 5.1 (UI Automation and the NSIS installer are
 * driven from there). `-ResultFile` is added; the script writes its JSON result to it.
 */
export function runHelper<T>(
  cfg: SmokeConfig,
  name: string,
  params: Record<string, string>,
  timeoutMs: number
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
  const run = spawnSync(exe, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: false });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}${run.error ? `\n${String(run.error)}` : ''}`;
  console.log(`[helper ${name}] exit ${run.status}\n${output.trim()}`);
  return { exitCode: run.status, output, result: readJsonFile<T>(resultFile), resultFile };
}
