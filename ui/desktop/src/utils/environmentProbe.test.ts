// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  environmentProbeSpecs,
  findExecutable,
  launchCommand,
  runProbe,
  searchPath,
  versionLine,
  withSearchPath,
  type CommandRunner,
  type EnvironmentProbeSpec,
  type FileCheck,
  type ProbeEnv,
  type RunOutcome,
} from './environmentProbe';

/** What the Windows smoke machine (run 36686960299) started the app with. */
const SMOKE_PATH = [
  'C:\\Windows\\System32',
  'C:\\Windows',
  'C:\\Windows\\System32\\Wbem',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
  'C:\\Windows\\System32\\OpenSSH',
  'C:\\hostedtoolcache\\windows\\Python\\3.12.10\\x64',
  'C:\\hostedtoolcache\\windows\\Python\\3.12.10\\x64\\Scripts',
  'D:\\a\\_temp\\mf-tools\\typst\\typst-x86_64-pc-windows-msvc',
].join(';');
const SHIMS = 'C:\\Users\\模型 测试\\AppData\\Local\\ModelForge\\bin';
const MINGIT = 'C:\\模型 工具\\ModelForge\\resources\\bin\\mingit\\cmd\\git.exe';
const PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.PY;.PYW';

/** A Windows filesystem with exactly these files (compared case-insensitively). */
function windowsFiles(...files: string[]): FileCheck {
  const known = new Set(files.map((file) => file.toLowerCase()));
  return async (candidate) => known.has(candidate.toLowerCase());
}

const spec = (id: string, ...commands: string[]): EnvironmentProbeSpec => ({
  id,
  label: id,
  candidates: commands.map((command) => ({ command, args: ['--version'] })),
});

describe('searchPath', () => {
  it('reads Path, PATH or both on Windows, unquoted and without duplicates', () => {
    expect(searchPath({ Path: 'C:\\a;C:\\b' }, 'win32')).toEqual(['C:\\a', 'C:\\b']);
    expect(searchPath({ PATH: 'C:\\a;C:\\b' }, 'win32')).toEqual(['C:\\a', 'C:\\b']);
    // `{ ...process.env, PATH: x }` on Windows keeps the original `Path` beside the new key.
    expect(
      searchPath({ Path: `C:\\a;${SHIMS}`, PATH: `${SHIMS.toUpperCase()};C:\\c` }, 'win32')
    ).toEqual(['C:\\a', SHIMS, 'C:\\c']);
    expect(searchPath({ Path: ' "C:\\Program Files\\模型 工具" ;;C:\\b' }, 'win32')).toEqual([
      'C:\\Program Files\\模型 工具',
      'C:\\b',
    ]);
  });

  it('skips entries that would mean the current directory', () => {
    expect(searchPath({ Path: '.;bin;C:relative;C:\\ok' }, 'win32')).toEqual(['C:\\ok']);
    expect(searchPath({ PATH: ':/usr/bin::./bin:/opt/模型 工具/bin' }, 'darwin')).toEqual([
      '/usr/bin',
      '/opt/模型 工具/bin',
    ]);
  });

  it('only reads PATH on POSIX, where the name is case-sensitive', () => {
    expect(searchPath({ Path: '/opt/x', PATH: '/usr/bin' }, 'linux')).toEqual(['/usr/bin']);
  });
});

describe('findExecutable', () => {
  it('finds tools in directories with spaces and Chinese characters, whichever PATH key holds them', async () => {
    const python = 'C:\\Users\\模型 测试\\AppData\\Local\\Programs\\Python 3.12\\python.exe';
    const isFile = windowsFiles(python);
    for (const key of ['Path', 'PATH', 'path']) {
      const env: ProbeEnv = { [key]: `C:\\Windows;${path.win32.dirname(python)}`, PATHEXT };
      expect(await findExecutable('python', { env, platform: 'win32', isFile })).toBe(python);
    }
  });

  it('honours PATHEXT order and skips extensions that cannot be started', async () => {
    const dir = 'C:\\工具 目录';
    const isFile = windowsFiles(`${dir}\\tool.cmd`, `${dir}\\tool.exe`, `${dir}\\other.js`);
    const lookup = (env: ProbeEnv, command: string) =>
      findExecutable(command, { env, platform: 'win32', isFile });

    expect(await lookup({ Path: dir, PATHEXT }, 'tool')).toBe(`${dir}\\tool.exe`);
    expect(await lookup({ Path: dir, PATHEXT: '.CMD;.EXE' }, 'tool')).toBe(`${dir}\\tool.cmd`);
    expect(await lookup({ Path: dir }, 'tool')).toBe(`${dir}\\tool.exe`);
    expect(await lookup({ Path: dir, PATHEXT }, 'other')).toBeNull();
    expect(await lookup({ Path: dir, PATHEXT }, 'tool.cmd')).toBe(`${dir}\\tool.cmd`);
  });

  it('checks absolute candidates as given and never the current directory', async () => {
    const isFile = windowsFiles(MINGIT, 'git.exe', '.\\git.exe');
    const env: ProbeEnv = { Path: 'C:\\Windows', PATHEXT };
    expect(await findExecutable(MINGIT, { env, platform: 'win32', isFile })).toBe(MINGIT);
    expect(await findExecutable('git', { env, platform: 'win32', isFile })).toBeNull();
    expect(await findExecutable('.\\git', { env, platform: 'win32', isFile })).toBeNull();
  });
});

