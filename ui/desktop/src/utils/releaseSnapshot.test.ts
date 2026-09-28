/**
 * Build pipeline integration tests on throwaway git repositories (spec
 * mathmodel-parity-and-beyond, task 4.6; requirement 3.1, 3.3, 3.4, 3.5, 3.8). Only git runs
 * here; cargo does not.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MANIFEST_FILE_NAME,
  createManifest,
  parseManifest,
  releaseProblems,
  serializeManifest,
  verifyManifest,
  type BuildManifest,
  type ManifestInput,
} from './buildManifest';
import {
  PipelineError,
  assertCleanSnapshot,
  exportSnapshot,
  git,
  hashArtifacts,
  listSnapshotChanges,
  publishRelease,
  readSourceState,
  resolveCommit,
  sha256File,
  type SourceState,
} from './releaseSnapshot';

const GIT_TIMEOUT = 30_000;

/** Local settings of every test repository; global git configuration is never touched. */
const REPO_CONFIG: Record<string, string> = {
  'user.name': 'ModelForge Test',
  'user.email': 'test@example.invalid',
  'commit.gpgsign': 'false',
  'tag.gpgsign': 'false',
  'core.autocrlf': 'false',
};

/** Over 100 bytes with slashes (ustar prefix field) and without (pax path header). */
const LONG_DIR = Array.from({ length: 6 }, (_, index) => `directory-level-${index}`).join('/');
const LONG_NAME = `${'n'.repeat(110)}.txt`;

