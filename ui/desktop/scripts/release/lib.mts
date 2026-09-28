/**
 * Steps shared by build-release.mts and dev-manifest.mts (spec mathmodel-parity-and-beyond,
 * requirement 3). Node runs these files through type stripping: local imports keep their
 * extension and type-only imports use `import type`.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';
import {
  createManifest,
  parseKernelBuildInfo,
  provenanceDifferences,
} from '../../src/utils/buildManifest.ts';
import type { BuildManifest, BuildType } from '../../src/utils/buildManifest.ts';
import {
  PipelineError,
  countBuiltinSkills,
  errorMessage,
  hashArtifacts,
  listBundledExamples,
  runKernelVersionJson,
} from '../../src/utils/releaseSnapshot.ts';
import type { RustToolchain } from '../../src/utils/releaseSnapshot.ts';

/** `pnpm run <script> -- --flag` passes the `--` separator along; drop it. */
export function scriptArguments(): string[] {
  const args = process.argv.slice(2);
  return args[0] === '--' ? args.slice(1) : args;
}

export function parseOptions<T extends ParseArgsOptionsConfig>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: false }).values;
  } catch (error) {
    throw new PipelineError('arguments', errorMessage(error));
  }
}

export interface ManifestRequest {
  buildType: BuildType;
  binary: string;
  commit: string;
  dirty: boolean;
  /** Source tree the binary was compiled from; the content counts come from it. */
  sourceRoot: string;
  target: string;
  toolchain: RustToolchain;
}

/**
 * Hashes the binary before running it, reads the provenance it embeds (`goose version --json`)
 * and records both in a manifest. A kernel whose commit or dirty flag differs from what the
 * pipeline passed to cargo is rejected (requirement 3.6).
 */
export function collectManifest(request: ManifestRequest): BuildManifest {
  const file = path.basename(request.binary);
  const sha256 = hashArtifacts(path.dirname(request.binary), [file])[file];
  if (sha256 === undefined) {
    throw new PipelineError('manifest', `${request.binary} does not exist`);
  }

  let output: string;
  try {
    output = runKernelVersionJson(request.binary);
  } catch (error) {
    throw new PipelineError('provenance', errorMessage(error), { cause: error });
  }
  const parsed = parseKernelBuildInfo(output);
  if (!parsed.ok) {
    throw new PipelineError('provenance', `goose version --json: ${parsed.reason}`);
  }

  let manifest: BuildManifest;
  try {
    manifest = createManifest({
      commit: request.commit,
      dirty: request.dirty,
      buildType: request.buildType,
      toolchain: { rust: request.toolchain.version, node: process.versions.node },
      features: parsed.info.features,
      target: request.target,
      version: parsed.info.version,
      artifacts: [{ file, sha256 }],
      content: {
        skills: countBuiltinSkills(request.sourceRoot),
        examples: listBundledExamples(request.sourceRoot),
      },
    });
  } catch (error) {
    throw new PipelineError('manifest', errorMessage(error), { cause: error });
  }

  const differences = provenanceDifferences(manifest, parsed.info);
  if (differences.length > 0) {
    const list = differences.join('\n  ');
    throw new PipelineError(
      'provenance',
      `the kernel embeds other build information than the pipeline passed to cargo:\n  ${list}`
    );
  }
  return manifest;
}

/** Prints the failed stage and the reason and sets a non-zero exit code (requirement 3.7). */
export function reportFailure(script: string, error: unknown): void {
  if (error instanceof PipelineError) {
    console.error(`${script}: failed at stage "${error.stage}": ${error.message}`);
  } else if (error instanceof Error) {
    console.error(`${script}: failed: ${error.stack ?? error.message}`);
  } else {
    console.error(`${script}: failed: ${String(error)}`);
  }
  process.exitCode = 1;
}
