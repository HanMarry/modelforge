#!/usr/bin/env node
/**
 * Release build of the kernel from one commit (spec mathmodel-parity-and-beyond, requirement
 * 3.1, 3.2, 3.3, 3.5, 3.7, 3.8).
 *
 *   node scripts/release/build-release.mts --sha <full commit id> [options]
 *   pnpm run release:build -- --sha <full commit id> [options]
 *   ..\..\build-release.ps1 -Sha <full commit id>      (Windows, MinGW toolchain)
 *
 * Stages, each named in the error when it fails:
 *   resolve     the commit id is a full 40-character id of a commit in the repository
 *   snapshot    `git archive` of that commit into an empty directory under --work-dir
 *   dirty       the snapshot equals the commit, before and after the build
 *   build       cargo build --release --locked inside the snapshot, with GOOSE_BUILD_COMMIT and
 *               GOOSE_BUILD_DIRTY set so build.rs embeds them
 *   provenance  `goose version --json` reports the commit and dirty flag cargo was given
 *   manifest    build-manifest.json with toolchain, features, target, content and SHA-256
 *   verify      the staged manifest is re-read and every binary re-hashed; a dirty source or
 *               any SHA-256 mismatch stops the release and lists file, recorded and actual hash
 *   publish     the staged directory becomes --out-dir
 * Nothing is written to --out-dir unless every stage passes.
 *
 * Options:
 *   --sha <id>              commit to build (required)
 *   --repo <dir>            repository (default: the one containing the current directory)
 *   --work-dir <dir>        parent of the snapshot; must be ASCII on Windows
 *                           (default: <tmp>/modelforge-release)
 *   --out-dir <dir>         result directory (default: <work-dir>/dist/<commit>)
 *   --features <list>       goose-cli features, comma-separated
 *   --no-default-features   build without goose-cli's default features
 *   --target <triple>       target triple (default: the host of rustc)
 *   --cargo <cmd>           cargo to run (default: cargo)
 *   --rustc <cmd>           rustc to record and build with (default: rustc)
 *   --keep-snapshot         keep the snapshot directory after a successful build
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MANIFEST_FILE_NAME,
  releaseProblems,
  serializeManifest,
} from '../../src/utils/buildManifest.ts';
import type { BuildManifest } from '../../src/utils/buildManifest.ts';
import {
  PipelineError,
  assertCleanSnapshot,
  errorMessage,
  executableName,
  exportSnapshot,
  git,
  isAsciiPath,
  publishRelease,
  readRustToolchain,
  resolveCommit,
} from '../../src/utils/releaseSnapshot.ts';
import type { RustToolchain } from '../../src/utils/releaseSnapshot.ts';
import { collectManifest, parseOptions, reportFailure, scriptArguments } from './lib.mts';

interface ReleaseOptions {
  sha: string;
  repo: string | undefined;
  workDir: string | undefined;
  outDir: string | undefined;
  features: string | undefined;
  noDefaultFeatures: boolean;
  target: string | undefined;
  cargo: string;
  rustc: string;
  keepSnapshot: boolean;
}

function readOptions(): ReleaseOptions {
  const values = parseOptions(scriptArguments(), {
    sha: { type: 'string' },
    repo: { type: 'string' },
    'work-dir': { type: 'string' },
    'out-dir': { type: 'string' },
    features: { type: 'string' },
    'no-default-features': { type: 'boolean', default: false },
    target: { type: 'string' },
    cargo: { type: 'string', default: 'cargo' },
    rustc: { type: 'string', default: 'rustc' },
    'keep-snapshot': { type: 'boolean', default: false },
  });
  if (!values.sha) {
    throw new PipelineError('arguments', 'missing --sha <full 40-character commit id>');
  }
  return {
    sha: values.sha,
    repo: values.repo,
    workDir: values['work-dir'],
    outDir: values['out-dir'],
    features: values.features,
    noDefaultFeatures: values['no-default-features'],
    target: values.target,
    cargo: values.cargo,
    rustc: values.rustc,
    keepSnapshot: values['keep-snapshot'],
  };
}

function findRepository(): string {
  try {
    return git(['rev-parse', '--show-toplevel'], process.cwd()).trim();
  } catch (error) {
    const reason = errorMessage(error);
    throw new PipelineError('arguments', `not inside a git repository; pass --repo (${reason})`);
  }
}

function readToolchain(rustc: string, snapshotDir: string): RustToolchain {
  try {
    return readRustToolchain(rustc, snapshotDir);
  } catch (error) {
    throw new PipelineError('build', errorMessage(error), { cause: error });
  }
}

function buildKernel(
  options: ReleaseOptions,
  snapshotDir: string,
  commit: string,
  target: string
): string {
  const targetDir = path.join(snapshotDir, 'target');
  const args = ['build', '--release', '--locked', '-p', 'goose-cli', '--bin', 'goose'];
  if (options.noDefaultFeatures) {
    args.push('--no-default-features');
  }
  if (options.features) {
    args.push('--features', options.features);
  }
  if (options.target) {
    args.push('--target', options.target);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CARGO_TARGET_DIR: targetDir,
    GOOSE_BUILD_COMMIT: commit,
    GOOSE_BUILD_DIRTY: 'false',
  };
  if (options.rustc !== 'rustc') {
    env.RUSTC = options.rustc;
  }

  console.log(`[build] ${options.cargo} ${args.join(' ')}`);
  const result = spawnSync(options.cargo, args, {
    cwd: snapshotDir,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    throw new PipelineError('build', `cannot run ${options.cargo}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new PipelineError('build', `cargo build failed (${result.status ?? result.signal})`);
  }

  const profileDir = options.target
    ? path.join(targetDir, options.target, 'release')
    : path.join(targetDir, 'release');
  const binary = path.join(profileDir, executableName(target));
  if (!fs.existsSync(binary)) {
    throw new PipelineError('build', `cargo finished but ${binary} does not exist`);
  }
  return binary;
}

/**
 * Stages the binaries and the manifest next to --out-dir, re-reads the manifest and re-hashes
 * every binary (requirement 3.5), and only then moves the staged directory into place.
 */
