/**
 * Main-process storage of mock review records (requirement 19.5, 19.6, task 26.4).
 *
 * Every path is checked against the real project root (`fs.realpath` and a prefix comparison, as
 * `datasetIpc.ts` does for previews), so symlinks and `..` cannot reach files outside the
 * project. A record is written only after `validateReview` accepts the output, through
 * `writeFileAtomic`, under a new file name: an incomplete or rejected review leaves the
 * directory untouched, and earlier records are never rewritten.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { COMPETITION_CATALOG } from '../../catalog/competitionRules';
import type { ReviewErrorCode, ReviewPaperFormat, ReviewPaperInfo } from '../../types/reviewApi';
import { writeFileAtomic } from '../atomicWrite';
import { validateReview, type ReviewProblem, type ReviewRecord } from './reviewModel';
import {
  buildReviewRecord,
  MAX_RECORD_BYTES,
  normalizePaperPath,
  parseStoredRecord,
  reviewPaperFormat,
  reviewRecordFileName,
  sortRecords,
} from './reviewRecord';

/** A failure with a stable code; the message is English detail for logs and the panel. */
export class ReviewStoreError extends Error {
  readonly code: ReviewErrorCode;

  constructor(code: ReviewErrorCode, message: string) {
    super(message);
    this.name = 'ReviewStoreError';
    this.code = code;
  }
}

export interface ReviewStoreOptions {
  /** Completion time of a saved review; injectable for tests. */
  now?: () => Date;
  /** Replaces `writeFileAtomic`, for fault-injection tests. */
  writeFile?: (target: string, data: string) => Promise<void>;
}

/** Directory of all review records, relative to the project root. */
export const REVIEWS_DIR = ['.modelforge', 'reviews'] as const;

/** Upper bound on same-millisecond name suffixes before giving up. */
const MAX_NAME_ATTEMPTS = 1000;

/** First 16 hex digits of the SHA-256 of the canonical project-relative path. */
export function paperPathHash(paperPath: string): string {
  return createHash('sha256').update(paperPath, 'utf8').digest('hex').slice(0, 16);
}

