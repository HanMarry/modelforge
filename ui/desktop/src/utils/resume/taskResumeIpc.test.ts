import { beforeEach, describe, expect, it, vi } from 'vitest';
import { taskResumeBridge } from '../../bridges/taskResumeBridge';
import { registerTaskResumeIpc } from './taskResumeIpc';

const renderer = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: renderer }));

const deps = { sensitiveValues: () => [], userDataDir: '/user-data', broadcast: vi.fn() };

describe('task resume IPC skeleton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the task-resume-* channels', async () => {
    const handle = vi.fn();
    registerTaskResumeIpc({ handle }, deps);

    expect(handle.mock.calls.map(([channel]) => channel)).toEqual([
      'task-resume-list',
      'task-resume-continue',
      'task-resume-dismiss',
    ]);
    for (const [, listener] of handle.mock.calls) {
      expect(await listener({}, {})).toMatchObject({
        ok: false,
        error: { code: 'NOT_IMPLEMENTED' },
      });
    }
  });

  it('bridges each method to its channel', () => {
    const list = { projectDirs: ['/project'], includeDismissed: false };
    const target = { projectDir: '/project', taskId: 'task-1' };
    taskResumeBridge.taskResumeList(list);
    taskResumeBridge.taskResumeContinue(target);
    taskResumeBridge.taskResumeDismiss(target);

    expect(renderer.invoke.mock.calls).toEqual([
      ['task-resume-list', list],
      ['task-resume-continue', target],
      ['task-resume-dismiss', target],
    ]);
  });
});
