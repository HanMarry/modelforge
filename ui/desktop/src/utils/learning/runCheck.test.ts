import { describe, expect, it, vi } from 'vitest';
import type { LearningExercise, LearningReviewMaterials } from '../../types/learningApi';
import { ReviewTimeoutError } from './kernelReview';
import type { CheckOutcome } from './progress';
import {
  CHECK_TIMEOUT,
  DEADLINE_MARGIN_MS,
  LEARNING_CHECK_TIME_LIMIT_MS,
  RECORD_RESERVE_MS,
  REVIEW_FAILED,
  runLearningCheck,
  type LearningCheckDeps,
} from './runCheck';

vi.mock('../../acp/chatSessionStore', () => ({
  acpChatSessionActions: { deleteSnapshot: vi.fn() },
  acpChatSessionStore: { getSnapshot: vi.fn() },
}));
vi.mock('../../acp/prompt', () => ({ acpCancelPrompt: vi.fn(), acpPromptSession: vi.fn() }));
vi.mock('../../acp/sessions', () => ({ acpDeleteSession: vi.fn(), acpNewSession: vi.fn() }));

const deterministic: LearningExercise = {
  id: 'numbers',
  title: '数值',
  prompt: '',
  checks: [
    {
      id: 'answer',
      kind: 'number-in-range',
      description: '',
      path: 'a.json',
      field: 'v',
      min: 0,
      max: 1,
    },
  ],
};

const withSubjective: LearningExercise = {
  ...deterministic,
  id: 'notes',
  checks: [
    ...deterministic.checks,
    { id: 'quality', kind: 'subjective', description: '写清楚', files: ['notes.md'] },
  ],
};

const materials: LearningReviewMaterials = {
  exerciseId: 'notes',
  checks: [{ id: 'quality', kind: 'subjective', description: '写清楚', files: ['notes.md'] }],
  files: [{ path: 'notes.md', content: '说明', truncated: false }],
};

const outcome: CheckOutcome = {
  record: { exerciseId: 'notes', status: '已完成', solutionViewed: false, lastSubmission: 's' },
  failures: [],
};

function deps() {
  const api = {
    learningCheckMaterials: vi.fn(async () => ({ ok: true as const, data: materials })),
    learningCheckSubmit: vi.fn(async () => ({ ok: true as const, data: outcome })),
  };
  const review = vi.fn(async () => [{ checkId: 'quality', passed: true, reason: '清楚' }]);
  return { api, review, now: () => 1_000 } satisfies LearningCheckDeps;
}

describe('runLearningCheck', () => {
  it('runs deterministic-only exercises without the Kernel', async () => {
    const d = deps();

    const run = await runLearningCheck(
      { exercise: deterministic, projectDir: '/p', submission: 's' },
      d
    );

    expect(run).toEqual({ ok: true, outcome });
    expect(d.api.learningCheckMaterials).not.toHaveBeenCalled();
    expect(d.review).not.toHaveBeenCalled();
    expect(d.api.learningCheckSubmit).toHaveBeenCalledWith({
      exerciseId: 'numbers',
      projectDir: '/p',
      submission: 's',
      subjectiveResults: [],
      deadline: 1_000 + LEARNING_CHECK_TIME_LIMIT_MS - DEADLINE_MARGIN_MS,
    });
  });

  it('hands the subjective items to the Kernel and passes on its verdicts', async () => {
    const d = deps();

    await runLearningCheck({ exercise: withSubjective, projectDir: '/p', submission: 's' }, d);

    expect(d.api.learningCheckMaterials).toHaveBeenCalledWith({
      exerciseId: 'notes',
      projectDir: '/p',
    });
    expect(d.review).toHaveBeenCalledWith(
      { exerciseTitle: '数值', projectDir: '/p', submission: 's', materials },
      LEARNING_CHECK_TIME_LIMIT_MS - DEADLINE_MARGIN_MS - RECORD_RESERVE_MS
    );
    expect(d.api.learningCheckSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectiveResults: [{ checkId: 'quality', passed: true, reason: '清楚' }],
      })
    );
  });

  it('reports errors without recording anything', async () => {
    const input = { exercise: withSubjective, projectDir: '/p', submission: 's' };
    const error = { code: 'INVALID_PROJECT', message: 'no folder' };

    const materialsFailed = deps();
    materialsFailed.api.learningCheckMaterials.mockResolvedValueOnce({ ok: false, error } as never);
    expect(await runLearningCheck(input, materialsFailed)).toEqual({ ok: false, error });
    expect(materialsFailed.api.learningCheckSubmit).not.toHaveBeenCalled();

    const reviewFailed = {
      ...deps(),
      review: vi.fn(async () => Promise.reject(new Error('bad reply'))),
    };
    expect(await runLearningCheck(input, reviewFailed)).toEqual({
      ok: false,
      error: { code: REVIEW_FAILED, message: 'bad reply' },
    });
    expect(reviewFailed.api.learningCheckSubmit).not.toHaveBeenCalled();

    const reviewTimedOut = {
      ...deps(),
      review: vi.fn(async () => Promise.reject(new ReviewTimeoutError())),
    };
    expect(await runLearningCheck(input, reviewTimedOut)).toMatchObject({
      ok: false,
      error: { code: CHECK_TIMEOUT },
    });

    const submitFailed = deps();
    submitFailed.api.learningCheckSubmit.mockResolvedValueOnce({ ok: false, error } as never);
    expect(await runLearningCheck(input, submitFailed)).toEqual({ ok: false, error });
  });

  it('gives up when the whole check takes longer than the limit', async () => {
    const hanging = deps();
    hanging.api.learningCheckSubmit.mockReturnValueOnce(new Promise(() => undefined) as never);

    const run = await runLearningCheck(
      { exercise: deterministic, projectDir: '/p', submission: 's' },
      { ...hanging, timeLimitMs: 20 }
    );

    expect(run).toMatchObject({ ok: false, error: { code: CHECK_TIMEOUT } });
  });

  it('does not ask the Kernel when no time is left for it', async () => {
    let time = 0;
    const late = {
      ...deps(),
      now: () => time,
      api: {
        learningCheckMaterials: vi.fn(async () => {
          time = LEARNING_CHECK_TIME_LIMIT_MS;
          return { ok: true as const, data: materials };
        }),
        learningCheckSubmit: vi.fn(),
      },
    };

    const run = await runLearningCheck(
      { exercise: withSubjective, projectDir: '/p', submission: 's' },
      late
    );

    expect(run).toMatchObject({ ok: false, error: { code: CHECK_TIMEOUT } });
    expect(late.review).not.toHaveBeenCalled();
    expect(late.api.learningCheckSubmit).not.toHaveBeenCalled();
  });
});