function fail(code: ReviewErrorCode, message: string): never {
  throw new ReviewStoreError(code, message);
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'error';
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isInside(root: string, target: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(prefix);
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join('/');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function resolveProjectRoot(projectDir: unknown): Promise<string> {
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) {
    fail('INVALID_REQUEST', 'The project directory must be an absolute path');
  }
  try {
    const root = await fs.realpath(projectDir);
    if ((await fs.stat(root)).isDirectory()) return root;
  } catch {
    // Reported below.
  }
  return fail('PROJECT_NOT_FOUND', `Project directory not found: ${projectDir}`);
}

interface ResolvedPaper {
  root: string;
  /** Canonical project-relative path when the file exists, the lexical form otherwise. */
  paperPath: string;
  format: ReviewPaperFormat;
  /** Real absolute path, or null when the file does not exist. */
  absolute: string | null;
}

function formatOf(paperPath: string): ReviewPaperFormat {
  return (
    reviewPaperFormat(paperPath) ??
    fail('UNSUPPORTED_FORMAT', `Only .tex, .md and .pdf papers can be reviewed: ${paperPath}`)
  );
}

async function resolvePaper(ref: unknown): Promise<ResolvedPaper> {
  if (!isObject(ref)) fail('INVALID_REQUEST', 'Expected { projectDir, paperPath }');
  const root = await resolveProjectRoot(ref.projectDir);
  const raw = ref.paperPath;
  if (typeof raw !== 'string') fail('INVALID_REQUEST', 'The paper path must be a string');
  const lexical =
    normalizePaperPath(raw) ??
    fail('OUTSIDE_PROJECT', `The paper path must be relative and inside the project: ${raw}`);
  const format = formatOf(lexical);

  let absolute: string;
  try {
    absolute = await fs.realpath(path.join(root, ...lexical.split('/')));
  } catch (error) {
    if (isMissing(error)) return { root, paperPath: lexical, format, absolute: null };
    return fail('PAPER_UNREADABLE', `Cannot resolve the paper (${errorCode(error)}): ${lexical}`);
  }
  if (absolute === root || !isInside(root, absolute)) {
    fail('OUTSIDE_PROJECT', `The paper file resolves outside the project: ${lexical}`);
  }
  const paperPath = toPosix(path.relative(root, absolute));
  return { root, paperPath, format: formatOf(paperPath), absolute };
}

async function openPaper(paper: ResolvedPaper): Promise<FileHandle> {
  const missing = `The paper file does not exist: ${paper.paperPath}`;
  if (paper.absolute === null) fail('PAPER_NOT_FOUND', missing);
  try {
    return await fs.open(paper.absolute, 'r');
  } catch (error) {
    if (isMissing(error)) fail('PAPER_NOT_FOUND', missing);
    return fail(
      'PAPER_UNREADABLE',
      `The paper file cannot be opened (${errorCode(error)}): ${paper.paperPath}`
    );
  }
}

/**
 * Opens the paper read-only and reads its first byte (requirement 19.5): tells a missing file
 * from one that exists but cannot be read. Nothing is written. Resolves to the file size.
 */
async function assertReadable(paper: ResolvedPaper): Promise<number> {
  const handle = await openPaper(paper);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      fail('PAPER_UNREADABLE', `The paper path is not a regular file: ${paper.paperPath}`);
    }
    if (stat.size === 0) fail('PAPER_EMPTY', `The paper file is empty: ${paper.paperPath}`);
    await handle.read(Buffer.alloc(1), 0, 1, 0);
    return stat.size;
  } catch (error) {
    if (error instanceof ReviewStoreError) throw error;
    return fail(
      'PAPER_UNREADABLE',
      `The paper file cannot be read (${errorCode(error)}): ${paper.paperPath}`
    );
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Checks, before a review starts, that the paper exists in the project and can be read. */
export async function checkPaper(ref: unknown): Promise<ReviewPaperInfo> {
  const paper = await resolvePaper(ref);
  const size = await assertReadable(paper);
  return { paperPath: paper.paperPath, format: paper.format, size };
}

/**
 * The real path of the paper's record directory, or null when it does not exist yet. With
 * `create`, missing levels are made one at a time and each existing level is resolved first,
 * so a `.modelforge` symlink pointing out of the project is refused before anything is created.
 */
async function recordsDir(
  root: string,
  paperPath: string,
  create: boolean
): Promise<string | null> {
  const ioCode: ReviewErrorCode = create ? 'WRITE_FAILED' : 'READ_FAILED';
  let current = root;
  for (const segment of [...REVIEWS_DIR, paperPathHash(paperPath)]) {
    const next = path.join(current, segment);
    const shown = toPosix(path.relative(root, next));
    let real: string | null = null;
    try {
      real = await fs.realpath(next);
    } catch (error) {
      if (!isMissing(error)) fail(ioCode, `Cannot access ${shown} (${errorCode(error)})`);
    }
    if (real === null) {
      if (!create) return null;
      try {
        await fs.mkdir(next);
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') {
          fail('WRITE_FAILED', `Cannot create ${shown} (${errorCode(error)})`);
        }
      }
      real = await fs.realpath(next);
    }
    if (!isInside(root, real)) fail('OUTSIDE_PROJECT', `${shown} resolves outside the project`);
    let isDirectory = false;
    try {
      isDirectory = (await fs.stat(real)).isDirectory();
    } catch (error) {
      fail(ioCode, `Cannot access ${shown} (${errorCode(error)})`);
    }
    if (!isDirectory) fail(ioCode, `${shown} is not a directory`);
    current = real;
  }
  return current;
}

interface StoredEntry {
  record: ReviewRecord;
  fileName: string;
}

