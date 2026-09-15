import { execFile } from 'child_process';
import { ipcMain } from 'electron';
import type {
  GitCheckpoint,
  GitCheckpointFile,
  GitVersionError,
  GitVersionResult,
  GitVersionStatus,
} from '../types/workspaceApi';

export type { GitCheckpoint, GitCheckpointFile, GitVersionResult, GitVersionStatus };

const gitArgs = (dir: string, args: string[]) => [
  '-c',
  'safe.bareRepository=explicit',
  '-c',
  'core.fsmonitor=false',
  '-C',
  dir,
  ...args,
];

const git = (dir: string, args: string[], timeout = 20000) =>
  new Promise<string>((resolve, reject) => {
    execFile('git', gitArgs(dir, args), { timeout, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const failure = error as Error & { stderr?: string | Buffer };
        failure.stderr = stderr?.toString() || failure.stderr;
        reject(failure);
        return;
      }
      resolve(stdout.toString());
    });
  });

function describeFailure(error: unknown): { reason: GitVersionError; error: string } {
  const message = (() => {
    if (typeof error === 'object' && error !== null) {
      const withStderr = error as { stderr?: string; message?: string };
      if (withStderr.stderr?.trim()) return withStderr.stderr.trim();
      if (withStderr.message) return withStderr.message;
    }
    return String(error);
  })();

  if (/ENOENT/i.test(message)) {
    return { reason: 'git-missing', error: message };
  }
  if (/nothing to commit|no changes added to commit/i.test(message)) {
    return { reason: 'nothing-to-commit', error: message };
  }
  if (/please tell me who you are|unable to auto-detect email|empty ident name/i.test(message)) {
    return { reason: 'missing-identity', error: message };
  }
  if (/not a git repository/i.test(message)) {
    return { reason: 'not-a-repo', error: message };
  }
  return { reason: 'failed', error: message };
}

function parseShortstat(text: string): {
  filesChanged: number;
  insertions: number;
  deletions: number;
} {
  const files = /(\d+) files? changed/.exec(text);
  const insertions = /(\d+) insertions?\(\+\)/.exec(text);
  const deletions = /(\d+) deletions?\(-\)/.exec(text);
  return {
    filesChanged: files ? Number(files[1]) : 0,
    insertions: insertions ? Number(insertions[1]) : 0,
    deletions: deletions ? Number(deletions[1]) : 0,
  };
}

async function isRepository(dir: string): Promise<boolean> {
  try {
    const result = await git(dir, ['rev-parse', '--is-inside-work-tree'], 5000);
    return result.trim() === 'true';
  } catch {
    return false;
  }
}

async function currentBranch(dir: string): Promise<string | null> {
  try {
    const ref = await git(dir, ['symbolic-ref', '--short', 'HEAD'], 5000);
    return ref.trim() || null;
  } catch {
    try {
      const hash = await git(dir, ['rev-parse', '--short', 'HEAD'], 5000);
      return hash.trim() || null;
    } catch {
      return null;
    }
  }
}

async function ensureIdentity(dir: string): Promise<void> {
  const name = await git(dir, ['config', 'user.name'], 5000).catch(() => '');
  if (!name.trim()) {
    await git(dir, ['config', 'user.name', 'ModelForge'], 5000);
  }
  const email = await git(dir, ['config', 'user.email'], 5000).catch(() => '');
  if (!email.trim()) {
    await git(dir, ['config', 'user.email', 'modelforge@localhost'], 5000);
  }
}

