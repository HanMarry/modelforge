/**
 * Main-process IPC for the learning path (requirement 20, tasks 27.2, 27.5, 27.6). Progress lives
 * in `<deps.userDataDir>/learning-progress.json` (`progressStore.ts`, written atomically). The
 * catalogue is `src/catalog/learning-path.json`, bundled into the main process.
 *
 * A check is one `learning-check-submit`: the deterministic items run here (`checker.ts`), the
 * renderer passes the Kernel's verdicts on the subjective items, and the outcome is recorded only
 * when every step finished before the request's deadline. A check that fails or times out
 * returns an error and leaves the record untouched (20.6).
 */
import type { IpcMain } from 'electron';
import catalogData from '../../catalog/learning-path.json';
import type {
  LearningCatalog,
  LearningExercise,
  LearningMaterialsRequest,
  LearningSubmitRequest,
} from '../../types/learningApi';
import type { FeatureIpcDeps } from '../featureIpc';
import { toIpcError, type IpcResult } from '../ipcResult';
import { ProjectDirError, readReviewMaterials, runDeterministicChecks } from './checker';
import { applyCheckResults, type CheckResult, type ExerciseRecord } from './progress';
import {
  MAX_SUBMISSION_LENGTH,
  createProgressStore,
  normalizeRecords,
  upsertRecord,
} from './progressStore';

/** `scripts/check-skills.js` validates the shape of the bundled catalogue. */
export const LEARNING_CATALOG = catalogData as unknown as LearningCatalog;

/** Upper bound for the deterministic checks when the request carries no deadline. */
export const DETERMINISTIC_CHECK_TIMEOUT_MS = 20_000;
/** Longest reason kept from the Kernel's verdict on one subjective item. */
const MAX_REASON_LENGTH = 2_000;

export const LEARNING_ERROR = {
  invalidRequest: 'INVALID_REQUEST',
  unknownExercise: 'UNKNOWN_EXERCISE',
  invalidProject: 'INVALID_PROJECT',
  checkTimeout: 'CHECK_TIMEOUT',
  checkFailed: 'CHECK_FAILED',
  progressReadFailed: 'PROGRESS_READ_FAILED',
  progressWriteFailed: 'PROGRESS_WRITE_FAILED',
} as const;

export function findExercise(
  catalog: LearningCatalog,
  exerciseId: unknown
): LearningExercise | undefined {
  if (typeof exerciseId !== 'string') return undefined;
  for (const group of catalog.groups) {
    for (const course of group.courses) {
      const exercise = course.exercises.find((entry) => entry.id === exerciseId);
      if (exercise) return exercise;
    }
  }
  return undefined;
}

class LearningIpcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'LearningIpcError';
    this.code = code;
  }
}

const timeoutError = () => new LearningIpcError(LEARNING_ERROR.checkTimeout, 'The check timed out');

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Rejects with `CHECK_TIMEOUT` once `ms` have passed; `ms <= 0` rejects right away. */
function withTimeout<T>(task: () => Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return Promise.reject(timeoutError());
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError()), ms);
    task().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** The Kernel's verdicts, restricted to the exercise's subjective items. */
function subjectiveVerdicts(exercise: LearningExercise, values: unknown): CheckResult[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) {
    throw new LearningIpcError(LEARNING_ERROR.invalidRequest, 'subjectiveResults must be a list');
  }
  const subjective = new Set(
    exercise.checks.filter((check) => check.kind === 'subjective').map((check) => check.id)
  );
  const verdicts: CheckResult[] = [];
  for (const value of values) {
    if (!isObject(value) || typeof value.checkId !== 'string') continue;
    if (!subjective.has(value.checkId) || typeof value.passed !== 'boolean') continue;
    const reason = typeof value.reason === 'string' ? value.reason.slice(0, MAX_REASON_LENGTH) : '';
    verdicts.push({ checkId: value.checkId, passed: value.passed, reason });
  }
  return verdicts;
}

function requireExercise(catalog: LearningCatalog, exerciseId: unknown): LearningExercise {
  const exercise = findExercise(catalog, exerciseId);
  if (!exercise) {
    throw new LearningIpcError(
      LEARNING_ERROR.unknownExercise,
      `Unknown exercise ${JSON.stringify(exerciseId)}`
    );
  }
  return exercise;
}

function requireProjectDir(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LearningIpcError(LEARNING_ERROR.invalidProject, 'projectDir must be a directory');
  }
  return value;
}

export interface LearningIpcOptions {
  catalog?: LearningCatalog;
  now?: () => Date;
  writeFile?: (target: string, data: string) => Promise<void>;
}

