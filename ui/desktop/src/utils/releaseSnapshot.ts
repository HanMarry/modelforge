/**
 * Source snapshots, provenance probes and the publish step of the kernel build pipelines (spec
 * mathmodel-parity-and-beyond, requirement 3.1, 3.3, 3.4, 3.5, 3.7, 3.8).
 *
 * scripts/release/build-release.mts (release builds) and scripts/release/dev-manifest.mts
 * (called by build-kernel.ps1) run this file directly under Node's type stripping. It therefore
 * imports only Node built-ins and uses erasable TypeScript syntax only. Local imports would
 * need a `.ts` extension, which the desktop tsconfig rejects, so checks from buildManifest.ts
 * are passed in by the caller (see `publishRelease`).
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type PipelineStage =
  | 'arguments'
  | 'resolve'
  | 'snapshot'
  | 'dirty'
  | 'source-state'
  | 'build'
  | 'provenance'
  | 'manifest'
  | 'verify'
  | 'publish';

/** A pipeline failure that names the stage it happened in (requirement 3.7). */
export class PipelineError extends Error {
  readonly stage: PipelineStage;

  constructor(stage: PipelineStage, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PipelineError';
    this.stage = stage;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Set by git hooks and parent git processes; they would point our git calls elsewhere. */
const INHERITED_GIT_LOCATION = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
];

function gitEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of INHERITED_GIT_LOCATION) {
    delete env[name];
  }
  // Read-only commands such as `git status` must not rewrite the index.
  return { ...env, GIT_OPTIONAL_LOCKS: '0', ...extra };
}

/** Runs git and returns its stdout; a non-zero exit throws with git's own message. */
export function git(
  args: readonly string[],
  cwd: string,
  extraEnv: Record<string, string> = {}
): string {
  const result = runCommand('git', args, cwd, gitEnv(extraEnv));
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.status}`;
    throw new Error(`git ${args.join(' ')}: ${detail}`);
  }
  return result.stdout;
}

const FULL_COMMIT = /^[0-9a-fA-F]{40}$/;
/** The dirty rule of requirement 3.4: modified, staged or untracked (but not ignored) files. */
const STATUS_ARGS = [
  '-c',
  'core.quotepath=false',
  'status',
  '--porcelain',
  '--untracked-files=normal',
];

/** Paths from `git status --porcelain` output. */
function porcelainPaths(output: string): string[] {
  return output
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3));
}

/**
 * Checks that `sha` is a full 40-character id of a commit in `repo` and returns it lowercased
 * (requirement 3.1, 3.7). Abbreviated ids, branch names, trees and tags are rejected.
 */
export function resolveCommit(repo: string, sha: string): string {
  if (!FULL_COMMIT.test(sha)) {
    throw new PipelineError(
      'resolve',
      `expected a full 40-character commit id, got ${JSON.stringify(sha)}`
    );
  }
  const wanted = sha.toLowerCase();
  let resolved: string;
  try {
    resolved = git(['rev-parse', '--verify', '--quiet', `${wanted}^{commit}`], repo).trim();
  } catch (error) {
    throw new PipelineError('resolve', `commit ${wanted} does not exist in ${repo}`, {
      cause: error,
    });
  }
  if (resolved !== wanted) {
    throw new PipelineError('resolve', `${wanted} is not a commit (it peels to ${resolved})`);
  }
  return resolved;
}

export interface SourceState {
  commit: string;
  /** Modified, staged or untracked files exist (requirement 3.4). */
  dirty: boolean;
  /** The `git status --porcelain` entries behind `dirty`. */
  changes: string[];
}

/** HEAD and the dirty flag of a working tree, read before a dev build starts. */
export function readSourceState(repo: string): SourceState {
  try {
    const commit = git(['rev-parse', '--verify', 'HEAD'], repo).trim().toLowerCase();
    const changes = porcelainPaths(git(STATUS_ARGS, repo));
    return { commit, dirty: changes.length > 0, changes };
  } catch (error) {
    throw new PipelineError('source-state', `cannot read the git state: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function repoUsesSymlinks(repo: string): boolean {
  const result = runCommand('git', ['config', '--bool', 'core.symlinks'], repo, gitEnv({}));
  if (result.status === 0) {
    return result.stdout.trim() === 'true';
  }
  return process.platform !== 'win32';
}

/**
 * Writes exactly the files tracked in `commit` to `destDir`, which must not exist yet
 * (requirement 3.1, 3.3). `git archive` never includes uncommitted edits, untracked files or
 * earlier build output, and leaves no worktree metadata in the repository. The archive is
 * unpacked by `extractTar` instead of a system `tar`, which on Windows garbles non-ASCII names
 * and needs extra privileges for symbolic links.
 */