export function registerGitVersionIpc(): void {
  ipcMain.handle('git-version-status', async (_event, dir: string): Promise<GitVersionStatus> => {
    const empty: GitVersionStatus = {
      isRepo: false,
      branch: null,
      changedFiles: 0,
      insertions: 0,
      deletions: 0,
    };
    if (!dir?.trim() || !(await isRepository(dir))) return empty;

    const [branch, status, shortstat] = await Promise.all([
      currentBranch(dir),
      git(dir, ['status', '--porcelain'], 10000).catch(() => ''),
      git(dir, ['diff', '--shortstat', 'HEAD'], 10000).catch(() => ''),
    ]);

    const changedFiles = status.split('\n').filter((line) => line.trim()).length;
    const { insertions, deletions } = parseShortstat(shortstat);

    return { isRepo: true, branch, changedFiles, insertions, deletions };
  });

  ipcMain.handle(
    'git-version-list',
    async (_event, dir: string, limit = 20): Promise<GitCheckpoint[]> => {
      if (!dir?.trim() || !(await isRepository(dir))) return [];

      const capped = Math.min(Math.max(Number(limit) || 20, 1), 100);
      const format = '%x1e%H%x1f%h%x1f%an%x1f%at%x1f%s';
      const output = await git(
        dir,
        ['log', `-n${capped}`, '--shortstat', `--pretty=format:${format}`],
        20000
      ).catch(() => '');
      if (!output) return [];

      const checkpoints: GitCheckpoint[] = [];
      for (const rawBlock of output.split('\x1e')) {
        const block = rawBlock.trim();
        if (!block) continue;
        const [header, ...rest] = block.split('\n');
        const [hash, shortHash, author, timestamp, ...subjectParts] = header.split('\x1f');
        if (!hash || !shortHash) continue;
        const shortstat = parseShortstat(rest.join(' '));
        checkpoints.push({
          hash,
          shortHash,
          author: author ?? '',
          timestamp: Number(timestamp) * 1000 || 0,
          subject: subjectParts.join('\x1f').trim(),
          ...shortstat,
        });
      }

      return checkpoints;
    }
  );

  ipcMain.handle(
    'git-version-files',
    async (_event, dir: string, hash: string): Promise<GitCheckpointFile[]> => {
      if (!dir?.trim() || !hash?.trim() || !(await isRepository(dir))) return [];

      const output = await git(dir, ['show', '--name-status', '--format=', hash], 20000).catch(
        () => ''
      );

      return output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [rawStatus, ...rest] = line.split('\t');
          const status = (rawStatus ?? '').charAt(0).toUpperCase();
          const filePath = rest.length > 1 ? rest[rest.length - 1] : (rest[0] ?? '');
          return { status: status || '?', path: filePath };
        })
        .filter((entry) => entry.path);
    }
  );

  ipcMain.handle(
    'git-version-file-diff',
    async (_event, dir: string, hash: string, filePath: string): Promise<string> => {
      if (!dir?.trim() || !hash?.trim() || !filePath?.trim()) return '';
      if (!(await isRepository(dir))) return '';
      return git(
        dir,
        ['show', '--format=', '--unified=3', '--no-color', hash, '--', filePath],
        30000
      ).catch(() => '');
    }
  );

  ipcMain.handle(
    'git-version-save',
    async (_event, dir: string, message: string): Promise<GitVersionResult> => {
      if (!dir?.trim()) return { ok: false, reason: 'not-a-repo', error: 'Invalid directory' };
      if (!(await isRepository(dir))) return { ok: false, reason: 'not-a-repo' };

      try {
        await ensureIdentity(dir);
        await git(dir, ['add', '-A'], 30000);
        const status = await git(dir, ['status', '--porcelain'], 10000);
        if (!status.trim()) return { ok: false, reason: 'nothing-to-commit' };
        await git(dir, ['commit', '-m', message?.trim() || 'ModelForge checkpoint'], 60000);
        return { ok: true };
      } catch (error) {
        return { ok: false, ...describeFailure(error) };
      }
    }
  );

  ipcMain.handle(
    'git-version-restore',
    async (_event, dir: string, hash: string): Promise<GitVersionResult> => {
      if (!dir?.trim() || !hash?.trim()) {
        return { ok: false, reason: 'failed', error: 'Invalid request' };
      }
      if (!(await isRepository(dir))) return { ok: false, reason: 'not-a-repo' };

      try {
        await git(dir, ['checkout', hash, '--', '.'], 60000);
        return { ok: true };
      } catch (error) {
        return { ok: false, ...describeFailure(error) };
      }
    }
  );

  ipcMain.handle('git-version-init', async (_event, dir: string): Promise<GitVersionResult> => {
    if (!dir?.trim()) return { ok: false, reason: 'failed', error: 'Invalid directory' };
    try {
      await git(dir, ['init'], 30000);
      await ensureIdentity(dir);
      await git(dir, ['add', '-A'], 60000);
      const status = await git(dir, ['status', '--porcelain'], 10000);
      if (status.trim()) {
        await git(dir, ['commit', '-m', 'ModelForge checkpoint'], 60000);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, ...describeFailure(error) };
    }
  });
}
