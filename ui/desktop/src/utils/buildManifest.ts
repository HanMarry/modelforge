/**
 * Build_Manifest (spec mathmodel-parity-and-beyond, requirement 3.2, 3.5, 3.6, 3.8, 3.9): the
 * commit a kernel binary was built from, whether that source had uncommitted changes, the
 * toolchain, features and target, and the SHA-256 of every output binary.
 *
 * Pure functions without imports. The release scripts (scripts/release/*.mts) run this file
 * directly under Node's type stripping, so it may only use erasable TypeScript syntax: no enums,
 * namespaces, parameter properties or runtime imports of other local modules.
 */

export const MANIFEST_FILE_NAME = 'build-manifest.json';
export const MANIFEST_SCHEMA_VERSION = 1;

export type BuildType = 'release' | 'dev';

export interface BuildArtifact {
  /** Bare file name, stored next to the manifest (for example `goose.exe`). */
  file: string;
  /** Lowercase hexadecimal SHA-256, 64 characters. */
  sha256: string;
}

export interface BuildContent {
  /** Builtin skills compiled into the kernel (requirement 7.1). */
  skills: number;
  /** Example problems shipped with the build, by directory name. */
  examples: string[];
}

export interface BuildManifest {
  schemaVersion: 1;
  /** Full 40-character lowercase commit id. */
  commit: string;
  dirty: boolean;
  buildType: BuildType;
  toolchain: { rust: string; node: string };
  /** Sorted cargo features of goose-cli. */
  features: string[];
  /** Rust target triple, for example `x86_64-pc-windows-gnu`. */
  target: string;
  /** Kernel version as reported by `goose version --json`. */
  version: string;
  /** ISO 8601 date-time. */
  builtAt: string;
  artifacts: BuildArtifact[];
  content: BuildContent;
}

export type ManifestResult = { ok: true; manifest: BuildManifest } | { ok: false; reason: string };

export interface ManifestInput {
  commit: string;
  dirty: boolean;
  buildType: BuildType;
  toolchain: { rust: string; node: string };
  features: readonly string[];
  target: string;
  version: string;
  /** Defaults to now. */
  builtAt?: string | Date;
  artifacts: readonly BuildArtifact[];
  content: { skills: number; examples: readonly string[] };
}

export interface ManifestMismatch {
  file: string;
  /** SHA-256 recorded in the manifest. */
  recorded: string;
  /** SHA-256 computed from the file, or `null` when the file is missing. */
  actual: string | null;
}

/** `goose version --json` (crates/goose-cli/src/commands/version.rs). */
export interface KernelBuildInfo {
  version: string;
  /** `null` when the kernel was built without provenance. */
  commit: string | null;
  dirty: boolean | null;
  features: string[];
}

export type KernelBuildInfoResult =
  | { ok: true; info: KernelBuildInfo }
  | { ok: false; reason: string };

export type ReleaseBlocker =
  | { kind: 'not-release'; buildType: BuildType }
  | { kind: 'dirty' }
  | { kind: 'mismatch'; mismatches: ManifestMismatch[] };

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function isFullCommitSha(value: unknown): value is string {
  return typeof value === 'string' && COMMIT_PATTERN.test(value);
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

/**
 * A bare file name. Artifacts never name directories, so verifying a manifest cannot be made to
 * read files outside the manifest's own folder.
 */
export function isArtifactFileName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes(':') &&
    !value.includes('\0')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNameList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}

function isIsoDateTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_DATE_TIME_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function invalid(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/** Checks every field requirement 3.2 asks for and returns a copy without unknown keys. */
export function validateManifest(value: unknown): ManifestResult {
  if (!isRecord(value)) {
    return invalid('manifest is not a JSON object');
  }
  if (value.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    return invalid(`unsupported schemaVersion ${JSON.stringify(value.schemaVersion)}`);
  }
  if (!isFullCommitSha(value.commit)) {
    return invalid('commit must be a full 40-character lowercase hex commit id');
  }
  if (typeof value.dirty !== 'boolean') {
    return invalid('dirty must be true or false');
  }
  const buildType = value.buildType;
  if (buildType !== 'release' && buildType !== 'dev') {
    return invalid('buildType must be "release" or "dev"');
  }
  const toolchain = value.toolchain;
  if (
    !isRecord(toolchain) ||
    !isNonEmptyString(toolchain.rust) ||
    !isNonEmptyString(toolchain.node)
  ) {
    return invalid('toolchain.rust and toolchain.node must be non-empty strings');
  }
  if (!isNameList(value.features)) {
    return invalid('features must be an array of feature names');
  }
  if (!isNonEmptyString(value.target)) {
    return invalid('target must be a non-empty target triple');
  }
  if (!isNonEmptyString(value.version)) {
    return invalid('version must be a non-empty string');
  }
  if (!isIsoDateTime(value.builtAt)) {
    return invalid('builtAt must be an ISO 8601 date-time');
  }

  const artifacts = value.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return invalid('artifacts must list at least one binary');
  }
  const checkedArtifacts: BuildArtifact[] = [];
  const seen = new Set<string>();
  for (const [index, artifact] of artifacts.entries()) {
    if (!isRecord(artifact) || !isArtifactFileName(artifact.file)) {
      return invalid(`artifacts[${index}].file must be a bare file name`);
    }
    if (!isSha256Hex(artifact.sha256)) {
      return invalid(`artifacts[${index}].sha256 must be 64 lowercase hex characters`);
    }
    if (seen.has(artifact.file)) {
      return invalid(`artifacts lists ${artifact.file} more than once`);
    }
    seen.add(artifact.file);
    checkedArtifacts.push({ file: artifact.file, sha256: artifact.sha256 });
  }

  const content = value.content;
  if (!isRecord(content)) {
    return invalid('content must be an object');
  }
  const skills = content.skills;
  if (typeof skills !== 'number' || !Number.isSafeInteger(skills) || skills < 0) {
    return invalid('content.skills must be a non-negative integer');
  }
  if (!isNameList(content.examples)) {
    return invalid('content.examples must be an array of example names');
  }

  return {
    ok: true,
    manifest: {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      commit: value.commit,
      dirty: value.dirty,
      buildType,
      toolchain: { rust: toolchain.rust, node: toolchain.node },
      features: [...value.features],
      target: value.target,
      version: value.version,
      builtAt: value.builtAt,
      artifacts: checkedArtifacts,
      content: { skills, examples: [...content.examples] },
    },
  };
}

