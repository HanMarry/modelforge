/**
 * Automatic project snapshots (requirement 11).
 *
 * Each project gets a *shadow* bare git repository under
 * `userData/checkpoints/<sha1(realpath)>.git`. Snapshots are full commits of the
 * project tree (excluding the user's own `.git`), so the user's repository —
 * its history, branches, index and `.git` contents — is never read or written.
 *
 * All git invocations pin `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE` to the
 * shadow repo, disable system/global config, force `-text -filter` so the
 * user's `.gitattributes` cannot rewrite line endings or run filters, and stage
 * with `--force` so `.gitignore`d files are included.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface ExecRunResult {
  stdout: Buffer;
  stderr: Buffer;
}

interface ExecRunOptions {
  env?: GitEnv;
  windowsHide?: boolean;
  maxBuffer?: number;
  timeout?: number;
}

function runExec(command: string, args: string[], options: ExecRunOptions = {}): Promise<ExecRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { ...options, encoding: 'buffer' as const },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          resolve({ stdout: stdout as unknown as Buffer, stderr: stderr as unknown as Buffer });
        }
      }
    );
  });
}

export type CheckpointErrorCode = 'GIT_UNAVAILABLE' | 'CHECKPOINT_FAILED' | 'INVALID_PATH' | 'NOT_FOUND';

export interface CheckpointError {
  code: CheckpointErrorCode;
  message: string;
}

export type CheckpointKind = 'auto' | 'pre-restore';

export interface AutoCheckpoint {
  id: string;
  shortId: string;
  createdAt: number;
  sessionId: string;
  turn: number;
  kind: CheckpointKind;
  filesChanged: number;
}

export interface CheckpointFileChange {
  status: 'A' | 'D' | 'M';
  path: string;
  binary: boolean;
}

export interface CheckpointDiff {
  files: CheckpointFileChange[];
  /** Text diffs keyed by path; binary files only appear in `files`. */
  textByPath: Record<string, string>;
}

export type CheckpointDiffTarget = 'worktree';

export interface CheckpointEnsureResult {
  checkpointId: string;
  created: boolean;
}

export interface CheckpointRestoreResult {
  changedFiles: number;
}

export type CheckpointResult<T> = { ok: true; value: T } | { ok: false; error: CheckpointError };

export interface ResolvedGit {
  git: string;
  source: 'bundled' | 'system';
}

export interface CheckpointFs {
  realpathSync(target: string): string;
  existsSync(target: string): boolean;
  mkdirSync(target: string, options?: { recursive?: boolean }): void;
  writeFileSync(target: string, data: Buffer): void;
  readFileSync(target: string): Buffer;
  unlinkSync(target: string): void;
  readdirSync(target: string, options: { withFileTypes: true }): Dirent[];
  lstatSync(target: string): Stats;
}

export interface CheckpointServiceOptions {
  /** Directory holding `checkpoints/` shadow repos (e.g. `app.getPath('userData')`). */
  userDataDir: string;
  /** Maximum checkpoints retained per project. */
  maxCheckpoints?: number;
  /** Override the bundled MinGit path resolution for tests. */
  bundledGitPath?: string;
  /** Inject the filesystem (restore I/O) for fault injection tests. */
  fs?: CheckpointFs;
}

const DEFAULT_MAX_CHECKPOINTS = 100;

/** Shadow repos already initialised and configured by this process. */
const preparedShadowRepos = new Set<string>();

const systemFs: CheckpointFs = {
  realpathSync: (target) => fs.realpathSync(target),
  existsSync: (target) => fs.existsSync(target),
  mkdirSync: (target, options) => fs.mkdirSync(target, options),
  writeFileSync: (target, data) => fs.writeFileSync(target, data),
  readFileSync: (target) => fs.readFileSync(target),
  unlinkSync: (target) => fs.unlinkSync(target),
  readdirSync: (target, options) => fs.readdirSync(target, options),
  lstatSync: (target) => fs.lstatSync(target),
};

