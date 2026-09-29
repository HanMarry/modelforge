import { beforeEach, describe, expect, it, vi } from 'vitest';
import { learningBridge } from '../../bridges/learningBridge';
import { registerLearningIpc } from './learningIpc';

const renderer = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: renderer }));

const deps = { sensitiveValues: () => [], userDataDir: '/user-data', broadcast: vi.fn() };

describe('learning IPC skeleton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the learning-* channels', async () => {
    const handle = vi.fn();
    registerLearningIpc({ handle }, deps);

    expect(handle.mock.calls.map(([channel]) => channel)).toEqual([
      'learning-catalog',
      'learning-progress-get',
      'learning-progress-save',
      'learning-check-submit',
      'learning-solution-unlock',
    ]);
    for (const [, listener] of handle.mock.calls) {
      expect(await listener({})).toMatchObject({
        ok: false,
        error: { code: 'NOT_IMPLEMENTED' },
      });
    }
  });

  it('bridges each method to its channel', () => {
    const submit = { exerciseId: 'clean-temperature-log', projectDir: '/project', submission: '' };
    learningBridge.learningCatalog();
    learningBridge.learningProgressGet();
    learningBridge.learningProgressSave([]);
    learningBridge.learningCheckSubmit(submit);
    learningBridge.learningSolutionUnlock('clean-temperature-log');

    expect(renderer.invoke.mock.calls).toEqual([
      ['learning-catalog'],
      ['learning-progress-get'],
      ['learning-progress-save', []],
      ['learning-check-submit', submit],
      ['learning-solution-unlock', 'clean-temperature-log'],
    ]);
  });
});
