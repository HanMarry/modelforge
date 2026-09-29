/**
 * Example library loader and completeness rules (requirement 9.1, 9.6).
 *
 * The manifest (`example.json`) is the single source of truth for what an example ships.
 * A manifest missing any required field is dropped; a complete manifest whose statement or
 * attachments are not on disk is only shown as "download yourself" when its licence does
 * not permit redistribution.
 */
import type {
  ExampleCategory,
  ExampleEntry,
  ExampleManifest,
  ExampleSolutionSection,
} from '../../types/catalog';

export const EXAMPLE_MANIFEST_FILE = 'example.json';

const CATEGORIES: readonly ExampleCategory[] = ['优化类', '预测/统计类', '综合评价类'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isCategory(value: unknown): value is ExampleCategory {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

function isSolutionSection(value: unknown): value is ExampleSolutionSection {
  return (
    isRecord(value) &&
    isNonEmptyString(value.question) &&
    isNonEmptyString(value.file)
  );
}

function isLicense(value: unknown): value is ExampleManifest['license'] {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.type) &&
    typeof value.redistributable === 'boolean' &&
    isNonEmptyString(value.note)
  );
}

/** A complete manifest names a statement, at least one attachment, and per-question solution. */
export function isCompleteManifest(value: unknown): value is ExampleManifest {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.id)) return false;
  if (!isNonEmptyString(value.title)) return false;
  if (!isCategory(value.category)) return false;
  if (!isNonEmptyString(value.source)) return false;
  if (!isLicense(value.license)) return false;
  if (typeof value.officialUrl !== 'undefined' && typeof value.officialUrl !== 'string') {
    return false;
  }
  if (!isNonEmptyString(value.problemFile)) return false;
  if (!Array.isArray(value.attachments) || value.attachments.length === 0) return false;
  if (!value.attachments.every((file) => isNonEmptyString(file))) return false;
  if (!Array.isArray(value.solution) || value.solution.length === 0) return false;
  if (!value.solution.every((section) => isSolutionSection(section))) return false;
  return true;
}

/** Classify a parsed manifest; incomplete manifests do not enter the library (9.1). */
export function classifyExample(
  manifest: unknown,
  hasLocalFile: (relativePath: string) => boolean
): ExampleEntry | null {
  if (!isCompleteManifest(manifest)) {
    return null;
  }
  const filesPresent =
    hasLocalFile(manifest.problemFile) &&
    manifest.attachments.every((file) => hasLocalFile(file));
  const needsDownload = !filesPresent && !manifest.license.redistributable;
  return { manifest, needsDownload };
}

/**
 * The relative paths the packaging script keeps for an example (9.6). The statement and
 * attachments are shipped only when the licence explicitly allows redistribution; the
 * manifest and reference solution always ship.
 */
export function bundleFiles(manifest: ExampleManifest): string[] {
  const files = [EXAMPLE_MANIFEST_FILE, ...manifest.solution.map((section) => section.file)];
  if (manifest.license.redistributable) {
    files.push(manifest.problemFile, ...manifest.attachments);
  }
  return files;
}

/** Whether the statement and attachments may be bundled at all (9.6). */
export function shipsProblemAndAttachments(manifest: ExampleManifest): boolean {
  return manifest.license.redistributable;
}
