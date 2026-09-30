/**
 * Environment probes behind the workspace "环境" panel, the first-run wizard and the
 * diagnostics centre: whether a command-line tool is installed and which version it reports.
 *
 * A tool is looked up on PATH here, not left to the OS when it is started, so that:
 * - every spelling of the PATH variable counts on Windows (`Path`, `PATH`, or both in an
 *   environment object built by spreading `process.env` and assigning one of them);
 * - PATHEXT decides which files are commands on Windows, and a `.cmd`/`.bat` shim runs through
 *   cmd.exe with its path quoted (Node refuses to start a batch file without a shell);
 * - a path with spaces or non-ASCII characters (`C:\模型 工具\...`) is passed as a single
 *   argument and never pasted into a shell command line unquoted;
 * - the current directory is never searched (Windows would otherwise run a `python.exe`
 *   dropped into the directory the app was started from);
 * - a tool that exists but is slow to answer is reported as timed out, not as missing. Starting
 *   a process can take many seconds on a busy machine (an antivirus scanning a new binary, a
 *   disk busy with a large download), so a timed-out attempt is retried within a budget.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { EnvironmentProbe } from '../types/workspaceApi';

export type ProbeEnv = Record<string, string | undefined>;

/** One way of asking a tool for its version. */
export interface ProbeCandidate {
  /** Command name looked up on PATH, or an absolute path (a bundled or well-known location). */
  command: string;
  args: string[];
}

export interface EnvironmentProbeSpec {
  id: string;
  label: string;
  /** Tried in order until one of them answers. */
  candidates: ProbeCandidate[];
}

export type RunOutcome = { kind: 'ok'; line: string } | { kind: 'failed' } | { kind: 'timeout' };

export interface RunOptions {
  env: ProbeEnv;
  platform: NodeJS.Platform;
  timeoutMs: number;
}

export type CommandRunner = (
  file: string,
  args: string[],
  options: RunOptions
) => Promise<RunOutcome>;

export type FileCheck = (candidate: string) => Promise<boolean>;

export interface ProbeContext {
  env: ProbeEnv;
  platform: NodeJS.Platform;
  /** Whether a candidate path is a file that can be started; defaults to the real filesystem. */
  isFile?: FileCheck;
  /** Starts a tool and reads its version line; defaults to {@link runVersionCommand}. */
  run?: CommandRunner;
  /** Time one probe may take, retries included. */
  budgetMs?: number;
  /** Time one attempt may take before it is given up (and retried while the budget lasts). */
  attemptTimeoutMs?: number;
  now?: () => number;
}

/**
 * One attempt. On the Windows smoke machine every tool took longer than the former 8 s limit
 * to answer while the app was writing a large download to disk.
 */
export const PROBE_ATTEMPT_TIMEOUT_MS = 10_000;
/** One probe, retries included; below the 30 s the first-run wizard waits for the probes. */
export const PROBE_BUDGET_MS = 25_000;
/** A retry is not started with less time than this left. */
const MIN_ATTEMPT_MS = 1_000;
const MAX_OUTPUT_CHARS = 64 * 1024;

const WINDOWS_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
/** PATHEXT may also list script types (.VBS, .JS, .PY, ...) that cannot be started directly. */
const WINDOWS_STARTABLE = ['.com', '.exe', '.bat', '.cmd'];

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Looks a variable up the way the platform does: case-insensitively on Windows. */
export function envValue(
  env: ProbeEnv,
  name: string,
  platform: NodeJS.Platform
): string | undefined {
  const direct = env[name];
  if (direct !== undefined || platform !== 'win32') return direct;
  const upper = name.toUpperCase();
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === upper);
  return key === undefined ? undefined : env[key];
}

/**
 * The directories searched for commands, in order and without duplicates. On Windows every
 * spelling of the variable is read; quoted entries are unquoted. Empty and relative entries are
 * skipped, as they would mean the current directory.
 */
export function searchPath(env: ProbeEnv, platform: NodeJS.Platform): string[] {
  const windows = platform === 'win32';
  const api = pathApi(platform);
  const keys = windows ? Object.keys(env).filter((key) => key.toUpperCase() === 'PATH') : ['PATH'];
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const key of keys) {
    for (const raw of (env[key] ?? '').split(windows ? ';' : ':')) {
      const trimmed = windows ? raw.trim() : raw;
      const entry =
        windows && trimmed.length > 1 && trimmed.startsWith('"') && trimmed.endsWith('"')
          ? trimmed.slice(1, -1)
          : trimmed;
      if (!entry || !api.isAbsolute(entry)) continue;
      const identity = windows ? entry.toLowerCase() : entry;
      if (seen.has(identity)) continue;
      seen.add(identity);
      entries.push(entry);
    }
  }
  return entries;
}