async function readRecords(dir: string, paperPath: string): Promise<StoredEntry[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    return fail('READ_FAILED', `Cannot list earlier reviews (${errorCode(error)})`);
  }
  const entries: StoredEntry[] = [];
  for (const fileName of names) {
    // Temporary files of an interrupted atomic write start with a dot.
    if (fileName.startsWith('.') || !fileName.endsWith('.json')) continue;
    const file = path.join(dir, fileName);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) continue;
      const record = parseStoredRecord(JSON.parse(await fs.readFile(file, 'utf8')), paperPath);
      if (record !== null) entries.push({ record, fileName });
    } catch {
      // A damaged record is skipped; it is never rewritten.
    }
  }
  return entries;
}

/** Completed reviews of the paper, oldest first (requirement 19.3, 19.4). */
export async function listReviews(ref: unknown): Promise<ReviewRecord[]> {
  const paper = await resolvePaper(ref);
  const dir = await recordsDir(paper.root, paper.paperPath, false);
  if (dir === null) return [];
  return sortRecords(await readRecords(dir, paper.paperPath)).map((entry) => entry.record);
}

function describeProblems(problems: readonly ReviewProblem[]): string {
  const shown = problems.slice(0, 5).map((problem) => {
    if ('name' in problem) return `${problem.kind} (${problem.name})`;
    if ('index' in problem) return `${problem.kind} (#${problem.index})`;
    return problem.kind;
  });
  const rest = problems.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

/** One save at a time per paper, so two saves cannot pick the same file name. */
const saveQueues = new Map<string, Promise<void>>();

function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = saveQueues.get(key) ?? Promise.resolve();
  const run = previous.then(task);
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  saveQueues.set(key, settled);
  void settled.then(() => {
    if (saveQueues.get(key) === settled) saveQueues.delete(key);
  });
  return run;
}

async function unusedRecordPath(dir: string, completedAt: Date): Promise<string> {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = path.join(dir, reviewRecordFileName(completedAt, attempt));
    try {
      await fs.lstat(candidate);
    } catch (error) {
      if (isMissing(error)) return candidate;
      fail('WRITE_FAILED', `Cannot check the record name (${errorCode(error)})`);
    }
  }
  return fail('WRITE_FAILED', 'No free record name for this time');
}

/**
 * Stores a completed review (requirement 19.6). The competition and the output are checked
 * first; when either fails, or the paper is missing or unreadable, nothing is created or
 * changed on disk.
 */
export async function saveReview(
  request: unknown,
  options: ReviewStoreOptions = {}
): Promise<ReviewRecord> {
  if (!isObject(request)) {
    fail('INVALID_REQUEST', 'Expected { projectDir, paperPath, competitionId, output }');
  }
  const { competitionId, output } = request;
  if (
    typeof competitionId !== 'string' ||
    !COMPETITION_CATALOG.competitions.some((entry) => entry.id === competitionId)
  ) {
    fail('UNKNOWN_COMPETITION', `Unknown competition: ${String(competitionId)}`);
  }
  const validation = validateReview(output);
  if (!validation.valid) {
    fail('REVIEW_INCOMPLETE', `Not a complete review: ${describeProblems(validation.problems)}`);
  }
  const competition: string = competitionId;
  const review = validation.review;
  const paper = await resolvePaper(request);
  await assertReadable(paper);

  const now = options.now ?? (() => new Date());
  const writeFile = options.writeFile ?? writeFileAtomic;
  return serialized(`${paper.root}\0${paper.paperPath}`, async () => {
    const dir =
      (await recordsDir(paper.root, paper.paperPath, true)) ??
      fail('WRITE_FAILED', 'Cannot create the record folder');
    const completedAt = now();
    if (Number.isNaN(completedAt.getTime())) fail('WRITE_FAILED', 'Invalid completion time');
    const record = buildReviewRecord(paper.paperPath, competition, completedAt, review);
    const target = await unusedRecordPath(dir, completedAt);
    try {
      await writeFile(target, `${JSON.stringify(record, null, 2)}\n`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      fail('WRITE_FAILED', `Cannot write the review record: ${detail}`);
    }
    return record;
  });
}
