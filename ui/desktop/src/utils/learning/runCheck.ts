/**
 * One learning-path check from the renderer (task 27.2, requirements 20.2 and 20.6): read the
 * files for the subjective items, ask the Kernel for their verdicts, then let the main process
 * run the deterministic items and record the outcome. The whole run gets
 * {@link LEARNING_CHECK_TIME_LIMIT_MS}; the main process refuses to record anything after the
 * deadline it is given, so a check that times out never changes the exercise's record.
 */
import type { LearningApi, LearningExercise } from '../../types/learningApi';
import type { IpcError } from '../ipcResult';
import type { CheckOutcome, CheckResult } from './progress';
import { ReviewTimeoutError, reviewSubjectiveChecks, type ReviewRequest } from './kernelReview';

/** Requirement 20.2: verdicts within 60 seconds of the submission. */
export const LEARNING_CHECK_TIME_LIMIT_MS = 60_000;
/** Kept back from the Kernel review for the main process to check and record. */
export const RECORD_RESERVE_MS = 10_000;
/** The main process's deadline is this much earlier, so its answer arrives before ours. */
export const DEADLINE_MARGIN_MS = 2_000;

export const CHECK_TIMEOUT = 'CHECK_TIMEOUT';
export const REVIEW_FAILED = 'REVIEW_FAILED';

export type LearningCheckRun = { ok: true; outcome: CheckOutcome } | { ok: false; error: IpcError };

export interface LearningCheckInput {
  exercise: LearningExercise;
  projectDir: string;
  submission: string;
}

export interface LearningCheckDeps {
  api: Pick<LearningApi, 'learningCheckMaterials' | 'learningCheckSubmit'>;
  review?: (request: ReviewRequest, timeoutMs: number) => Promise<CheckResult[]>;
  now?: () => number;
  timeLimitMs?: number;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message || error.name : String(error);

export async function runLearningCheck(
  input: LearningCheckInput,
  deps: LearningCheckDeps
): Promise<LearningCheckRun> {
  const now = deps.now ?? Date.now;
  const review = deps.review ?? reviewSubjectiveChecks;
  const limit = deps.timeLimitMs ?? LEARNING_CHECK_TIME_LIMIT_MS;
  const started = now();
  const deadline = started + limit - DEADLINE_MARGIN_MS;
  const { exercise, projectDir, submission } = input;
  const timedOut: LearningCheckRun = {
    ok: false,
    error: { code: CHECK_TIMEOUT, message: 'The check did not finish in time' },
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<LearningCheckRun>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), limit);
  });

  const run = async (): Promise<LearningCheckRun> => {
    let subjectiveResults: CheckResult[] = [];
    if (exercise.checks.some((check) => check.kind === 'subjective')) {
      const materials = await deps.api.learningCheckMaterials({
        exerciseId: exercise.id,
        projectDir,
      });
      if (!materials.ok) return { ok: false, error: materials.error };
      const budget = deadline - RECORD_RESERVE_MS - now();
      if (budget <= 0) return timedOut;
      subjectiveResults = await review(
        {
          exerciseTitle: exercise.title,
          projectDir,
          submission,
          materials: materials.data,
        },
        budget
      );
    }
    const submitted = await deps.api.learningCheckSubmit({
      exerciseId: exercise.id,
      projectDir,
      submission,
      subjectiveResults,
      deadline,
    });
    return submitted.ok ? { ok: true, outcome: submitted.data } : submitted;
  };

  const attempt = run().catch((error: unknown): LearningCheckRun => {
    if (error instanceof ReviewTimeoutError) return timedOut;
    return { ok: false, error: { code: REVIEW_FAILED, message: messageOf(error) } };
  });
  try {
    return await Promise.race([attempt, expired]);
  } finally {
    clearTimeout(timer);
  }
}
