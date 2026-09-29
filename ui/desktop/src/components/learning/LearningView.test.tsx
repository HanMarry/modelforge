import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import learningPath from '../../catalog/learning-path.json';
import { IntlTestWrapper } from '../../i18n/test-utils';
import type { LearningCatalog } from '../../types/learningApi';
import type { CheckOutcome, ExerciseRecord } from '../../utils/learning/progress';
import LearningView from './LearningView';

const mocks = vi.hoisted(() => ({
  review: vi.fn(),
  startLearningChat: vi.fn(),
  unlockLearningChats: vi.fn(),
  leaveLearningMode: vi.fn(),
  setView: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../../utils/learning/kernelReview', () => ({
  reviewSubjectiveChecks: mocks.review,
  ReviewTimeoutError: class ReviewTimeoutError extends Error {},
}));
vi.mock('../../utils/learning/learningChat', () => ({
  startLearningChat: mocks.startLearningChat,
  unlockLearningChats: mocks.unlockLearningChats,
  leaveLearningMode: mocks.leaveLearningMode,
}));
vi.mock('../../sessions', () => ({ createSession: vi.fn() }));
vi.mock('../../hooks/useNavigation', () => ({ useNavigation: () => mocks.setView }));
vi.mock('../ConfigContext', () => ({ useConfig: () => ({ extensionsList: [] }) }));
vi.mock('../../toasts', () => ({ toastError: mocks.toastError }));
vi.mock('../../utils/workingDir', () => ({ getInitialWorkingDir: () => '/project' }));

const catalog = learningPath as unknown as LearningCatalog;
const EXERCISE = 'clean-temperature-log';
const EXERCISE_TITLE = '清洗一张日气温记录表';

const originalElectron = window.electron;
const learningCatalog = vi.fn();
const learningProgressGet = vi.fn();
const learningCheckMaterials = vi.fn();
const learningCheckSubmit = vi.fn();
const learningSolutionUnlock = vi.fn();

function failedOutcome(submission: string): CheckOutcome {
  return {
    record: {
      exerciseId: EXERCISE,
      status: '未通过',
      solutionViewed: false,
      lastSubmission: submission,
    },
    failures: [{ checkId: 'missing-count', reason: 'missing = 2，结果不正确' }],
  };
}

function completedOutcome(submission: string): CheckOutcome {
  return {
    record: {
      exerciseId: EXERCISE,
      status: '已完成',
      completedAt: '2026-10-01T08:30:00.000Z',
      solutionViewed: false,
      lastSubmission: submission,
    },
    failures: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  learningCatalog.mockResolvedValue({ ok: true, data: catalog });
  learningProgressGet.mockResolvedValue({ ok: true, data: [] });
  learningCheckMaterials.mockResolvedValue({
    ok: true,
    data: { exerciseId: EXERCISE, checks: [], files: [] },
  });
  mocks.review.mockResolvedValue([{ checkId: 'cleaning-notes', passed: true, reason: '清楚' }]);
  mocks.startLearningChat.mockResolvedValue({ session: { id: 'chat-1' }, message: '练习题面' });
  mocks.unlockLearningChats.mockResolvedValue(undefined);
  mocks.leaveLearningMode.mockResolvedValue(undefined);
  window.electron = {
    ...originalElectron,
    learningCatalog,
    learningProgressGet,
    learningCheckMaterials,
    learningCheckSubmit,
    learningSolutionUnlock,
  } as typeof window.electron;
});

afterEach(() => {
  window.electron = originalElectron;
});

function renderView() {
  return render(
    <IntlTestWrapper>
      <LearningView />
    </IntlTestWrapper>
  );
}

async function openExercise() {
  renderView();
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(EXERCISE_TITLE) }));
  return screen.getByLabelText('Your submission') as HTMLTextAreaElement;
}