export function parseManifest(json: string): ManifestResult {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return invalid(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateManifest(value);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Builds a manifest from what a pipeline collected. Features and examples are sorted, hashes and
 * the commit lowercased; anything requirement 3.2 would reject throws.
 */
export function createManifest(input: ManifestInput): BuildManifest {
  const builtAt = input.builtAt ?? new Date();
  const result = validateManifest({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    commit: input.commit.toLowerCase(),
    dirty: input.dirty,
    buildType: input.buildType,
    toolchain: { rust: input.toolchain.rust, node: input.toolchain.node },
    features: sortedUnique(input.features),
    target: input.target,
    version: input.version,
    builtAt: typeof builtAt === 'string' ? builtAt : builtAt.toISOString(),
    artifacts: input.artifacts.map(({ file, sha256 }) => ({ file, sha256: sha256.toLowerCase() })),
    content: { skills: input.content.skills, examples: sortedUnique(input.content.examples) },
  });
  if (!result.ok) {
    throw new Error(`Invalid build manifest: ${result.reason}`);
  }
  return result.manifest;
}

export function serializeManifest(manifest: BuildManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Compares the recorded SHA-256 of every artifact with `actual` (file name → SHA-256 computed
 * from the file). Returns one entry per artifact that differs or is missing, in manifest order;
 * an empty list means every binary matches (requirement 3.5). Files in `actual` that the
 * manifest does not list are ignored.
 */
export function verifyManifest(
  manifest: BuildManifest,
  actual: Readonly<Record<string, string>>
): ManifestMismatch[] {
  const mismatches: ManifestMismatch[] = [];
  for (const { file, sha256 } of manifest.artifacts) {
    const found = Object.hasOwn(actual, file) ? actual[file] : undefined;
    if (found === undefined) {
      mismatches.push({ file, recorded: sha256, actual: null });
    } else if (found.toLowerCase() !== sha256.toLowerCase()) {
      mismatches.push({ file, recorded: sha256, actual: found });
    }
  }
  return mismatches;
}

/**
 * Why a manifest must not be published (requirement 3.5, 3.8): not a release build, built from a
 * dirty source, or binaries that no longer match their recorded SHA-256. Empty when it may be.
 */
export function releaseBlockers(
  manifest: BuildManifest,
  actual: Readonly<Record<string, string>>
): ReleaseBlocker[] {
  const blockers: ReleaseBlocker[] = [];
  if (manifest.buildType !== 'release') {
    blockers.push({ kind: 'not-release', buildType: manifest.buildType });
  }
  if (manifest.dirty) {
    blockers.push({ kind: 'dirty' });
  }
  const mismatches = verifyManifest(manifest, actual);
  if (mismatches.length > 0) {
    blockers.push({ kind: 'mismatch', mismatches });
  }
  return blockers;
}

/** One line per problem, naming every mismatching file with its recorded and actual SHA-256. */
export function describeReleaseBlocker(blocker: ReleaseBlocker): string[] {
  switch (blocker.kind) {
    case 'not-release':
      return [`build type is "${blocker.buildType}"; only release builds can be published`];
    case 'dirty':
      return ['the source snapshot contains uncommitted changes (dirty: true)'];
    case 'mismatch':
      return blocker.mismatches.map(
        ({ file, recorded, actual }) =>
          `${file}: recorded sha256 ${recorded}, actual ${actual ?? '(file missing)'}`
      );
  }
}

/**
 * The last check before a release is published: the manifest as it will be shipped must parse,
 * and `releaseBlockers` must find nothing. One line per problem; empty when it may be published.
 */
export function releaseProblems(
  manifestJson: string,
  actual: Readonly<Record<string, string>>
): string[] {
  const parsed = parseManifest(manifestJson);
  if (!parsed.ok) {
    return [`the manifest is invalid: ${parsed.reason}`];
  }
  return releaseBlockers(parsed.manifest, actual).flatMap(describeReleaseBlocker);
}

export function parseKernelBuildInfo(json: string): KernelBuildInfoResult {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return invalid(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) {
    return invalid('build info is not a JSON object');
  }
  if (!isNonEmptyString(value.version)) {
    return invalid('version must be a non-empty string');
  }
  const commit = value.commit;
  if (commit !== null && !isFullCommitSha(commit)) {
    return invalid('commit must be a full commit id or null');
  }
  const dirty = value.dirty;
  if (dirty !== null && typeof dirty !== 'boolean') {
    return invalid('dirty must be true, false or null');
  }
  if (!isNameList(value.features)) {
    return invalid('features must be an array of feature names');
  }
  return {
    ok: true,
    info: { version: value.version, commit, dirty, features: [...value.features] },
  };
}

/**
 * Where the provenance a kernel reports about itself disagrees with its manifest
 * (requirement 3.6). Empty when they agree.
 */
export function provenanceDifferences(manifest: BuildManifest, info: KernelBuildInfo): string[] {
  const differences: string[] = [];
  if (info.commit !== manifest.commit) {
    differences.push(`commit: manifest ${manifest.commit}, kernel ${info.commit ?? 'unknown'}`);
  }
  if (info.dirty !== manifest.dirty) {
    differences.push(`dirty: manifest ${manifest.dirty}, kernel ${info.dirty ?? 'unknown'}`);
  }
  if (info.version !== manifest.version) {
    differences.push(`version: manifest ${manifest.version}, kernel ${info.version}`);
  }
  const kernelFeatures = sortedUnique(info.features).join(',');
  if (kernelFeatures !== manifest.features.join(',')) {
    differences.push(
      `features: manifest [${manifest.features.join(', ')}], kernel [${kernelFeatures}]`
    );
  }
  return differences;
}
