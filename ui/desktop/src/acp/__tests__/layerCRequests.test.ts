import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResumePlan } from '../../types/taskPlan';
import { setLearningMode } from '../learningMode';
import { resumeTask } from '../taskResume';

const goose = vi.hoisted(() => ({
  tasksResume_unstable: vi.fn(),
  sessionLearningModeSet_unstable: vi.fn(),
}));

vi.mock('../acpConnection', () => ({
  getAcpClient: vi.fn().mockResolvedValue({ goose }),
}));

describe('ModelForge layer C requests to the Kernel', () => {
  beforeEach(() => {
    goose.tasksResume_unstable.mockReset().mockResolvedValue({ outcome: 'resumed' });
    goose.sessionLearningModeSet_unstable.mockReset().mockResolvedValue(undefined);
  });

  it('sends the resume plan as is and returns the outcome', async () => {
    const plan: ResumePlan = {
      skip: ['clean', 'fit'],
      resumeFrom: 'plot',
      staleReasons: [{ kind: 'record-missing', runId: null }],
    };

    await expect(resumeTask('session-1', 'task-1', plan)).resolves.toBe('resumed');

    expect(goose.tasksResume_unstable).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'session-1',
      taskId: 'task-1',
      skip: ['clean', 'fit'],
      resumeFrom: 'plot',
      staleReasons: [{ kind: 'record-missing', runId: null }],
    });
  });

  it('passes a finished plan with a null resumeFrom', async () => {
    goose.tasksResume_unstable.mockResolvedValue({ outcome: 'completed' });
    const plan: ResumePlan = { skip: ['clean'], resumeFrom: null, staleReasons: [] };

    await expect(resumeTask('session-1', 'task-1', plan)).resolves.toBe('completed');

    expect(goose.tasksResume_unstable).toHaveBeenCalledWith(
      expect.objectContaining({ resumeFrom: null, staleReasons: [] })
    );
  });

  it('lets a Kernel error through', async () => {
    const error = new Error('_goose/unstable/tasks/resume is not implemented yet');
    goose.tasksResume_unstable.mockRejectedValue(error);
    const plan: ResumePlan = { skip: [], resumeFrom: 'clean', staleReasons: [] };

    await expect(resumeTask('session-1', 'task-1', plan)).rejects.toBe(error);
  });

  it('sets and clears the learning mode of a session', async () => {
    await setLearningMode('session-1', { exerciseId: 'regression-basics', solutionUnlocked: true });
    await setLearningMode('session-1', null);

    expect(goose.sessionLearningModeSet_unstable.mock.calls).toEqual([
      [
        {
          sessionId: 'session-1',
          learningMode: { exerciseId: 'regression-basics', solutionUnlocked: true },
        },
      ],
      [{ sessionId: 'session-1', learningMode: null }],
    ]);
  });
});