/** Startable extensions in PATHEXT order (lower case). */
export function windowsExtensions(env: ProbeEnv): string[] {
  const listed = (envValue(env, 'PATHEXT', 'win32') || WINDOWS_DEFAULT_PATHEXT)
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => WINDOWS_STARTABLE.includes(extension));
  return listed.length ? [...new Set(listed)] : WINDOWS_STARTABLE;
}

/** The real filesystem: a regular file, and on POSIX one the user may execute. */
export function fileCheck(platform: NodeJS.Platform): FileCheck {
  return async (candidate) => {
    try {
      const stats = await fs.stat(candidate);
      if (!stats.isFile()) return false;
      if (platform !== 'win32') await fs.access(candidate, fsConstants.X_OK);
      return true;
    } catch {
      if (platform !== 'win32') return false;
    }
    // App Execution Aliases (%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe and the like) are
    // reparse points `stat` cannot follow; Windows still starts them.
    try {
      return !(await fs.lstat(candidate)).isDirectory();
    } catch {
      return false;
    }
  };
}

/**
 * The file `command` would start: an absolute path is checked as given; a bare name is looked
 * up in each PATH directory, on Windows with each PATHEXT extension in turn (as cmd.exe does).
 * Returns null when there is none.
 */
export async function findExecutable(
  command: string,
  context: { env: ProbeEnv; platform: NodeJS.Platform; isFile: FileCheck }
): Promise<string | null> {
  const { env, platform, isFile } = context;
  const api = pathApi(platform);
  const extensions = platform === 'win32' ? windowsExtensions(env) : [];
  const namesFor = (base: string): string[] => {
    if (platform !== 'win32') return [base];
    const extension = api.extname(base).toLowerCase();
    return extensions.includes(extension) ? [base] : extensions.map((ext) => `${base}${ext}`);
  };

  if (api.isAbsolute(command)) {
    for (const candidate of namesFor(command)) {
      if (await isFile(candidate)) return candidate;
    }
    return null;
  }
  // A relative path would depend on the current directory.
  if (command.includes('/') || (platform === 'win32' && command.includes('\\'))) return null;

  for (const dir of searchPath(env, platform)) {
    for (const name of namesFor(command)) {
      const candidate = api.join(dir, name);
      if (await isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** `env` with the search path under a single key, so the tool sees the directories it was found in. */
export function withSearchPath(env: ProbeEnv, platform: NodeJS.Platform): ProbeEnv {
  if (platform !== 'win32') return { ...env };
  const result: ProbeEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() !== 'PATH') result[key] = value;
  }
  result.Path = searchPath(env, platform).join(';');
  return result;
}

function quoteForCmd(part: string): string {
  // Windows paths cannot contain `"`; arguments here are fixed flags.
  return /[\s&|<>^()%!,;=]/.test(part) ? `"${part}"` : part;
}

/**
 * How to start `file`: directly, or for a `.cmd`/`.bat` shim through cmd.exe. The whole command
 * line is quoted for `cmd /d /s /c`, so a path with spaces or non-ASCII characters stays one
 * argument.
 */
export function launchCommand(
  file: string,
  args: string[],
  env: ProbeEnv,
  platform: NodeJS.Platform
): { command: string; args: string[]; verbatim: boolean } {
  const extension = pathApi(platform).extname(file).toLowerCase();
  if (platform !== 'win32' || (extension !== '.cmd' && extension !== '.bat')) {
    return { command: file, args, verbatim: false };
  }
  const systemRoot = envValue(env, 'SystemRoot', platform) || 'C:\\Windows';
  const shell =
    envValue(env, 'ComSpec', platform) || path.win32.join(systemRoot, 'System32', 'cmd.exe');
  const line = [`"${file}"`, ...args.map(quoteForCmd)].join(' ');
  return { command: shell, args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

/**
 * The line naming the version: the first one with a version number (TeX Live's latexmk prints
 * its console code pages first), else the first line; stdout before stderr.
 */
export function versionLine(stdout: string, stderr: string): string | null {
  const lines = [stdout, stderr].flatMap((text) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );
  return lines.find((line) => /\d+\.\d+/.test(line)) ?? lines[0] ?? null;
}

/**
 * Starts `file args` without a shell (stdin closed, no window) and resolves with its version
 * line when it exits with 0. A run that is still going after `timeoutMs` is killed and reported
 * as `timeout`, never as a failure.
 */
export const runVersionCommand: CommandRunner = (file, args, { env, platform, timeoutMs }) =>
  new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (outcome: RunOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(outcome);
    };

    const launch = launchCommand(file, args, env, platform);
    let child: ChildProcess;
    try {
      child = spawn(launch.command, launch.args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: launch.verbatim,
      });
    } catch {
      settle({ kind: 'failed' });
      return;
    }

    let stdout = '';
    let stderr = '';
    timer = setTimeout(() => {
      child.kill();
      settle({ kind: 'timeout' });
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk;
    });
    child.on('error', () => settle({ kind: 'failed' }));
    child.on('close', (code) => {
      const line = code === 0 ? versionLine(stdout, stderr) : null;
      settle(line ? { kind: 'ok', line } : { kind: 'failed' });
    });
  });

/** Runs one probe: the first candidate that is found and answers decides the result. */
export async function runProbe(
  spec: EnvironmentProbeSpec,
  context: ProbeContext
): Promise<EnvironmentProbe> {
  const { env, platform } = context;
  const isFile = context.isFile ?? fileCheck(platform);
  const run = context.run ?? runVersionCommand;
  const now = context.now ?? Date.now;
  const attemptTimeoutMs = context.attemptTimeoutMs ?? PROBE_ATTEMPT_TIMEOUT_MS;
  const deadline = now() + (context.budgetMs ?? PROBE_BUDGET_MS);
  const childEnv = withSearchPath(env, platform);

  let timedOut: string | null = null;
  for (const candidate of spec.candidates) {
    const file = await findExecutable(candidate.command, { env, platform, isFile });
    if (!file) continue;
    let outcome: RunOutcome = { kind: 'timeout' };
    // Only a timeout is retried: the machine may have been busy. A failure is an answer.
    for (
      let remaining = deadline - now();
      remaining >= MIN_ATTEMPT_MS;
      remaining = deadline - now()
    ) {
      outcome = await run(file, candidate.args, {
        env: childEnv,
        platform,
        timeoutMs: Math.min(attemptTimeoutMs, remaining),
      });
      if (outcome.kind !== 'timeout') break;
    }
    if (outcome.kind === 'ok') {
      return {
        id: spec.id,
        label: spec.label,
        command: file,
        version: outcome.line,
        available: true,
        status: 'available',
      };
    }
    if (outcome.kind === 'timeout') timedOut ??= file;
  }

  return {
    id: spec.id,
    label: spec.label,
    command: timedOut ?? spec.candidates[0]?.command ?? spec.id,
    version: null,
    available: false,
    status: timedOut ? 'timeout' : 'missing',
  };
}

/** Runs the probes side by side, one result each, in the order given. */
export function runProbes(
  specs: readonly EnvironmentProbeSpec[],
  context: ProbeContext
): Promise<EnvironmentProbe[]> {
  return Promise.all(specs.map((spec) => runProbe(spec, context)));
}

const versionFlag = (command: string): ProbeCandidate => ({ command, args: ['--version'] });

/**
 * Windows PowerShell 5.1 has no `--version` switch (it would open an interactive session), so
 * it prints its version from a command.
 */
const WINDOWS_POWERSHELL_VERSION_ARGS = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  "'Windows PowerShell ' + $PSVersionTable.PSVersion.ToString()",
];

