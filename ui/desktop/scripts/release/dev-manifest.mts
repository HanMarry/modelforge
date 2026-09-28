#!/usr/bin/env node
/**
 * Build_Manifest for dev builds (spec mathmodel-parity-and-beyond, requirement 3.4), called by
 * build-kernel.ps1 around `cargo build`:
 *
 *   node scripts/release/dev-manifest.mts source-state --repo <dir>
 *     Before compiling: prints {"commit", "dirty", "changes"} of the working tree. dirty is true
 *     when `git status --porcelain --untracked-files=normal` lists anything. Non-ASCII
 *     characters are \u-escaped, so PowerShell parses the JSON whatever its code page.
 *
 *   node scripts/release/dev-manifest.mts write --binary <goose[.exe]> --commit <id>
 *       --dirty <true|false> --source-root <dir> [--target <triple>] [--rustc <cmd>] [--out <file>]
 *     After compiling: hashes the binary, checks the provenance it embeds against --commit and
 *     --dirty, and writes build-manifest.json (buildType "dev") next to the binary.
 */
import path from 'node:path';
import { MANIFEST_FILE_NAME, serializeManifest } from '../../src/utils/buildManifest.ts';
import {
  PipelineError,
  errorMessage,
  readRustToolchain,
  readSourceState,
  writeFileReplacing,
} from '../../src/utils/releaseSnapshot.ts';
import type { RustToolchain } from '../../src/utils/releaseSnapshot.ts';
import { collectManifest, parseOptions, reportFailure, scriptArguments } from './lib.mts';

function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

function printSourceState(args: string[]): void {
  const values = parseOptions(args, { repo: { type: 'string' } });
  const state = readSourceState(path.resolve(values.repo ?? process.cwd()));
  console.log(asciiJson(state));
}

function parseDirty(value: string | undefined): boolean {
  if (value === 'true' || value === 'false') {
    return value === 'true';
  }
  const got = JSON.stringify(value) ?? 'nothing';
  throw new PipelineError('arguments', `--dirty must be true or false, got ${got}`);
}

function writeManifest(args: string[]): void {
  const values = parseOptions(args, {
    binary: { type: 'string' },
    commit: { type: 'string' },
    dirty: { type: 'string' },
    'source-root': { type: 'string' },
    target: { type: 'string' },
    rustc: { type: 'string', default: 'rustc' },
    out: { type: 'string' },
  });
  if (!values.binary || !values.commit || !values['source-root']) {
    throw new PipelineError('arguments', '--binary, --commit and --source-root are required');
  }
  const dirty = parseDirty(values.dirty);
  const binary = path.resolve(values.binary);
  const sourceRoot = path.resolve(values['source-root']);

  let toolchain: RustToolchain;
  try {
    toolchain = readRustToolchain(values.rustc, sourceRoot);
  } catch (error) {
    throw new PipelineError('manifest', errorMessage(error), { cause: error });
  }
  const manifest = collectManifest({
    buildType: 'dev',
    binary,
    commit: values.commit,
    dirty,
    sourceRoot,
    target: values.target ?? toolchain.host,
    toolchain,
  });

  const out = path.resolve(values.out ?? path.join(path.dirname(binary), MANIFEST_FILE_NAME));
  try {
    writeFileReplacing(out, serializeManifest(manifest));
  } catch (error) {
    throw new PipelineError('publish', `cannot write ${out}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  console.log(`wrote ${out} (commit ${manifest.commit}, dirty ${manifest.dirty})`);
}

try {
  const [command, ...rest] = scriptArguments();
  if (command === 'source-state') {
    printSourceState(rest);
  } else if (command === 'write') {
    writeManifest(rest);
  } else {
    throw new PipelineError(
      'arguments',
      `usage: dev-manifest.mts source-state|write [options] (got ${JSON.stringify(command)})`
    );
  }
} catch (error) {
  reportFailure('dev-manifest', error);
}