const FILES: Record<string, string> = {
  '.gitignore': '/target/\n',
  'Cargo.toml': '[workspace]\n',
  'crates/goose/src/lib.rs': 'pub fn kept() {}\n',
  'crates/goose/src/removed.rs': 'pub fn removed() {}\n',
  '中文 目录/说明.md': '# 说明\n',
  [`${LONG_DIR}/nested.txt`]: 'nested\n',
  [LONG_NAME]: 'long name\n',
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-release-'));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, file: string, content: string): void {
  const target = path.join(root, ...file.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function read(root: string, file: string): string {
  return fs.readFileSync(path.join(root, ...file.split('/')), 'utf8');
}

function head(repo: string): string {
  return git(['rev-parse', 'HEAD'], repo).trim();
}

function commitAll(repo: string, message: string): string {
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', message], repo);
  return head(repo);
}

function initRepo(files: Record<string, string>): string {
  const repo = path.join(tempDir(), 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q'], repo);
  for (const [key, value] of Object.entries(REPO_CONFIG)) {
    git(['config', key, value], repo);
  }
  for (const [file, content] of Object.entries(files)) {
    write(repo, file, content);
  }
  commitAll(repo, 'initial');
  return repo;
}

/** Paths of the files and symbolic links in `commit`, sorted. */
function trackedFiles(repo: string, commit: string): string[] {
  return git(['ls-tree', '-r', '-z', '--name-only', commit], repo)
    .split('\0')
    .filter((name) => name !== '')
    .sort();
}

/** Paths of the files and symbolic links below `root`, `/`-separated and sorted. */
function listFiles(root: string, prefix = ''): string[] {
  const entries = fs.readdirSync(path.join(root, prefix), { withFileTypes: true });
  return entries
    .flatMap((entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? listFiles(root, relative) : [relative];
    })
    .sort();
}

/** The PipelineError `action` stops with; anything else fails the test. */
function pipelineFailure(action: () => void): PipelineError {
  try {
    action();
  } catch (error) {
    if (error instanceof PipelineError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the pipeline to stop');
}

function exportFixture(): { repo: string; commit: string; snapshot: string } {
  const repo = initRepo(FILES);
  const commit = head(repo);
  const snapshot = path.join(tempDir(), 'snapshot');
  exportSnapshot(repo, commit, snapshot);
  return { repo, commit, snapshot };
}

const MANIFEST_BASE: ManifestInput = {
  commit: '0123456789abcdef0123456789abcdef01234567',
  dirty: false,
  buildType: 'release',
  toolchain: { rust: '1.96.1', node: '24.10.0' },
  features: ['rustls-tls'],
  target: 'x86_64-pc-windows-gnu',
  version: '1.50.0',
  builtAt: '2026-09-20T08:00:00.000Z',
  artifacts: [{ file: 'goose.exe', sha256: 'a'.repeat(64) }],
  content: { skills: 0, examples: [] },
};

describe('release snapshot (requirement 3.1, 3.3)', () => {
  it(
    'holds exactly the files of the commit: no deleted, uncommitted or untracked files',
    () => {
      const repo = initRepo(FILES);
      const symlinks = process.platform !== 'win32';
      if (symlinks) {
        write(repo, 'bin/run.sh', '#!/bin/sh\necho run\n');
        fs.chmodSync(path.join(repo, 'bin', 'run.sh'), 0o755);
        fs.symlinkSync('../Cargo.toml', path.join(repo, 'bin', 'cargo-link'));
      }
      fs.rmSync(path.join(repo, 'crates', 'goose', 'src', 'removed.rs'));
      const commit = commitAll(repo, 'remove a source file');

      // Work tree state that must not reach the snapshot.
      write(repo, 'crates/goose/src/lib.rs', 'pub fn uncommitted() {}\n');
      write(repo, 'untracked.rs', 'pub fn untracked() {}\n');
      write(repo, 'target/release/removed.o', 'stale build output');

      const snapshot = path.join(tempDir(), 'snapshot');
      exportSnapshot(repo, commit, snapshot);

      const removed = path.join(snapshot, 'crates', 'goose', 'src', 'removed.rs');
      expect(listFiles(snapshot)).toEqual(trackedFiles(repo, commit));
      expect(fs.existsSync(removed)).toBe(false);
      expect(read(snapshot, 'crates/goose/src/lib.rs')).toBe('pub fn kept() {}\n');
      expect(read(snapshot, '中文 目录/说明.md')).toBe('# 说明\n');
      expect(read(snapshot, `${LONG_DIR}/nested.txt`)).toBe('nested\n');
      expect(read(snapshot, LONG_NAME)).toBe('long name\n');
      expect(listSnapshotChanges(repo, commit, snapshot)).toEqual([]);
      if (symlinks) {
        expect(fs.statSync(path.join(snapshot, 'bin', 'run.sh')).mode & 0o111).not.toBe(0);
        expect(fs.readlinkSync(path.join(snapshot, 'bin', 'cargo-link'))).toBe('../Cargo.toml');
      }
    },
    GIT_TIMEOUT
  );

  it(
    'only starts in an empty destination',
    () => {
      const repo = initRepo(FILES);

      const failure = pipelineFailure(() => exportSnapshot(repo, head(repo), tempDir()));

      expect(failure.stage).toBe('snapshot');
    },
    GIT_TIMEOUT
  );

  it(
    'accepts only full ids of commits that exist',
    () => {
      const repo = initRepo(FILES);
      const commit = head(repo);
      git(['tag', '-a', 'v1', '-m', 'release'], repo);
      const tagObject = git(['rev-parse', 'v1'], repo).trim();
      const tree = git(['rev-parse', 'HEAD^{tree}'], repo).trim();

      expect(resolveCommit(repo, commit)).toBe(commit);
      expect(resolveCommit(repo, commit.toUpperCase())).toBe(commit);
      for (const sha of [commit.slice(0, 12), 'HEAD', 'f'.repeat(40), tree, tagObject]) {
        expect(pipelineFailure(() => resolveCommit(repo, sha)).stage).toBe('resolve');
      }
    },
    GIT_TIMEOUT
  );
});

function devManifest(state: SourceState): BuildManifest {
  return createManifest({
    ...MANIFEST_BASE,
    commit: state.commit,
    dirty: state.dirty,
    buildType: 'dev',
  });
}

const WORK_TREE_CHANGES: Array<[string, (repo: string) => void]> = [
  ['a modified tracked file', (repo) => write(repo, 'Cargo.toml', '[workspace]\nmembers = []\n')],
  [
    'a staged new file',
    (repo) => {
      write(repo, 'staged.rs', '');
      git(['add', 'staged.rs'], repo);
    },
  ],
  ['a deleted tracked file', (repo) => fs.rmSync(path.join(repo, 'Cargo.toml'))],
  ['an untracked file', (repo) => write(repo, 'notes/todo.md', 'todo\n')],
];

describe('dev build manifest dirty flag (requirement 3.4)', () => {
  it(
    'is false for a clean work tree, ignored build output included',
    () => {
      const repo = initRepo(FILES);
      write(repo, 'target/debug/goose', 'binary');

      const state = readSourceState(repo);

      expect(state).toEqual({ commit: head(repo), dirty: false, changes: [] });
      expect(devManifest(state).dirty).toBe(false);
    },
    GIT_TIMEOUT
  );

  it.each(WORK_TREE_CHANGES)(
    'is true with %s',
    (_label, change) => {
      const repo = initRepo(FILES);
      change(repo);

      const state = readSourceState(repo);

      expect(state.dirty).toBe(true);
      expect(state.changes).toHaveLength(1);
      expect(devManifest(state)).toMatchObject({
        buildType: 'dev',
        commit: head(repo),
        dirty: true,
      });
    },
    GIT_TIMEOUT
  );
});

const SNAPSHOT_CHANGES: Array<[string, (snapshot: string) => void, string]> = [
  ['an edited file', (snapshot) => write(snapshot, 'Cargo.toml', '# edited\n'), 'Cargo.toml'],
  ['a deleted file', (snapshot) => fs.rmSync(path.join(snapshot, 'Cargo.toml')), 'Cargo.toml'],
  [
    'a generated source file',
    (snapshot) => write(snapshot, 'crates/goose/src/generated.rs', '// generated\n'),
    'crates/goose/src/generated.rs',
  ],
];

describe('release stops on a dirty snapshot (requirement 3.8)', () => {
  it(
    'lets an untouched snapshot with ignored build output through',
    () => {
      const { repo, commit, snapshot } = exportFixture();
      write(snapshot, 'target/release/goose', 'binary');

      expect(() => assertCleanSnapshot(repo, commit, snapshot, 'after the build')).not.toThrow();
    },
    GIT_TIMEOUT
  );

  it.each(SNAPSHOT_CHANGES)(
    'stops on %s',
    (_label, change, file) => {
      const { repo, commit, snapshot } = exportFixture();
      change(snapshot);

      const check = () => assertCleanSnapshot(repo, commit, snapshot, 'after the build');
      const failure = pipelineFailure(check);

      expect(failure.stage).toBe('dirty');
      expect(failure.message).toContain('dirty: true');
      expect(failure.message).toContain(file);
    },
    GIT_TIMEOUT
  );
});

const BINARIES: Record<string, string> = {
  goose: 'kernel binary',
  'goose-helper': 'helper binary',
};
const BINARY_NAMES = Object.keys(BINARIES);

function buildOutput(): string {
  const dir = tempDir();
  for (const [file, content] of Object.entries(BINARIES)) {
    write(dir, file, content);
  }
  return dir;
}

function releaseManifest(binaryDir: string, overrides: Partial<ManifestInput> = {}) {
  const artifacts = BINARY_NAMES.map((file) => ({
    file,
    sha256: sha256File(path.join(binaryDir, file)),
  }));
  return createManifest({ ...MANIFEST_BASE, artifacts, ...overrides });
}

function publish(binaryDir: string, manifest: BuildManifest, outDir: string): void {
  publishRelease(
    {
      binaryDir,
      artifacts: BINARY_NAMES,
      manifestJson: serializeManifest(manifest),
      manifestName: MANIFEST_FILE_NAME,
      outDir,
    },
    releaseProblems
  );
}

describe('release publishing (requirement 3.5, 3.8)', () => {
  it('hashes files with SHA-256', () => {
    const dir = tempDir();
    write(dir, 'abc', 'abc');

    expect(sha256File(path.join(dir, 'abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('ships the binaries together with a manifest that still verifies', () => {
    const binaryDir = buildOutput();
    const manifest = releaseManifest(binaryDir);
    const outDir = path.join(tempDir(), 'dist', manifest.commit);

    publish(binaryDir, manifest, outDir);

    expect(fs.readdirSync(outDir).sort()).toEqual([...BINARY_NAMES, MANIFEST_FILE_NAME].sort());
    const shipped = parseManifest(read(outDir, MANIFEST_FILE_NAME));
    expect(shipped).toEqual({ ok: true, manifest });
    expect(verifyManifest(manifest, hashArtifacts(outDir, BINARY_NAMES))).toEqual([]);
    expect(fs.readdirSync(path.dirname(outDir))).toEqual([manifest.commit]);
  });

  it('stops a release built from a dirty source and writes nothing', () => {
    const binaryDir = buildOutput();
    const manifest = releaseManifest(binaryDir, { dirty: true });
    const outDir = path.join(tempDir(), 'dist');

    const failure = pipelineFailure(() => publish(binaryDir, manifest, outDir));

    expect(failure.stage).toBe('verify');
    expect(failure.message).toContain('uncommitted changes');
    expect(fs.readdirSync(path.dirname(outDir))).toEqual([]);
  });

  it('stops on SHA-256 mismatches, listing every file with recorded and actual hash', () => {
    const binaryDir = buildOutput();
    const manifest = releaseManifest(binaryDir);
    const outDir = path.join(tempDir(), 'dist');
    publish(binaryDir, manifest, outDir);
    const earlier = read(outDir, 'goose');
    for (const file of BINARY_NAMES) {
      write(binaryDir, file, `tampered ${file}`);
    }

    const failure = pipelineFailure(() => publish(binaryDir, manifest, outDir));

    expect(failure.stage).toBe('verify');
    for (const { file, sha256 } of manifest.artifacts) {
      const actual = sha256File(path.join(binaryDir, file));
      expect(failure.message).toContain(`${file}: recorded sha256 ${sha256}, actual ${actual}`);
    }
    // The earlier release is left as it was, and no staging directory remains.
    expect(read(outDir, 'goose')).toBe(earlier);
    expect(fs.readdirSync(path.dirname(outDir))).toEqual(['dist']);
  });
});