export function registerLearningIpc(
  ipc: Pick<IpcMain, 'handle'>,
  deps: FeatureIpcDeps,
  options: LearningIpcOptions = {}
): void {
  const catalog = options.catalog ?? LEARNING_CATALOG;
  const now = options.now ?? (() => new Date());
  const store = createProgressStore(deps.userDataDir, { writeFile: options.writeFile, now });

  const fail = (code: string, cause: unknown): IpcResult<never> => ({
    ok: false,
    error: toIpcError(code, cause, deps.sensitiveValues()),
  });
  const failFrom = (error: unknown, fallback: string): IpcResult<never> => {
    if (error instanceof LearningIpcError) return fail(error.code, error);
    if (error instanceof ProjectDirError) return fail(LEARNING_ERROR.invalidProject, error);
    return fail(fallback, error);
  };

  ipc.handle('learning-catalog', (): IpcResult<LearningCatalog> => ({ ok: true, data: catalog }));

  ipc.handle('learning-progress-get', async (): Promise<IpcResult<ExerciseRecord[]>> => {
    try {
      return { ok: true, data: await store.exclusive(store.read) };
    } catch (error) {
      return failFrom(error, LEARNING_ERROR.progressReadFailed);
    }
  });

  ipc.handle('learning-progress-save', async (_event, records: unknown) => {
    if (!Array.isArray(records)) {
      return fail(LEARNING_ERROR.invalidRequest, 'records must be a list');
    }
    try {
      await store.exclusive(() => store.write(normalizeRecords(records)));
      return { ok: true, data: null };
    } catch (error) {
      return failFrom(error, LEARNING_ERROR.progressWriteFailed);
    }
  });

  ipc.handle('learning-check-materials', async (_event, request: unknown) => {
    try {
      const { exerciseId, projectDir } = (isObject(request) ? request : {}) as Partial<
        Record<keyof LearningMaterialsRequest, unknown>
      >;
      const exercise = requireExercise(catalog, exerciseId);
      const dir = requireProjectDir(projectDir);
      const materials = await withTimeout(
        () => readReviewMaterials(dir, exercise),
        DETERMINISTIC_CHECK_TIMEOUT_MS
      );
      return { ok: true, data: materials };
    } catch (error) {
      return failFrom(error, LEARNING_ERROR.checkFailed);
    }
  });

  ipc.handle('learning-check-submit', async (_event, request: unknown) => {
    try {
      const fields = (isObject(request) ? request : {}) as Partial<
        Record<keyof LearningSubmitRequest, unknown>
      >;
      const exercise = requireExercise(catalog, fields.exerciseId);
      const projectDir = requireProjectDir(fields.projectDir);
      const submission = fields.submission;
      if (typeof submission !== 'string' || submission.length > MAX_SUBMISSION_LENGTH) {
        throw new LearningIpcError(
          LEARNING_ERROR.invalidRequest,
          `submission must be text of at most ${MAX_SUBMISSION_LENGTH} characters`
        );
      }
      let deadline: number | undefined;
      if (fields.deadline !== undefined) {
        if (typeof fields.deadline !== 'number' || !Number.isFinite(fields.deadline)) {
          throw new LearningIpcError(LEARNING_ERROR.invalidRequest, 'deadline must be a number');
        }
        deadline = fields.deadline;
      }
      const verdicts = subjectiveVerdicts(exercise, fields.subjectiveResults);
      const remaining =
        deadline === undefined
          ? DETERMINISTIC_CHECK_TIMEOUT_MS
          : Math.min(DETERMINISTIC_CHECK_TIMEOUT_MS, deadline - now().getTime());
      const deterministic = await withTimeout(
        () => runDeterministicChecks(projectDir, exercise),
        remaining
      );

      const outcome = await store.exclusive(async () => {
        const records = await store.read();
        const previous = records.find((record) => record.exerciseId === exercise.id);
        const checkedAt = now();
        if (deadline !== undefined && checkedAt.getTime() > deadline) throw timeoutError();
        const result = applyCheckResults(
          previous,
          exercise,
          [...deterministic, ...verdicts],
          checkedAt.toISOString(),
          submission
        );
        await store.write(upsertRecord(records, result.record));
        return result;
      });
      return { ok: true, data: outcome };
    } catch (error) {
      return failFrom(error, LEARNING_ERROR.checkFailed);
    }
  });

  ipc.handle('learning-solution-unlock', async (_event, exerciseId: unknown) => {
    try {
      const exercise = requireExercise(catalog, exerciseId);
      const record = await store.exclusive(async () => {
        const records = await store.read();
        const previous = records.find((entry) => entry.exerciseId === exercise.id);
        const unlocked: ExerciseRecord = previous
          ? { ...previous, solutionViewed: true }
          : { exerciseId: exercise.id, status: '未开始', solutionViewed: true };
        await store.write(upsertRecord(records, unlocked));
        return unlocked;
      });
      return { ok: true, data: record };
    } catch (error) {
      return failFrom(error, LEARNING_ERROR.progressWriteFailed);
    }
  });
}