export function exportSnapshot(repo: string, commit: string, destDir: string): void {
  if (fs.existsSync(destDir)) {
    throw new PipelineError('snapshot', `${destDir} already exists; snapshots start empty`);
  }
  const archive = `${destDir}.${randomBytes(4).toString('hex')}.tar`;
  try {
    fs.mkdirSync(destDir, { recursive: true });
    git(['archive', '--format=tar', '-o', archive, commit], repo);
    extractTar(archive, destDir, { symlinks: repoUsesSymlinks(repo) });
  } catch (error) {
    throw new PipelineError('snapshot', `cannot export ${commit}: ${errorMessage(error)}`, {
      cause: error,
    });
  } finally {
    fs.rmSync(archive, { force: true });
  }
}

/**
 * Paths where `snapshotDir` differs from `commit` (modified, deleted or untracked, the same
 * `git status --porcelain --untracked-files=normal` rule as dev builds). The comparison goes
 * through a throwaway index, so the repository's own index and work tree are never touched.
 */
export function listSnapshotChanges(repo: string, commit: string, snapshotDir: string): string[] {
  const indexName = `.${path.basename(snapshotDir)}.${randomBytes(4).toString('hex')}.index`;
  const indexFile = path.join(path.dirname(snapshotDir), indexName);
  try {
    const env = {
      GIT_DIR: git(['rev-parse', '--absolute-git-dir'], repo).trim(),
      GIT_WORK_TREE: snapshotDir,
      GIT_INDEX_FILE: indexFile,
    };
    git(['read-tree', commit], snapshotDir, env);
    // An fsmonitor daemon of the repository knows nothing about the snapshot directory.
    return porcelainPaths(git(['-c', 'core.fsmonitor=false', ...STATUS_ARGS], snapshotDir, env));
  } finally {
    fs.rmSync(indexFile, { force: true });
    fs.rmSync(`${indexFile}.lock`, { force: true });
  }
}

/**
 * Stops a release build whose snapshot differs from `commit` (requirement 3.8): a release is
 * only built from, and only shipped with, exactly the committed sources. `when` says which
 * check failed, for example "after the build".
 */
export function assertCleanSnapshot(
  repo: string,
  commit: string,
  snapshotDir: string,
  when: string
): void {
  let changes: string[];
  try {
    changes = listSnapshotChanges(repo, commit, snapshotDir);
  } catch (error) {
    const reason = `cannot compare the snapshot with ${commit}: ${errorMessage(error)}`;
    throw new PipelineError('dirty', reason, { cause: error });
  }
  if (changes.length > 0) {
    const list = changes.join('\n  ');
    throw new PipelineError(
      'dirty',
      `the source snapshot contains uncommitted changes ${when} (dirty: true):\n  ${list}`
    );
  }
}

/** Reasons a staged release must not be published, one per line; empty when it may be. */
export type ReleaseCheck = (manifestJson: string, actual: Record<string, string>) => string[];

export interface ReleaseFiles {
  /** Directory the binaries were built in. */
  binaryDir: string;
  /** File names of the binaries to ship. */
  artifacts: readonly string[];
  /** The serialized Build_Manifest, shipped as `manifestName`. */
  manifestJson: string;
  manifestName: string;
  outDir: string;
}

/**
 * Stages the binaries and the manifest next to `outDir`, re-reads the staged manifest and
 * re-hashes every staged binary, and lets `check` decide (requirement 3.5, 3.8). When `check`
 * reports anything the release stops with a `verify` error listing every reason, the staging
 * directory is removed and `outDir` stays as it was. Otherwise the staged directory replaces
 * `outDir`.
 */
