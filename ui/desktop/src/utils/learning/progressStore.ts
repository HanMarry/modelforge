/**
 * `userData/learning-progress.json` (task 27.6, requirement 20.4): the learner's exercise records,
 * kept across restarts. Written with `writeFileAtomic`, so a crash leaves either the old or the
 * new file. The file is `{ "version": 1, "records": ExerciseRecord[] }`; malformed records are
 * dropped on read, and a file that is not valid JSON is moved aside (never overwritten) so that
 * the learner can still recover it.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../atomicWrite';
import type { ExerciseRecord, ExerciseStatus } from './progress';

export const LEARNING_PROGRESS_FILE = 'learning-progress.json';
export const LEARNING_PROGRESS_VERSION = 1;

const STATUSES: readonly ExerciseStatus[] = ['未开始', '未通过', '已完成'];
/** Longest submission kept in a record, in UTF-16 code units. */
export const MAX_SUBMISSION_LENGTH = 100_000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `value` as an ExerciseRecord with only the known fields, or null when it is malformed. */
export function toExerciseRecord(value: unknown): ExerciseRecord | null {
  if (!isObject(value)) return null;
  const { exerciseId, status, completedAt, solutionViewed, lastSubmission } = value;
  if (typeof exerciseId !== 'string' || exerciseId === '') return null;
  if (!STATUSES.includes(status as ExerciseStatus)) return null;
  if (typeof solutionViewed !== 'boolean') return null;
  if (completedAt !== undefined && typeof completedAt !== 'string') return null;
  if (lastSubmission !== undefined && typeof lastSubmission !== 'string') return null;
  if (typeof lastSubmission === 'string' && lastSubmission.length > MAX_SUBMISSION_LENGTH) {
    return null;
  }
  const record: ExerciseRecord = {
    exerciseId,
    status: status as ExerciseStatus,
    solutionViewed,
  };
  if (typeof completedAt === 'string' && status === '已完成') record.completedAt = completedAt;
  if (typeof lastSubmission === 'string') record.lastSubmission = lastSubmission;
  return record;
}

/** Well-formed records of `values`, one per exercise (the last one wins, in first-seen order). */
export function normalizeRecords(values: readonly unknown[]): ExerciseRecord[] {
  const byId = new Map<string, ExerciseRecord>();
  for (const value of values) {
    const record = toExerciseRecord(value);
    if (record) byId.set(record.exerciseId, record);
  }
  return [...byId.values()];
}

/** `records` with `record` replacing the entry of the same exercise, or appended. */
export function upsertRecord(
  records: readonly ExerciseRecord[],
  record: ExerciseRecord
): ExerciseRecord[] {
  const index = records.findIndex((entry) => entry.exerciseId === record.exerciseId);
  if (index === -1) return [...records, record];
  return records.map((entry, position) => (position === index ? record : entry));
}

export interface ProgressStore {
  read: () => Promise<ExerciseRecord[]>;
  write: (records: readonly ExerciseRecord[]) => Promise<void>;
  /** Runs `task` after every earlier task, so read-modify-write updates never interleave. */
  exclusive: <T>(task: () => Promise<T>) => Promise<T>;
}

export interface ProgressStoreOptions {
  writeFile?: (target: string, data: string) => Promise<void>;
  now?: () => Date;
}

export function createProgressStore(
  userDataDir: string,
  options: ProgressStoreOptions = {}
): ProgressStore {
  const file = path.join(userDataDir, LEARNING_PROGRESS_FILE);
  const writeFile = options.writeFile ?? ((target, data) => writeFileAtomic(target, data));
  const now = options.now ?? (() => new Date());
  let queue: Promise<unknown> = Promise.resolve();

  const read = async (): Promise<ExerciseRecord[]> => {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return [];
      throw error;
    }
    let data: unknown;
    try {
      data = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      const stamp = now().toISOString().replace(/[:.]/g, '-');
      const aside = path.join(userDataDir, `learning-progress.corrupt-${stamp}.json`);
      await fs.rename(file, aside);
      console.warn(`[learning] ${file} is not valid JSON; moved it to ${aside}`);
      return [];
    }
    const records = isObject(data) && Array.isArray(data.records) ? data.records : [];
    return normalizeRecords(records);
  };

  const write = async (records: readonly ExerciseRecord[]): Promise<void> => {
    await fs.mkdir(userDataDir, { recursive: true });
    const body = { version: LEARNING_PROGRESS_VERSION, records };
    await writeFile(file, `${JSON.stringify(body, null, 2)}\n`);
  };

  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  return { read, write, exclusive };
}