describe('LearningView', () => {
  it('lists the five course groups with their courses, objectives, skills and exercises', async () => {
    renderView();

    for (const title of ['数据处理', '优化模型', '预测模型', '评价模型', '论文写作']) {
      expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
    }
    expect(screen.getByRole('heading', { name: '数据体检与清洗' })).toBeInTheDocument();
    expect(screen.getAllByText('Learning objectives').length).toBe(11);
    expect(screen.getAllByText('outlier-and-anomaly-detection').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: new RegExp(EXERCISE_TITLE) })).toHaveTextContent(
      'Not started'
    );
  });

  it('shows why a submission failed, keeps it, and records completion after a resubmission', async () => {
    learningCheckSubmit
      .mockResolvedValueOnce({ ok: true, data: failedOutcome('第一次') })
      .mockResolvedValueOnce({ ok: true, data: completedOutcome('第二次') });
    const submission = await openExercise();

    fireEvent.change(submission, { target: { value: '第一次' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit for checking' }));

    expect(await screen.findByText('Not passed: missing = 2，结果不正确')).toBeInTheDocument();
    expect(screen.getByTestId('learning-check-missing-count')).toHaveTextContent('Not passed');
    expect(screen.getByTestId('learning-check-clean-file')).toHaveTextContent('Passed');
    expect(screen.getByTestId('learning-check-cleaning-notes')).toHaveTextContent('Passed');
    expect(submission.value).toBe('第一次');
    expect(learningCheckSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        exerciseId: EXERCISE,
        projectDir: '/project',
        submission: '第一次',
        subjectiveResults: [{ checkId: 'cleaning-notes', passed: true, reason: '清楚' }],
      })
    );

    fireEvent.change(submission, { target: { value: '第二次' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit for checking' }));

    expect(await screen.findByText(/^Completed at /)).toBeInTheDocument();
    expect(screen.getByTestId('learning-check-missing-count')).toHaveTextContent('Passed');
    expect(learningCheckSubmit).toHaveBeenCalledTimes(2);

    // The profile page reflects the completion right away.
    fireEvent.click(screen.getByRole('tab', { name: 'My progress' }));
    expect(screen.getByRole('progressbar', { name: '数据处理' })).toHaveAttribute(
      'aria-valuenow',
      '50'
    );
  });

  it('keeps the status and the submission when the check times out, and offers to check again', async () => {
    learningProgressGet.mockResolvedValue({
      ok: true,
      data: [
        { exerciseId: EXERCISE, status: '未通过', solutionViewed: false, lastSubmission: '上次' },
      ],
    });
    learningCheckSubmit.mockResolvedValue({
      ok: false,
      error: { code: 'CHECK_TIMEOUT', message: 'The check timed out' },
    });
    const submission = await openExercise();
    expect(submission.value).toBe('上次');

    fireEvent.click(screen.getByRole('button', { name: 'Submit for checking' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('did not finish within 60 seconds');
    expect(screen.getByRole('heading', { name: EXERCISE_TITLE }).parentElement).toHaveTextContent(
      'Not passed'
    );
    expect(submission.value).toBe('上次');

    fireEvent.click(within(alert).getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(learningCheckSubmit).toHaveBeenCalledTimes(2));
  });

  it('shows completed / total and the rounded percentage of each group', async () => {
    const records: ExerciseRecord[] = [
      { exerciseId: EXERCISE, status: '已完成', solutionViewed: false },
      { exerciseId: 'lp-production-plan', status: '已完成', solutionViewed: true },
      { exerciseId: 'lp-profit-range', status: '未通过', solutionViewed: false },
    ];
    learningProgressGet.mockResolvedValue({ ok: true, data: records });
    renderView();
    await screen.findByRole('heading', { name: '数据处理' });

    fireEvent.click(screen.getByRole('tab', { name: 'My progress' }));

    const expected: Array<[string, string, string]> = [
      ['数据处理', '1 / 2', '50'],
      ['优化模型', '1 / 3', '33'],
      ['预测模型', '0 / 2', '0'],
      ['评价模型', '0 / 2', '0'],
      ['论文写作', '0 / 3', '0'],
    ];
    for (const [group, count, percent] of expected) {
      const bar = screen.getByRole('progressbar', { name: group });
      expect(bar).toHaveAttribute('aria-valuenow', percent);
      const row = bar.closest('li') as HTMLElement;
      expect(row).toHaveTextContent(count);
      expect(row).toHaveTextContent(`${percent}%`);
    }
  });

  it('asks for a second confirmation before unlocking the full solution', async () => {
    learningSolutionUnlock.mockResolvedValue({
      ok: true,
      data: { exerciseId: EXERCISE, status: '未开始', solutionViewed: true },
    });
    await openExercise();

    fireEvent.click(screen.getByRole('button', { name: 'View full solution' }));
    expect(await screen.findByText('View the full solution?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('View the full solution?')).toBeNull());
    expect(learningSolutionUnlock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'View full solution' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View solution' }));

    await waitFor(() => expect(mocks.setView).toHaveBeenCalled());
    expect(learningSolutionUnlock).toHaveBeenCalledWith(EXERCISE);
    expect(mocks.unlockLearningChats).toHaveBeenCalledWith(EXERCISE);
    expect(mocks.startLearningChat).toHaveBeenCalledWith(
      expect.objectContaining({ id: EXERCISE }),
      '/project',
      true,
      expect.anything()
    );
    expect(screen.getByText('Solution viewed')).toBeInTheDocument();
  });

  it('opens a learning-mode chat and leaves learning mode when the exercise is closed', async () => {
    await openExercise();

    fireEvent.click(screen.getByRole('button', { name: 'Practise in chat' }));

    await waitFor(() =>
      expect(mocks.setView).toHaveBeenCalledWith(
        'pair',
        expect.objectContaining({ resumeSessionId: 'chat-1' })
      )
    );
    expect(mocks.startLearningChat).toHaveBeenCalledWith(
      expect.objectContaining({ id: EXERCISE }),
      '/project',
      false,
      expect.anything()
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close exercise' }));
    expect(mocks.leaveLearningMode).toHaveBeenCalledWith(EXERCISE);
    expect(await screen.findByRole('heading', { name: '数据处理' })).toBeInTheDocument();
  });

  it('offers to retry when the learning path cannot be loaded', async () => {
    learningCatalog.mockResolvedValueOnce({
      ok: false,
      error: { code: 'X', message: 'broken' },
    });
    renderView();

    expect(await screen.findByRole('alert')).toHaveTextContent('broken');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: '数据处理' })).toBeInTheDocument();
  });
});