export function publishRelease(files: ReleaseFiles, check: ReleaseCheck): void {
  const staging = `${files.outDir}.staging-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    fs.mkdirSync(staging, { recursive: true });
    for (const file of files.artifacts) {
      fs.copyFileSync(path.join(files.binaryDir, file), path.join(staging, file));
    }
    const manifestPath = path.join(staging, files.manifestName);
    fs.writeFileSync(manifestPath, files.manifestJson);

    // Check what would be shipped, not what was built.
    const shipped = fs.readFileSync(manifestPath, 'utf8');
    const problems = check(shipped, hashArtifacts(staging, files.artifacts));
    if (problems.length > 0) {
      throw new PipelineError('verify', `release stopped:\n  ${problems.join('\n  ')}`);
    }

    fs.rmSync(files.outDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(files.outDir), { recursive: true });
    fs.renameSync(staging, files.outDir);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (error instanceof PipelineError) {
      throw error;
    }
    throw new PipelineError('publish', errorMessage(error), { cause: error });
  }
}

export interface ExtractOptions {
  /**
   * Create symbolic links. Without this a link becomes a regular file holding the link target,
   * which is what git itself checks out when `core.symlinks` is false.
   */
  symlinks: boolean;
}

const TAR_BLOCK = 512;
const COPY_CHUNK = 1024 * 1024;

function readExactly(fd: number, buffer: Buffer, length: number, position: number): void {
  let offset = 0;
  while (offset < length) {
    const read = fs.readSync(fd, buffer, offset, length - offset, position + offset);
    if (read === 0) {
      throw new Error('the tar archive is truncated');
    }
    offset += read;
  }
}

function readBytes(fd: number, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(length);
  readExactly(fd, buffer, length, position);
  return buffer;
}

function cString(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString('utf8');
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const text = cString(block.subarray(offset, offset + length)).trim();
  if (text === '') {
    return 0;
  }
  if (!/^[0-7]+$/.test(text)) {
    throw new Error(`malformed number ${JSON.stringify(text)} in a tar header`);
  }
  return Number.parseInt(text, 8);
}

function verifyChecksum(block: Buffer): void {
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK; index += 1) {
    // The checksum field itself counts as eight spaces.
    sum += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  if (sum !== readOctal(block, 148, 8)) {
    throw new Error('tar header checksum mismatch');
  }
}

/** Name from a ustar header, joining the POSIX `prefix` field when present. */
function ustarName(block: Buffer): string {
  const name = cString(block.subarray(0, 100));
  const posixUstar = block.subarray(257, 263).toString('latin1') === 'ustar\0';
  const prefix = posixUstar ? cString(block.subarray(345, 500)) : '';
  return prefix ? `${prefix}/${name}` : name;
}

/** Records of a pax extended header (`<length> <key>=<value>\n`, length in bytes). */
function parsePax(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const length = space === -1 ? NaN : Number(data.toString('latin1', offset, space));
    if (!Number.isInteger(length) || length <= 0 || offset + length > data.length) {
      throw new Error('malformed pax header in the tar archive');
    }
    const record = data.toString('utf8', space + 1, offset + length - 1);
    const equals = record.indexOf('=');
    if (equals > 0) {
      records.set(record.slice(0, equals), record.slice(equals + 1));
    }
    offset += length;
  }
  return records;
}

/** Maps an archive path into `root`, refusing anything that would land outside it. */
function entryPath(root: string, name: string): string {
  const segments = name.split('/').filter((segment) => segment !== '' && segment !== '.');
  const unsafe =
    segments.length === 0 ||
    name.startsWith('/') ||
    segments.some(
      (segment) =>
        segment === '..' ||
        segment.includes('\0') ||
        (process.platform === 'win32' && (segment.includes('\\') || segment.includes(':')))
    );
  if (unsafe) {
    throw new Error(`refusing to extract ${JSON.stringify(name)} outside the snapshot`);
  }
  return path.join(root, ...segments);
}

/**
 * Refuses to write at or below a symbolic link extracted earlier: the link may point outside
 * the snapshot. Trees from git never contain such entries, other archives might.
 */
function assertNotThroughLink(links: ReadonlySet<string>, root: string, target: string): void {
  const base = path.join(root);
  for (let current = target; current.length > base.length; current = path.dirname(current)) {
    if (links.has(current)) {
      throw new Error(`refusing to extract ${target} through the symbolic link ${current}`);
    }
  }
}

function copyEntry(
  fd: number,
  chunk: Buffer,
  start: number,
  size: number,
  target: string,
  mode: number
): void {
  const out = fs.openSync(target, 'w', mode || 0o644);
  try {
    let copied = 0;
    while (copied < size) {
      const length = Math.min(chunk.length, size - copied);
      readExactly(fd, chunk, length, start + copied);
      fs.writeSync(out, chunk, 0, length);
      copied += length;
    }
  } finally {
    fs.closeSync(out);
  }
}

/**
 * Unpacks a tar archive as written by `git archive`: regular files (with their executable
 * bit), directories and symbolic links, pax extended headers for long or non-ASCII names, and
 * GNU long names. Returns the number of entries written.
 */
export function extractTar(archive: string, destDir: string, options: ExtractOptions): number {
  const fd = fs.openSync(archive, 'r');
  const header = Buffer.alloc(TAR_BLOCK);
  const chunk = Buffer.alloc(COPY_CHUNK);
  let position = 0;
  let pax = new Map<string, string>();
  let longName: string | undefined;
  let longLink: string | undefined;
  let entries = 0;
  const links = new Set<string>();
  try {
    for (;;) {
      readExactly(fd, header, TAR_BLOCK, position);
      position += TAR_BLOCK;
      if (header.every((byte) => byte === 0)) {
        return entries;
      }
      verifyChecksum(header);

      const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
      const isMeta = type === 'x' || type === 'g' || type === 'L' || type === 'K';
      const paxSize = isMeta ? undefined : pax.get('size');
      const size = paxSize === undefined ? readOctal(header, 124, 12) : Number(paxSize);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error('invalid entry size in the tar archive');
      }
      const dataStart = position;
      position += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

      if (type === 'x') {
        pax = parsePax(readBytes(fd, size, dataStart));
        continue;
      }
      if (type === 'g') {
        // Global header; git stores the archived commit id in it.
        continue;
      }
      if (type === 'L' || type === 'K') {
        const value = cString(readBytes(fd, size, dataStart));
        if (type === 'L') {
          longName = value;
        } else {
          longLink = value;
        }
        continue;
      }

      const name = pax.get('path') ?? longName ?? ustarName(header);
      const linkName = pax.get('linkpath') ?? longLink ?? cString(header.subarray(157, 257));
      pax = new Map<string, string>();
      longName = undefined;
      longLink = undefined;

      const target = entryPath(destDir, name);
      assertNotThroughLink(links, destDir, target);
      if (type === '5') {
        fs.mkdirSync(target, { recursive: true });
      } else if (type === '0' || type === '7') {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        copyEntry(fd, chunk, dataStart, size, target, readOctal(header, 100, 8) & 0o777);
      } else if (type === '2') {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (options.symlinks) {
          fs.symlinkSync(linkName, target);
          links.add(target);
        } else {
          fs.writeFileSync(target, linkName);
        }
      } else {
        throw new Error(`unsupported tar entry type ${JSON.stringify(type)} for ${name}`);
      }
      entries += 1;
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function sha256File(file: string): string {
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(COPY_CHUNK);
  const fd = fs.openSync(file, 'r');
  try {
    let read = fs.readSync(fd, chunk, 0, chunk.length, null);
    while (read > 0) {
      hash.update(chunk.subarray(0, read));
      read = fs.readSync(fd, chunk, 0, chunk.length, null);
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** SHA-256 of each named file in `dir`; files that do not exist are left out. */
export function hashArtifacts(dir: string, files: readonly string[]): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const file of files) {
    const location = path.join(dir, file);
    if (fs.existsSync(location)) {
      entries.push([file, sha256File(location)]);
    }
  }
  return Object.fromEntries(entries);
}

/** Replaces `target` through a temporary file in the same directory. */
export function writeFileReplacing(target: string, data: string): void {
  const suffix = `${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${suffix}`);
  try {
    fs.writeFileSync(temp, data, { flag: 'wx' });
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** Where the kernel embeds its builtin skills (crates/goose/src/skills/builtin.rs). */
export const BUILTIN_SKILLS_DIR = 'crates/goose/src/skills/builtins';
/** Example problems compiled into the kernel together with the math_modeling skill. */
export const BUILTIN_EXAMPLES_DIR = `${BUILTIN_SKILLS_DIR}/math_modeling/assets/examples`;

/** Builtin skills are the top-level `*.md` files, as `builtin::get_all` counts them. */
export function countBuiltinSkills(sourceRoot: string): number {
  const dir = path.join(sourceRoot, ...BUILTIN_SKILLS_DIR.split('/'));
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md')).length;
}

/** Directory names of the example problems the kernel embeds, sorted. */
export function listBundledExamples(sourceRoot: string): string[] {
  const dir = path.join(sourceRoot, ...BUILTIN_EXAMPLES_DIR.split('/'));
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export interface RustToolchain {
  /** `rustc --version` without the `rustc ` prefix, e.g. `1.96.1 (f0f8b4a2e 2026-06-11)`. */
  version: string;
  /** Host triple, the default build target. */
  host: string;
}

export function readRustToolchain(rustc: string, cwd: string): RustToolchain {
  const result = runCommand(rustc, ['-vV'], cwd);
  if (result.status !== 0) {
    throw new Error(`${rustc} -vV failed: ${result.stderr.trim() || `exit code ${result.status}`}`);
  }
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim());
  const version = (lines[0] ?? '').replace(/^rustc\s+/, '');
  const hostLine = lines.find((line) => line.startsWith('host: '));
  const host = hostLine ? hostLine.slice('host: '.length).trim() : '';
  if (!version || !host) {
    throw new Error(`unexpected output from ${rustc} -vV: ${JSON.stringify(result.stdout)}`);
  }
  return { version, host };
}

export function executableName(target: string): string {
  return target.includes('windows') ? 'goose.exe' : 'goose';
}

/** Stdout of `<binary> version --json` (crates/goose-cli/src/commands/version.rs). */
export function runKernelVersionJson(binary: string): string {
  const result = runCommand(binary, ['version', '--json'], path.dirname(binary));
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.status}`;
    throw new Error(`${binary} version --json failed: ${detail}`);
  }
  return result.stdout;
}

/** MinGW's linker cannot open non-ASCII paths, so Windows builds need an ASCII work tree. */
export function isAsciiPath(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value);
}