/** Expected location of the MinGit binary shipped by the packaging task. */
export function bundledGitCandidates(): string[] {
  const candidates: string[] = [];
  if (typeof process !== 'undefined' && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'bin', 'mingit', 'cmd', 'git.exe'));
  }
  // Development fallback: `ui/desktop/src/bin/mingit/` (populated by the
  // packaging task's fetch-mingit script). The runtime lives in an MSYS2 environment
  // directory whose name varies between Git for Windows releases.
  const devRoot = path.resolve(__dirname, '..', '..', 'bin', 'mingit');
  candidates.push(path.join(devRoot, 'cmd', 'git.exe'));
  for (const runtimeDir of ['mingw64', 'ucrt64', 'clang64']) {
    candidates.push(path.join(devRoot, runtimeDir, 'bin', 'git.exe'));
  }
  return candidates;
}

async function probeGit(git: string): Promise<boolean> {
  try {
    await runExec(git, ['--version'], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function sha1(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex');
}

interface GitEnv {
  [key: string]: string | undefined;
}

function buildGitEnv(gitDir: string, workTree: string): GitEnv {
  return {
    ...process.env,
    GIT_DIR: gitDir,
    GIT_WORK_TREE: workTree,
    GIT_INDEX_FILE: path.join(gitDir, 'index'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
  };
}

async function runGitBuffer(git: string, args: string[], env: GitEnv): Promise<Buffer> {
  const { stdout } = await runExec(git, args, {
    env,
    windowsHide: true,
    maxBuffer: 512 * 1024 * 1024,
  });
  return stdout;
}

async function runGitText(git: string, args: string[], env: GitEnv): Promise<string> {
  return (await runGitBuffer(git, args, env)).toString('utf8');
}

function gitErrorDescription(error: unknown): string {
  if (error && typeof error === 'object') {
    const withStderr = error as { stderr?: Buffer | string; message?: string };
    if (withStderr.stderr) {
      const text = Buffer.isBuffer(withStderr.stderr)
        ? withStderr.stderr.toString('utf8')
        : String(withStderr.stderr);
      if (text.trim()) return text.trim();
    }
    if (withStderr.message) return withStderr.message;
  }
  return String(error);
}

interface CommitMeta {
  createdAt: string;
  sessionId: string;
  turn: number;
  kind: CheckpointKind;
}

function commitMessage(meta: CommitMeta): string {
  return JSON.stringify(meta);
}

function parseCommitMessage(subject: string): CommitMeta | null {
  try {
    const parsed = JSON.parse(subject) as Partial<CommitMeta>;
    if (
      typeof parsed.createdAt === 'string' &&
      typeof parsed.sessionId === 'string' &&
      typeof parsed.turn === 'number' &&
      (parsed.kind === 'auto' || parsed.kind === 'pre-restore')
    ) {
      return {
        createdAt: parsed.createdAt,
        sessionId: parsed.sessionId,
        turn: parsed.turn,
        kind: parsed.kind,
      };
    }
    return null;
  } catch {
    return null;
  }
}

interface Context {
  git: string;
  env: GitEnv;
  gitDir: string;
  workTree: string;
}

/**
 * Resolve a git executable: the bundled MinGit first, then `git` on PATH.
 * Returns `{ error: { code: 'GIT_UNAVAILABLE' } }` when neither is usable.
 */
export async function resolveGit(options: {
  fs?: CheckpointFs;
  bundledGitPath?: string;
} = {}): Promise<CheckpointResult<ResolvedGit>> {
  const fileSystem = options.fs ?? systemFs;
  const candidates = options.bundledGitPath ? [options.bundledGitPath] : bundledGitCandidates();
  for (const candidate of candidates) {
    try {
      if (fileSystem.existsSync(candidate) && (await probeGit(candidate))) {
        return { ok: true, value: { git: candidate, source: 'bundled' } };
      }
    } catch {
      // fall through to the next candidate
    }
  }
  if (await probeGit('git')) {
    return { ok: true, value: { git: 'git', source: 'system' } };
  }
  return { ok: false, error: { code: 'GIT_UNAVAILABLE', message: 'Git is not available' } };
}

export class CheckpointService {
  private readonly fileSystem: CheckpointFs;
  private readonly userDataDir: string;
  private readonly maxCheckpoints: number;
  private readonly bundledGitPath?: string;
  private readonly locks: Map<string, Promise<unknown>>;
  private resolvedGit: Promise<CheckpointResult<ResolvedGit>> | null = null;

  constructor(options: CheckpointServiceOptions) {
    this.fileSystem = options.fs ?? systemFs;
    this.userDataDir = options.userDataDir;
    this.maxCheckpoints = options.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS;
    this.bundledGitPath = options.bundledGitPath;
    this.locks = new Map();
  }

  /** Resolve a git executable: bundled MinGit first, then `git` on PATH. */
  resolveGit(): Promise<CheckpointResult<ResolvedGit>> {
    if (!this.resolvedGit) {
      this.resolvedGit = resolveGit({
        fs: this.fileSystem,
        bundledGitPath: this.bundledGitPath,
      });
    }
    return this.resolvedGit;
  }

  /** Create (or reuse) the checkpoint for `(sessionId, turn)`. */
  async ensureForTurn(
    projectRoot: string,
    sessionId: string,
    turn: number
  ): Promise<CheckpointResult<CheckpointEnsureResult>> {
    return this.withProjectLock(projectRoot, async () => {
      const ctx = await this.projectContext(projectRoot);
      if (!ctx.ok) return ctx;

      const existing = await this.findCheckpointForTurn(ctx.value, sessionId, turn);
      if (existing) {
        return { ok: true, value: { checkpointId: existing.id, created: false } };
      }

      const message = commitMessage({
        createdAt: new Date().toISOString(),
        sessionId,
        turn,
        kind: 'auto',
      });
      try {
        await runGitText(ctx.value.git, ['add', '-A', '--force'], ctx.value.env);
        await runGitText(ctx.value.git,
          ['commit', '--allow-empty', '-m', message],
          ctx.value.env
        );
      } catch (error) {
        return {
          ok: false,
          error: { code: 'CHECKPOINT_FAILED', message: gitErrorDescription(error) },
        };
      }

      const head = await this.currentHead(ctx.value);
      if (!head) {
        return {
          ok: false,
          error: { code: 'CHECKPOINT_FAILED', message: 'Checkpoint commit produced no HEAD' },
        };
      }

      try {
        await this.trimCheckpoints(ctx.value, this.maxCheckpoints);
      } catch {
        // Retention is best-effort; an existing snapshot is still usable.
      }

      // Trimming rewrites the retained history, so the new checkpoint's id is read back
      // afterwards; a later call for the same turn then reports the same id.
      const checkpointId = (await this.currentHead(ctx.value)) ?? head;
      return { ok: true, value: { checkpointId, created: true } };
    });
  }

  async listCheckpoints(
    projectRoot: string,
    limit = 100
  ): Promise<CheckpointResult<AutoCheckpoint[]>> {
    return this.withProjectLock(projectRoot, async () => {
      const ctx = await this.projectContext(projectRoot);
      if (!ctx.ok) return ctx;
      const capped = Math.min(Math.max(Math.floor(limit) || 100, 1), 1000);
      try {
        return { ok: true, value: await this.listCheckpointsUnlocked(ctx.value, capped) };
      } catch (error) {
        return {
          ok: false,
          error: { code: 'CHECKPOINT_FAILED', message: gitErrorDescription(error) },
        };
      }
    });
  }

  async diff(
    projectRoot: string,
    a: string,
    b: string | CheckpointDiffTarget
  ): Promise<CheckpointResult<CheckpointDiff>> {
    return this.withProjectLock(projectRoot, async () => {
      const ctx = await this.projectContext(projectRoot);
      if (!ctx.ok) return ctx;
      const { git, env } = ctx.value;
      const bArg = b === 'worktree' ? [] : [b];
      try {
        const nameStatus = await runGitText(git, ['diff', '--name-status', a, ...bArg], env);
        const files = parseNameStatus(nameStatus);
        const textByPath: Record<string, string> = {};
        for (const file of files) {
          const text = await runGitText(git,
            ['diff', '--unified=3', '--no-color', a, ...bArg, '--', file.path],
            env
          ).catch(() => '');
          // Git emits `Binary files a/... and b/... differ` for binary content.
          const isBinary = /^Binary files .* differ$/m.test(text) || /^GIT binary patch$/m.test(text);
          file.binary = isBinary;
          if (!isBinary) textByPath[file.path] = text;
        }
        return { ok: true, value: { files, textByPath } };
      } catch (error) {
        return {
          ok: false,
          error: { code: 'CHECKPOINT_FAILED', message: gitErrorDescription(error) },
        };
      }
    });
  }

  async restore(
    projectRoot: string,
    checkpointId: string
  ): Promise<CheckpointResult<CheckpointRestoreResult>> {
    return this.withProjectLock(projectRoot, async () => {
      const ctx = await this.projectContext(projectRoot);
      if (!ctx.ok) return ctx;

      const requested = await runGitText(ctx.value.git,
        ['rev-parse', '--verify', `${checkpointId}^{commit}`],
        ctx.value.env
      ).catch(() => '');
      if (!requested.trim()) {
        return {
          ok: false,
          error: { code: 'NOT_FOUND', message: `Checkpoint not found: ${checkpointId}` },
        };
      }

      const preRestore = await this.createPreRestoreCheckpoint(ctx.value);
      if (!preRestore) {
        return {
          ok: false,
          error: { code: 'CHECKPOINT_FAILED', message: 'Failed to create pre-restore checkpoint' },
        };
      }

      const applied = await this.applyTree(ctx.value, requested.trim(), projectRoot);
      if (applied.failed.length > 0) {
        await this.applyTree(ctx.value, preRestore, projectRoot);
        return {
          ok: false,
          error: {
            code: 'CHECKPOINT_FAILED',
            message: `Restore failed for: ${applied.failed.join(', ')}`,
          },
        };
      }

      return { ok: true, value: { changedFiles: applied.changedFiles } };
    });
  }

  // --- internals ----------------------------------------------------------

  private withProjectLock<T>(projectRoot: string, task: () => Promise<T>): Promise<T> {
    const key = this.lockKey(projectRoot);
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.locks.set(
      key,
      next.catch(() => undefined)
    );
    return next;
  }

  private lockKey(projectRoot: string): string {
    try {
      return sha1(this.fileSystem.realpathSync(projectRoot));
    } catch {
      return sha1(projectRoot);
    }
  }

  private async projectContext(projectRoot: string): Promise<CheckpointResult<Context>> {
    const gitResult = await this.resolveGit();
    if (!gitResult.ok) return gitResult;

    let workTree: string;
    try {
      workTree = this.fileSystem.realpathSync(projectRoot);
    } catch {
      return {
        ok: false,
        error: { code: 'INVALID_PATH', message: `Project directory does not exist: ${projectRoot}` },
      };
    }
    const gitDir = path.join(this.userDataDir, 'checkpoints', `${sha1(workTree)}.git`);
    const env = buildGitEnv(gitDir, workTree);
    try {
      await this.ensureShadowRepo(gitResult.value.git, gitDir, workTree);
    } catch (error) {
      return {
        ok: false,
        error: { code: 'CHECKPOINT_FAILED', message: gitErrorDescription(error) },
      };
    }
    return { ok: true, value: { git: gitResult.value.git, env, gitDir, workTree } };
  }

  private async ensureShadowRepo(git: string, gitDir: string, workTree: string): Promise<void> {
    const exists = this.fileSystem.existsSync(gitDir);
    // Configuring spawns eight git processes; do it once per shadow repo per process.
    if (exists && preparedShadowRepos.has(gitDir)) {
      return;
    }
    if (!exists) {
      await runExec(git, ['init', '--bare', gitDir], {
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
        windowsHide: true,
      });
    }
    const env = buildGitEnv(gitDir, workTree);
    const config = async (key: string, value: string) => {
      await runExec(git, ['config', key, value], { env, windowsHide: true });
    };
    await config('core.autocrlf', 'false');
    await config('core.quotepath', 'false');
    await config('core.longpaths', 'true');
    await config('core.attributesfile', path.join(gitDir, 'info', 'attributes'));
    await config('core.logallrefupdates', 'false');
    await config('user.name', 'ModelForge');
    await config('user.email', 'modelforge@localhost');
    await config('commit.gpgsign', 'false');

    const infoDir = path.join(gitDir, 'info');
    fs.mkdirSync(infoDir, { recursive: true });
    fs.writeFileSync(path.join(infoDir, 'exclude'), '.git/\n');
    fs.writeFileSync(path.join(infoDir, 'attributes'), '* -text -filter\n');
    preparedShadowRepos.add(gitDir);
  }

  private async currentHead(ctx: Context): Promise<string | null> {
    try {
      const head = await runGitText(ctx.git, ['rev-parse', 'HEAD'], ctx.env);
      return head.trim() || null;
    } catch {
      return null;
    }
  }

  private async listCheckpointsUnlocked(ctx: Context, limit: number): Promise<AutoCheckpoint[]> {
    const head = await this.currentHead(ctx);
    if (!head) return [];

    const format = '%x1e%H%x1f%h%x1f%at%x1f%s';
    const output = await runGitText(ctx.git,
      ['log', `-n${limit}`, '--shortstat', `--pretty=format:${format}`],
      ctx.env
    ).catch(() => '');

    const checkpoints: AutoCheckpoint[] = [];
    for (const rawBlock of output.split('\x1e')) {
      const block = rawBlock.trim();
      if (!block) continue;
      const [header, ...rest] = block.split('\n');
      const [hash, shortHash, timestamp, ...subjectParts] = header.split('\x1f');
      if (!hash || !shortHash) continue;
      const meta = parseCommitMessage(subjectParts.join('\x1f').trim());
      if (!meta) continue;
      checkpoints.push({
        id: hash,
        shortId: shortHash,
        createdAt: Date.parse(meta.createdAt) || Number(timestamp) * 1000 || 0,
        sessionId: meta.sessionId,
        turn: meta.turn,
        kind: meta.kind,
        filesChanged: parseFilesChanged(rest.join(' ')),
      });
    }
    return checkpoints;
  }

  private async findCheckpointForTurn(
    ctx: Context,
    sessionId: string,
    turn: number
  ): Promise<AutoCheckpoint | null> {
    const checkpoints = await this.listCheckpointsUnlocked(ctx, 200);
    return (
      checkpoints.find((c) => c.sessionId === sessionId && c.turn === turn) ?? null
    );
  }

  private async trimCheckpoints(ctx: Context, limit: number): Promise<void> {
    const countRaw = await runGitText(ctx.git, ['rev-list', '--count', 'HEAD'], ctx.env).catch(
      () => '0'
    );
    const count = Number.parseInt(countRaw.trim(), 10) || 0;
    if (count <= limit) return;

    // One `git log` reads the tree and message of every retained commit, oldest first
    // (`-n` limits before `--reverse` reorders), instead of two git calls per commit.
    const records = (
      await runGitText(ctx.git,
        ['log', '--reverse', `-n${limit}`, '--format=%T%x00%B%x1e', 'HEAD'],
        ctx.env
      )
    )
      .split('\x1e')
      .map((record) => record.replace(/^\n/, ''))
      .filter((record) => record.includes('\0'));

    let parent: string | null = null;
    let tip: string | null = null;
    for (const record of records) {
      const separator = record.indexOf('\0');
      const tree = record.slice(0, separator).trim();
      const message = record.slice(separator + 1);
      const args = ['commit-tree', tree];
      if (parent) args.push('-p', parent);
      args.push('-m', message);
      const rebuilt = (await runGitText(ctx.git, args, ctx.env)).trim();
      tip = rebuilt;
      parent = rebuilt;
    }
    if (!tip) return;

    const branch = await runGitText(ctx.git, ['symbolic-ref', '--short', 'HEAD'], ctx.env).catch(
      () => 'master'
    );
    const branchRef = branch.trim() || 'master';
    await runGitText(ctx.git, ['update-ref', `refs/heads/${branchRef}`, tip], ctx.env);
    await runGitText(ctx.git, ['gc', '--prune=now'], ctx.env);
  }

  private async createPreRestoreCheckpoint(ctx: Context): Promise<string | null> {
    const message = commitMessage({
      createdAt: new Date().toISOString(),
      sessionId: '',
      turn: 0,
      kind: 'pre-restore',
    });
    try {
      await runGitText(ctx.git, ['add', '-A', '--force'], ctx.env);
      await runGitText(ctx.git, ['commit', '--allow-empty', '-m', message], ctx.env);
      return this.currentHead(ctx);
    } catch {
      return null;
    }
  }

  private async applyTree(ctx: Context, treeish: string, projectRoot: string): Promise<ApplyResult> {
    const plan = await this.buildApplyPlan(ctx, treeish, projectRoot);

    const failed: string[] = [];
    for (const entry of plan.toWrite) {
      const full = path.join(projectRoot, entry.path);
      try {
        this.fileSystem.mkdirSync(path.dirname(full), { recursive: true });
        this.fileSystem.writeFileSync(full, entry.data);
      } catch {
        failed.push(entry.path);
        return { changedFiles: plan.toWrite.length + plan.toDelete.length, failed };
      }
    }
    for (const filePath of plan.toDelete) {
      try {
        this.fileSystem.unlinkSync(path.join(projectRoot, filePath));
      } catch {
        failed.push(filePath);
        return { changedFiles: plan.toWrite.length + plan.toDelete.length, failed };
      }
    }
    return { changedFiles: plan.toWrite.length + plan.toDelete.length, failed };
  }

  /** Files to write are only those whose content differs, so untouched files keep their mtime. */
  private async buildApplyPlan(ctx: Context, treeish: string, projectRoot: string): Promise<ApplyPlan> {
    const targetPaths = await this.treeFiles(ctx, treeish);
    const currentPaths = walkProject(projectRoot, this.fileSystem);
    const targetSet = new Set(targetPaths);
    const toDelete = currentPaths.filter((p) => !targetSet.has(p)).sort();

    const toWrite: Array<{ path: string; data: Buffer }> = [];
    for (const filePath of targetPaths.sort()) {
      const data = await runGitBuffer(ctx.git, ['show', `${treeish}:${filePath}`], ctx.env);
      if (!this.hasSameContent(path.join(projectRoot, filePath), data)) {
        toWrite.push({ path: filePath, data });
      }
    }
    return { toWrite, toDelete };
  }

  private hasSameContent(fullPath: string, data: Buffer): boolean {
    try {
      return this.fileSystem.readFileSync(fullPath).equals(data);
    } catch {
      return false;
    }
  }

  private async treeFiles(ctx: Context, treeish: string): Promise<string[]> {
    try {
      // `-z` keeps paths verbatim: without it git C-quotes names with quotes, backslashes
      // or control characters even when core.quotepath is off.
      const output = await runGitText(ctx.git, ['ls-tree', '-r', '-z', '--name-only', treeish], ctx.env);
      return output.split('\0').filter(Boolean);
    } catch {
      return [];
    }
  }
}

interface ApplyPlan {
  toWrite: Array<{ path: string; data: Buffer }>;
  toDelete: string[];
}

interface ApplyResult {
  changedFiles: number;
  failed: string[];
}

function walkProject(root: string, fileSystem: CheckpointFs): string[] {
  const result: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: Dirent[];
    try {
      entries = fileSystem.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        // git tree paths always use `/`; compare in that form so Windows paths match.
        result.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  }
  return result;
}

function parseFilesChanged(shortstatText: string): number {
  const match = /(\d+) files? changed/.exec(shortstatText);
  return match ? Number(match[1]) : 0;
}

function parseNameStatus(text: string): CheckpointFileChange[] {
  const result: CheckpointFileChange[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [status, ...rest] = trimmed.split('\t');
    const filePath = rest.join('\t');
    if (!filePath) continue;
    const raw = (status ?? '').charAt(0).toUpperCase();
    const kind: CheckpointFileChange['status'] = raw === 'A' ? 'A' : raw === 'D' ? 'D' : 'M';
    result.push({ status: kind, path: filePath, binary: false });
  }
  return result;
}
