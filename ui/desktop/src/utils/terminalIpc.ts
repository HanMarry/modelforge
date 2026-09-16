import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ipcMain, type WebContents } from 'electron';
import type { TerminalMode, TerminalSessionInfo } from '../types/workspaceApi';

export type { TerminalMode, TerminalSessionInfo };

interface TerminalSession {
  id: string;
  child: ChildProcessWithoutNullStreams;
  mode: TerminalMode;
  shell: string;
  sender: WebContents;
}

const sessions = new Map<string, TerminalSession>();

const MIN_COLS = 20;
const MAX_COLS = 400;
const MIN_ROWS = 5;
const MAX_ROWS = 200;

function clampDimension(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(numeric, min), max);
}

/**
 * winpty opens every console at 80x25 and ignores the size the panel knows about, so the
 * console has to be resized from inside the session. `Clear-Host` would reset it again, which
 * is why hiding the visible prologue is left to xterm in the renderer.
 */
function resizeCommandFor(shell: string, cols: number, rows: number): string | null {
  const name = path.basename(shell).toLowerCase();
  if (name.startsWith('cmd')) {
    return `mode con: cols=${cols} lines=${rows}`;
  }
  if (name.startsWith('pwsh') || name.startsWith('powershell')) {
    return (
      'try { $Host.UI.RawUI.WindowSize = New-Object ' +
      `System.Management.Automation.Host.Size(${cols}, ${rows}) } catch {}`
    );
  }
  return null;
}

const WINPTY_RELATIVE = path.join('..', '..', 'usr', 'bin', 'winpty.exe');

function firstExisting(candidates: (string | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/** Git for Windows ships winpty, which is the only PTY provider available without a native build. */
function discoverWinpty(): string | null {
  if (process.platform !== 'win32') return null;

  const fromPath = (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((entry) => path.join(entry, 'git.exe'))
    .filter((candidate) => {
      try {
        return fs.existsSync(candidate);
      } catch {
        return false;
      }
    })
    .map((gitExe) => path.resolve(path.dirname(gitExe), WINPTY_RELATIVE));

  return firstExisting([
    process.env.MODELFORGE_WINPTY_PATH,
    ...fromPath,
    'C:\\Program Files\\Git\\usr\\bin\\winpty.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\winpty.exe',
  ]);
}

function discoverShell(): string {
  if (process.platform !== 'win32') {
    return process.env.SHELL || '/bin/sh';
  }
  return (
    firstExisting([
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      ),
    ]) ?? 'cmd.exe'
  );
}

const WINPTY_TEARDOWN_NOISE = /Assertion failed|ASSERT_CONDITION|src\/libwinpty/;

function streamTo(sender: WebContents, channel: string, payload: unknown): void {
  if (sender.isDestroyed()) return;
  sender.send(channel, payload);
}

function closeSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  try {
    session.child.kill();
  } catch {
    // the process may already be gone
  }
}

export function registerTerminalIpc(): void {
  ipcMain.handle(
    'terminal-create',
    (
      event,
      request: { cwd?: string; cols?: number; rows?: number }
    ): TerminalSessionInfo | null => {
      const sender = event.sender;
      const cwd = request?.cwd && fs.existsSync(request.cwd) ? request.cwd : process.cwd();
      const shell = discoverShell();
      const winpty = discoverWinpty();
      const id = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const shellArgs = path.basename(shell).toLowerCase().startsWith('cmd')
        ? ['/Q']
        : ['-NoLogo', '-NoProfile'];

      const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };

      let child: ChildProcessWithoutNullStreams;
      let mode: TerminalMode = 'pipe';

      if (winpty) {
        mode = 'pty';
        child = spawn(winpty, ['-Xallow-non-tty', shell, ...shellArgs], {
          cwd,
          env,
          windowsHide: true,
          stdio: 'pipe',
        });
      } else {
        child = spawn(shell, shellArgs, {
          cwd,
          env,
          windowsHide: true,
          stdio: 'pipe',
        });
      }

      sessions.set(id, { id, child, mode, shell, sender });

      const cols = clampDimension(request?.cols, MIN_COLS, MAX_COLS, 100);
      const rows = clampDimension(request?.rows, MIN_ROWS, MAX_ROWS, 30);

      const forward = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (mode === 'pty' && WINPTY_TEARDOWN_NOISE.test(text)) {
          console.warn('[terminal] winpty teardown noise suppressed');
          return;
        }
        streamTo(sender, 'terminal-data', { id, data: chunk.toString('base64') });
      };

      child.stdout.on('data', forward);
      child.stderr.on('data', forward);
      child.on('error', (error) => {
        streamTo(sender, 'terminal-data', {
          id,
          data: Buffer.from(`\r\n[终端启动失败] ${error.message}\r\n`, 'utf8').toString('base64'),
        });
      });
      child.on('exit', (code) => {
        sessions.delete(id);
        streamTo(sender, 'terminal-exit', { id, code: code ?? 0 });
      });

      sender.once('destroyed', () => closeSession(id));

      return { id, mode, shell, cwd, cols, rows };
    }
  );

  ipcMain.handle('terminal-write', (_event, id: string, data: string) => {
    const session = sessions.get(id);
    if (!session || typeof data !== 'string') return false;
    try {
      session.child.stdin.write(data);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle(
    'terminal-resize-console',
    (_event, id: string, cols: number, rows: number): boolean => {
      const session = sessions.get(id);
      if (!session || session.mode !== 'pty') return false;

      const command = resizeCommandFor(
        session.shell,
        clampDimension(cols, MIN_COLS, MAX_COLS, 100),
        clampDimension(rows, MIN_ROWS, MAX_ROWS, 30)
      );
      if (!command) return false;

      try {
        session.child.stdin.write(`${command}\r`);
        return true;
      } catch {
        return false;
      }
    }
  );

  ipcMain.handle('terminal-kill', (_event, id: string) => {
    closeSession(id);
    return true;
  });

  ipcMain.handle('terminal-list', () =>
    [...sessions.values()].map((session) => ({ id: session.id, mode: session.mode }))
  );
}

export function disposeTerminalSessions(): void {
  for (const id of [...sessions.keys()]) closeSession(id);
}
