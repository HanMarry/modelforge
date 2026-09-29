import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfirmOverwriteRequest_unstable } from '@aaif/goose-acp-client';
import { requestAcpOverwriteConfirm } from '../../acp/overwriteConfirm';
import { IntlTestWrapper } from '../../i18n/test-utils';
import type { ResumePlan } from '../../types/taskPlan';
import type { ResumableTask } from '../../types/taskResumeApi';
import TaskResumePrompt, { OPEN_TASK_RESUME_EVENT } from './TaskResumePrompt';

const mocks = vi.hoisted(() => ({
  setView: vi.fn(),
  createSession: vi.fn(),
  resumeTask: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../../hooks/useNavigation', () => ({ useNavigation: () => mocks.setView }));
vi.mock('../ConfigContext', () => ({ useConfig: () => ({ extensionsList: [] }) }));
vi.mock('../../sessions', () => ({ createSession: mocks.createSession }));
vi.mock('../../acp/taskResume', () => ({
  resumeTask: mocks.resumeTask,
  resumeTaskErrorCode: () => null,
}));
vi.mock('../../toasts', () => ({
  toastSuccess: mocks.toastSuccess,
  toastError: mocks.toastError,
}));
vi.mock('../../utils/workingDir', () => ({ getInitialWorkingDir: () => '/projects/q1' }));

const RUN_CLEAN = '20260920T101531000-aaaaaa';
const RUN_FIT = '20260920T101541000-bbbbbb';

function task(overrides: Partial<ResumableTask['plan']> = {}): ResumableTask {
  return {
    projectDir: '/projects/q1',
    plan: {
      schemaVersion: 1,
      taskId: 'task-1',
      title: '问题一求解',
      status: '执行中',
      dismissed: false,
      createdAt: '2026-09-20T10:15:30.123+08:00',
      steps: [
        { id: 'clean', title: '数据清洗', runIds: [RUN_CLEAN] },
        { id: 'fit', title: '模型求解', runIds: [RUN_FIT] },
      ],
      ...overrides,
    },
    steps: [
      {
        id: 'clean',
        title: '数据清洗',
        completed: true,
        runs: [
          {
            runId: RUN_CLEAN,
            recorded: true,
            startedAt: '2026-09-20T10:15:31.000+08:00',
            endedAt: '2026-09-20T10:15:40.000+08:00',
            exitCode: 0,
            failure: null,
          },
        ],
      },
      {
        id: 'fit',
        title: '模型求解',
        completed: false,
        runs: [
          {
            runId: RUN_FIT,
            recorded: true,
            startedAt: '2026-09-20T10:15:41.000+08:00',
            endedAt: '2026-09-20T10:16:02.500+08:00',
            exitCode: 1,
            failure: '非零退出码',
          },
        ],
      },
    ],
    failedStep: 'fit',
  };
}

const resumePlan: ResumePlan = {
  skip: ['clean'],
  resumeFrom: 'fit',
  staleReasons: [{ kind: 'run-failed', runId: RUN_FIT, exitCode: 1, failure: '非零退出码' }],
};

const electron = {
  listRecentDirs: vi.fn(),
  taskResumeList: vi.fn(),
  taskResumeContinue: vi.fn(),
  taskResumeDismiss: vi.fn(),
  taskResumeComplete: vi.fn(),
  artifactsCheckStale: vi.fn(),
};

const windowWithElectron = window as unknown as { electron: unknown };
const originalElectron = windowWithElectron.electron;

function renderPrompt() {
  return render(
    <IntlTestWrapper>
      <TaskResumePrompt />
    </IntlTestWrapper>
  );
}

describe('TaskResumePrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electron.listRecentDirs.mockResolvedValue(['/projects/q1', '/projects/old']);
    electron.taskResumeList.mockResolvedValue({ ok: true, data: [task()] });
    electron.taskResumeContinue.mockResolvedValue({ ok: true, data: resumePlan });
    electron.taskResumeDismiss.mockResolvedValue({ ok: true, data: null });
    electron.taskResumeComplete.mockResolvedValue({
      ok: true,
      data: { skip: ['clean', 'fit'], resumeFrom: null, staleReasons: [] },
    });
    electron.artifactsCheckStale.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_IMPLEMENTED', message: 'artifacts-check-stale is not implemented yet' },
    });
    mocks.createSession.mockResolvedValue({ id: 'session-1' });
    mocks.resumeTask.mockResolvedValue('resumed');
    windowWithElectron.electron = electron;
  });

  afterEach(() => {
    windowWithElectron.electron = originalElectron;
  });

  it('shows the unfinished tasks of the open Projects right after startup', async () => {
    renderPrompt();

    const dialog = await screen.findByRole('dialog');
    expect(electron.taskResumeList).toHaveBeenCalledExactlyOnceWith({
      projectDirs: ['/projects/q1', '/projects/old'],
      includeDismissed: true,
    });
    expect(within(dialog).getByText('问题一求解')).toBeInTheDocument();
    expect(within(dialog).getByText('数据清洗')).toBeInTheDocument();
    expect(within(dialog).getByText('Completed')).toBeInTheDocument();
    expect(within(dialog).getByText('Failure point')).toBeInTheDocument();
    expect(within(dialog).getByText(RUN_CLEAN)).toBeInTheDocument();
    expect(within(dialog).getByText(RUN_FIT)).toBeInTheDocument();
    expect(within(dialog).getByText(/exit code 1/)).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: 'Continue from the failure point' })
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Do not resume' })).toBeInTheDocument();
  });

  it('does not prompt for dismissed tasks but keeps them reachable', async () => {
    const user = userEvent.setup();
    electron.taskResumeList.mockResolvedValue({ ok: true, data: [task({ dismissed: true })] });
    renderPrompt();

    const entry = await screen.findByRole('button', { name: 'Unfinished tasks: 1' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(entry);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Not prompted again')).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: 'Continue from the failure point' })
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Do not resume' })).toBeNull();
  });

  it('opens the task list when another view asks for it', async () => {
    electron.taskResumeList
      .mockResolvedValueOnce({ ok: true, data: [] })
      .mockResolvedValue({ ok: true, data: [task({ dismissed: true })] });
    renderPrompt();
    await waitFor(() => expect(electron.taskResumeList).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_TASK_RESUME_EVENT));
    });

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('writes dismissed and stops prompting when the user declines', async () => {
    const user = userEvent.setup();
    renderPrompt();
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Do not resume' }));

    expect(electron.taskResumeDismiss).toHaveBeenCalledExactlyOnceWith({
      projectDir: '/projects/q1',
      taskId: 'task-1',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Unfinished tasks: 1' })).toBeInTheDocument();
  });

  it('shows the checked plan and resumes it in a new session of the Project', async () => {
    const user = userEvent.setup();
    renderPrompt();
    const dialog = await screen.findByRole('dialog');

    await user.click(
      within(dialog).getByRole('button', { name: 'Continue from the failure point' })
    );

    expect(
      await within(dialog).findByText('Skipped, still match the files: 数据清洗')
    ).toBeInTheDocument();
    expect(within(dialog).getByText('Runs again from: 模型求解')).toBeInTheDocument();
    expect(
      within(dialog).getByText(`Run ${RUN_FIT} did not end with exit code 0`)
    ).toBeInTheDocument();
    expect(electron.taskResumeContinue).toHaveBeenCalledWith({
      projectDir: '/projects/q1',
      taskId: 'task-1',
    });
    expect(electron.artifactsCheckStale).toHaveBeenCalledWith('/projects/q1');

    await user.click(within(dialog).getByRole('button', { name: 'Start' }));

    await waitFor(() =>
      expect(mocks.resumeTask).toHaveBeenCalledExactlyOnceWith('session-1', 'task-1', resumePlan)
    );
    expect(mocks.createSession).toHaveBeenCalledWith('/projects/q1', { allExtensions: [] });
    expect(mocks.setView).toHaveBeenCalledWith('pair', {
      disableAnimation: true,
      resumeSessionId: 'session-1',
    });
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith({
        title: 'Continuing “问题一求解” from “模型求解”',
      })
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Unfinished tasks/ })).not.toBeInTheDocument();
  });

  it('marks the task completed without a session when nothing is left to run', async () => {
    const user = userEvent.setup();
    electron.taskResumeContinue.mockResolvedValue({
      ok: true,
      data: { skip: ['clean', 'fit'], resumeFrom: null, staleReasons: [] },
    });
    renderPrompt();
    const dialog = await screen.findByRole('dialog');

    await user.click(
      within(dialog).getByRole('button', { name: 'Continue from the failure point' })
    );
    await user.click(await within(dialog).findByRole('button', { name: 'Mark as completed' }));

    await waitFor(() =>
      expect(electron.taskResumeComplete).toHaveBeenCalledExactlyOnceWith({
        projectDir: '/projects/q1',
        taskId: 'task-1',
      })
    );
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.resumeTask).not.toHaveBeenCalled();
    expect(electron.artifactsCheckStale).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('asks before the Kernel overwrites outputs and cancels unless confirmed', async () => {
    const user = userEvent.setup();
    renderPrompt();
    await screen.findByRole('dialog');
    const request: ConfirmOverwriteRequest_unstable = {
      sessionId: 'session-1',
      taskId: 'task-1',
      stepId: 'fit',
      workingDir: '/projects/q1',
      files: [{ path: 'results/out.csv', size: 2048, modifiedAt: '2026-09-20T10:15:30.123+08:00' }],
    };

    let answer!: Promise<unknown>;
    act(() => {
      answer = requestAcpOverwriteConfirm(request);
    });
    const question = await screen.findByRole('alertdialog');
    expect(within(question).getByText('results/out.csv')).toBeInTheDocument();
    expect(within(question).getByText(/modified/)).toBeInTheDocument();
    expect(within(question).getByText(/“模型求解”/)).toBeInTheDocument();

    await user.click(within(question).getByRole('button', { name: 'Cancel and stay paused' }));
    await expect(answer).resolves.toEqual({ action: 'cancel' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    act(() => {
      answer = requestAcpOverwriteConfirm(request);
    });
    await user.click(await screen.findByRole('button', { name: 'Overwrite and continue' }));
    await expect(answer).resolves.toEqual({ action: 'confirm' });
  });

  it('keeps every file when it is unmounted with a question open', async () => {
    const view = renderPrompt();
    await screen.findByRole('dialog');
    let answer!: Promise<unknown>;
    act(() => {
      answer = requestAcpOverwriteConfirm({
        sessionId: 'session-1',
        taskId: 'task-1',
        stepId: 'fit',
        workingDir: '/projects/q1',
        files: [],
      });
    });
    await screen.findByRole('alertdialog');

    view.unmount();

    await expect(answer).resolves.toEqual({ action: 'cancel' });
  });
});
