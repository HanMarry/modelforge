/**
 * Pure helpers for mock review records (requirement 19.6, task 26.4), shared by the main-process
 * store (`reviewStore.ts`) and the review panel. No Node imports, so the renderer can use them.
 *
 * Records live at `.modelforge/reviews/<paperRelPathHash>/<timestamp>.json`; the hash is taken in
 * the main process over the canonical path this module normalizes.
 */
import type { ReviewPaperFormat } from '../../types/reviewApi';
import { validateReview, type ReviewOutput, type ReviewRecord } from './reviewModel';

const FORMAT_BY_EXTENSION: Record<string, ReviewPaperFormat> = {
  '.tex': 'latex',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.pdf': 'pdf',
};

/** Largest record file the store reads back; real records are a few kilobytes. */
export const MAX_RECORD_BYTES = 1024 * 1024;

/**
 * The paper format the review skill accepts for this path (LaTeX, Markdown or PDF), from the
 * extension, case-insensitively; null for anything else.
 */
export function reviewPaperFormat(paperPath: string): ReviewPaperFormat | null {
  const name = paperPath.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return FORMAT_BY_EXTENSION[name.slice(dot).toLowerCase()] ?? null;
}

/**
 * Lexical normal form of a project-relative paper path: `/` separated, without empty or `.`
 * segments. Null when the path is empty, absolute (POSIX, drive letter or UNC), contains a NUL
 * or has any `..` segment, so a request can never name a file outside the project.
 */
export function normalizePaperPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.includes('\0')) return null;
  const slashed = raw.replace(/\\/g, '/');
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) return null;
  const parts: string[] = [];
  for (const part of slashed.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return parts.length > 0 ? parts.join('/') : null;
}

/**
 * File name of a record completed at `completedAt`: the ISO 8601 UTC time with `:` replaced by
 * `-` (Windows does not allow `:`), so names sort chronologically. `attempt` > 0 adds a suffix
 * when a record with the same millisecond already exists; existing files are never replaced.
 */
export function reviewRecordFileName(completedAt: Date, attempt = 0): string {
  const stamp = completedAt.toISOString().replace(/:/g, '-');
  return attempt > 0 ? `${stamp}-${attempt}.json` : `${stamp}.json`;
}

export function buildReviewRecord(
  paper: string,
  competitionId: string,
  completedAt: Date,
  review: ReviewOutput
): ReviewRecord {
  return {
    paper,
    competitionId,
    completedAt: completedAt.toISOString(),
    dimensions: review.dimensions,
    suggestions: review.suggestions,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A stored record read back from disk, or null when it is not a completed review of `paper`:
 * wrong paper (hash collision or a moved file), missing competition, unparsable time, or a
 * review body that fails {@link validateReview}.
 */
export function parseStoredRecord(value: unknown, paper: string): ReviewRecord | null {
  if (!isObject(value) || value.paper !== paper) return null;
  const { competitionId, completedAt } = value;
  if (typeof competitionId !== 'string' || competitionId.trim() === '') return null;
  if (typeof completedAt !== 'string' || Number.isNaN(Date.parse(completedAt))) return null;
  const validation = validateReview(value);
  if (!validation.valid) return null;
  return {
    paper,
    competitionId,
    completedAt,
    dimensions: validation.review.dimensions,
    suggestions: validation.review.suggestions,
  };
}

/** The same-millisecond suffix of a record file name (0 when there is none). */
export function recordFileAttempt(fileName: string): number {
  const match = /Z-(\d+)\.json$/.exec(fileName);
  return match ? Number(match[1]) : 0;
}

/**
 * Oldest first. Records completed in the same millisecond are ordered by their name suffix,
 * which counts up in the order they were written, then by file name.
 */
export function sortRecords<T extends { record: ReviewRecord; fileName: string }>(
  entries: readonly T[]
): T[] {
  return [...entries].sort(
    (a, b) =>
      Date.parse(a.record.completedAt) - Date.parse(b.record.completedAt) ||
      recordFileAttempt(a.fileName) - recordFileAttempt(b.fileName) ||
      (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0)
  );
}