describe('withSearchPath', () => {
  it('leaves a single Path key holding every directory on Windows', () => {
    const env = withSearchPath({ Path: 'C:\\a', PATH: `${SHIMS};C:\\a`, TEMP: 'C:\\t' }, 'win32');
    expect(env).toEqual({ Path: `C:\\a;${SHIMS}`, TEMP: 'C:\\t' });
  });
});

describe('launchCommand', () => {
  it('starts executables directly, with the path as one argument', () => {
    const file = 'C:\\模型 工具\\ModelForge\\resources\\bin\\uv.exe';
    expect(launchCommand(file, ['--version'], {}, 'win32')).toEqual({
      command: file,
      args: ['--version'],
      verbatim: false,
    });
  });

  it('runs .cmd shims through cmd.exe with the whole command line quoted', () => {
    const file = 'C:\\Users\\模型 测试\\AppData\\Roaming\\npm\\tool.cmd';
    const env: ProbeEnv = { ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
    expect(launchCommand(file, ['--version'], env, 'win32')).toEqual({
      command: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/s', '/c', `""${file}" --version"`],
      verbatim: true,
    });
    expect(launchCommand(file, ['--version'], { SYSTEMROOT: 'D:\\Win' }, 'win32').command).toBe(
      'D:\\Win\\System32\\cmd.exe'
    );
  });
});

describe('versionLine', () => {
  it('picks the line with the version number', () => {
    const latexmk = [
      'Initial Win CP for (console input, console output, system): (CP65001, CP65001, CP65001)',
      'I changed them all to CP65001',
      'Latexmk, John Collins, 31 Jan. 2024. Version 4.83',
    ].join('\r\n');
    expect(versionLine(latexmk, '')).toBe('Latexmk, John Collins, 31 Jan. 2024. Version 4.83');
    expect(versionLine('\r\nPython 3.12.10\r\n', '')).toBe('Python 3.12.10');
    expect(versionLine('', 'Python 2.7.18\n')).toBe('Python 2.7.18');
    expect(versionLine('no number here\n', '')).toBe('no number here');
    expect(versionLine(' \n', '')).toBeNull();
  });
});

describe('runProbe', () => {
  const ok = (line: string): RunOutcome => ({ kind: 'ok', line });

  it('starts the file it found, with one Path key, and reports its version', async () => {
    const python = 'C:\\hostedtoolcache\\windows\\Python\\3.12.10\\x64\\python.exe';
    const run = vi.fn<CommandRunner>(async () => ok('Python 3.12.10'));
    const probe = await runProbe(spec('python', 'python'), {
      env: { Path: SMOKE_PATH, PATH: SHIMS, PATHEXT },
      platform: 'win32',
      isFile: windowsFiles(python),
      run,
    });

    expect(probe).toEqual({
      id: 'python',
      label: 'python',
      command: python,
      version: 'Python 3.12.10',
      available: true,
      status: 'available',
    });
    expect(run).toHaveBeenCalledTimes(1);
    const [file, args, options] = run.mock.calls[0];
    expect([file, args]).toEqual([python, ['--version']]);
    expect(Object.keys(options.env).filter((key) => key.toUpperCase() === 'PATH')).toEqual([
      'Path',
    ]);
    expect(options.env.Path).toBe(`${SMOKE_PATH};${SHIMS}`);
  });

  it('reports a tool that is not on disk as missing without starting anything', async () => {
    const run = vi.fn<CommandRunner>();
    const probe = await runProbe(spec('node', 'node'), {
      env: { Path: SMOKE_PATH, PATHEXT },
      platform: 'win32',
      isFile: windowsFiles(),
      run,
    });
    expect(probe).toMatchObject({ command: 'node', available: false, status: 'missing' });
    expect(run).not.toHaveBeenCalled();
  });

  it('retries a timed-out attempt, so a busy machine does not turn installed tools into missing ones', async () => {
    const typst = 'D:\\a\\_temp\\mf-tools\\typst\\typst-x86_64-pc-windows-msvc\\typst.exe';
    const run = vi
      .fn<CommandRunner>()
      .mockResolvedValueOnce({ kind: 'timeout' })
      .mockResolvedValueOnce(ok('typst 0.15.1 (9dfd3a08)'));
    const probe = await runProbe(spec('typst', 'typst'), {
      env: { Path: SMOKE_PATH, PATHEXT },
      platform: 'win32',
      isFile: windowsFiles(typst),
      run,
    });
    expect(probe).toMatchObject({
      available: true,
      status: 'available',
      version: 'typst 0.15.1 (9dfd3a08)',
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('reports a found tool that never answers as timed out, within the budget', async () => {
    let clock = 0;
    const run = vi.fn<CommandRunner>(async (_file, _args, { timeoutMs }) => {
      clock += timeoutMs;
      return { kind: 'timeout' };
    });
    const uv = `${SHIMS}\\uv.exe`;
    const probe = await runProbe(spec('uv', 'uv'), {
      env: { Path: SHIMS, PATHEXT },
      platform: 'win32',
      isFile: windowsFiles(uv),
      run,
      now: () => clock,
      budgetMs: 25_000,
      attemptTimeoutMs: 10_000,
    });
    expect(probe).toMatchObject({ command: uv, available: false, status: 'timeout' });
    expect(run.mock.calls.map(([, , options]) => options.timeoutMs)).toEqual([
      10_000, 10_000, 5_000,
    ]);
  });

  it('falls back to the next candidate when the first one is missing or fails', async () => {
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const run = vi.fn<CommandRunner>(async () => ok('Windows PowerShell 5.1.20348.2849'));
    const probe = await runProbe(spec('pwsh', 'pwsh', 'powershell'), {
      env: { Path: SMOKE_PATH, PATHEXT },
      platform: 'win32',
      isFile: windowsFiles(powershell),
      run,
    });
    expect(probe).toMatchObject({ command: powershell, status: 'available' });

    const failing = vi
      .fn<CommandRunner>()
      .mockResolvedValueOnce({ kind: 'failed' })
      .mockResolvedValueOnce(ok('git version 2.56.0.windows.1'));
    const git = await runProbe(spec('git', 'git', MINGIT), {
      env: { Path: 'C:\\Git\\cmd', PATHEXT },
      platform: 'win32',
      isFile: windowsFiles('C:\\Git\\cmd\\git.exe', MINGIT),
      run: failing,
    });
    expect(git).toMatchObject({ command: MINGIT, version: 'git version 2.56.0.windows.1' });
  });
});

describe('environmentProbeSpecs', () => {
  const candidates = (specs: EnvironmentProbeSpec[], id: string) =>
    specs.find((entry) => entry.id === id)?.candidates ?? [];

  it('covers Windows PowerShell 5.1 without --version and the bundled MinGit on Windows', () => {
    const specs = environmentProbeSpecs({
      env: { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' },
      platform: 'win32',
      bundledGit: [MINGIT],
    });
    expect(specs.map((entry) => entry.id)).toEqual([
      'uv',
      'python',
      'git',
      'node',
      'pwsh',
      'latexmk',
      'xelatex',
      'typst',
      'pandoc',
    ]);
    expect(candidates(specs, 'git').map((candidate) => candidate.command)).toEqual(['git', MINGIT]);
    const powershell = candidates(specs, 'pwsh');
    expect(powershell.map((candidate) => candidate.command)).toEqual([
      'pwsh',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'powershell',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ]);
    for (const candidate of powershell.slice(2)) {
      expect(candidate.args).not.toContain('--version');
      expect(candidate.args).toContain('-NonInteractive');
    }
  });

  it('looks for python3 first on POSIX, as the kernel runs it', () => {
    const specs = environmentProbeSpecs({ env: {}, platform: 'darwin', bundledGit: [] });
    expect(candidates(specs, 'python').map((candidate) => candidate.command)).toEqual([
      'python3',
      'python',
    ]);
  });
});

describe('real processes', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    while (tempDirs.length) {
      fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
    }
  });

  /** A tool printing a version, in a directory whose name has spaces and Chinese characters. */
  function installFakeTool(): { dir: string; file: string } {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-probe-'));
    tempDirs.push(base);
    const dir = path.join(base, '模型 工具', 'bin dir');
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform === 'win32') {
      const file = path.join(dir, 'mf-probe-tool.cmd');
      fs.writeFileSync(file, '@echo mf-probe-tool 1.2.3\r\n');
      return { dir, file };
    }
    const file = path.join(dir, 'mf-probe-tool');
    fs.writeFileSync(file, '#!/bin/sh\necho "mf-probe-tool 1.2.3"\n');
    fs.chmodSync(file, 0o755);
    return { dir, file };
  }

  it('finds and runs a tool whose path has spaces and Chinese characters', async () => {
    const { dir, file } = installFakeTool();
    const env: ProbeEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === 'PATH') delete env[key];
    }
    env[process.platform === 'win32' ? 'Path' : 'PATH'] = dir;

    const probe = await runProbe(spec('fake', 'mf-probe-tool'), {
      env,
      platform: process.platform,
      budgetMs: 20_000,
    });
    expect(probe).toMatchObject({
      command: file,
      version: 'mf-probe-tool 1.2.3',
      available: true,
      status: 'available',
    });
  });
});