export interface ProbeSpecContext {
  env: ProbeEnv;
  platform: NodeJS.Platform;
  /** Git launchers shipped with the app (MinGit on Windows), tried when no git is on PATH. */
  bundledGit: readonly string[];
}

/** The probes the environment panel, the first-run wizard and the diagnostics centre run. */
export function environmentProbeSpecs({
  env,
  platform,
  bundledGit,
}: ProbeSpecContext): EnvironmentProbeSpec[] {
  const windows = platform === 'win32';
  const programFiles = envValue(env, 'ProgramFiles', platform) || 'C:\\Program Files';
  const systemRoot = envValue(env, 'SystemRoot', platform) || 'C:\\Windows';
  const powershell: ProbeCandidate[] = windows
    ? [
        versionFlag('pwsh'),
        // The workspace terminal starts PowerShell 7 from here even when it is not on PATH.
        versionFlag(path.win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe')),
        { command: 'powershell', args: WINDOWS_POWERSHELL_VERSION_ARGS },
        {
          command: path.win32.join(
            systemRoot,
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe'
          ),
          args: WINDOWS_POWERSHELL_VERSION_ARGS,
        },
      ]
    : [versionFlag('pwsh')];

  return [
    { id: 'uv', label: 'uv', candidates: [versionFlag('uv')] },
    {
      id: 'python',
      label: 'Python',
      // The kernel's run_script starts `python` on Windows and `python3` elsewhere.
      candidates: windows
        ? [versionFlag('python')]
        : [versionFlag('python3'), versionFlag('python')],
    },
    { id: 'git', label: 'Git', candidates: [versionFlag('git'), ...bundledGit.map(versionFlag)] },
    { id: 'node', label: 'Node.js', candidates: [versionFlag('node')] },
    { id: 'pwsh', label: 'PowerShell', candidates: powershell },
    { id: 'latexmk', label: 'latexmk', candidates: [versionFlag('latexmk')] },
    { id: 'xelatex', label: 'XeLaTeX', candidates: [versionFlag('xelatex')] },
    { id: 'typst', label: 'Typst', candidates: [versionFlag('typst')] },
    { id: 'pandoc', label: 'Pandoc', candidates: [versionFlag('pandoc')] },
  ];
}