function publish(manifest: BuildManifest, binary: string, outDir: string): void {
  publishRelease(
    {
      binaryDir: path.dirname(binary),
      artifacts: manifest.artifacts.map(({ file }) => file),
      manifestJson: serializeManifest(manifest),
      manifestName: MANIFEST_FILE_NAME,
      outDir,
    },
    releaseProblems
  );
}

function main(): void {
  const options = readOptions();
  const repo = path.resolve(options.repo ?? findRepository());
  const commit = resolveCommit(repo, options.sha);
  console.log(`[resolve] ${commit}`);

  const workDir = path.resolve(options.workDir ?? path.join(os.tmpdir(), 'modelforge-release'));
  if (process.platform === 'win32' && !isAsciiPath(workDir)) {
    throw new PipelineError(
      'snapshot',
      `work directory ${workDir} is not an ASCII path, where MinGW cannot link; pass --work-dir`
    );
  }
  const snapshotDir = path.join(workDir, `snapshot-${commit.slice(0, 12)}`);
  const outDir = path.resolve(options.outDir ?? path.join(workDir, 'dist', commit));

  console.log(`[snapshot] git archive ${commit} -> ${snapshotDir}`);
  fs.mkdirSync(workDir, { recursive: true });
  fs.rmSync(snapshotDir, { recursive: true, force: true });
  exportSnapshot(repo, commit, snapshotDir);
  assertCleanSnapshot(repo, commit, snapshotDir, 'after the export');

  const toolchain = readToolchain(options.rustc, snapshotDir);
  const target = options.target ?? toolchain.host;
  console.log(`[build] rustc ${toolchain.version}, target ${target}`);
  const binary = buildKernel(options, snapshotDir, commit, target);
  // Build scripts must not rewrite tracked sources: the binary would not match the commit.
  assertCleanSnapshot(repo, commit, snapshotDir, 'after the build');

  console.log(`[manifest] ${binary}`);
  const manifest = collectManifest({
    buildType: 'release',
    binary,
    commit,
    dirty: false,
    sourceRoot: snapshotDir,
    target,
    toolchain,
  });

  console.log(`[verify] ${outDir}`);
  publish(manifest, binary, outDir);
  if (!options.keepSnapshot) {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  }
  console.log(`release build of ${commit} written to ${outDir}`);
}

try {
  main();
} catch (error) {
  reportFailure('build-release', error);
}
