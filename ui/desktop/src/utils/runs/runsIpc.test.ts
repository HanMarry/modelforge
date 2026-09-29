import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runsBridge } from '../../bridges/runsBridge';
import type { FeatureIpcDeps } from '../featureIpc';
import { broadcastArtifactsChanged, registerRunsIpc } from './runsIpc';

const renderer = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: renderer }));

const CHANNELS = ['runs-list', 'artifacts-get', 'artifacts-verify', 'artifacts-check-stale'];

function deps(): FeatureIpcDeps {
  return { sensitiveValues: () => [], userDataDir: '/user-data', broadcast: vi.fn() };
}

describe('runs IPC skeleton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the runs and artifacts channels', async () => {
    const handle = vi.fn();
    registerRunsIpc({ handle }, deps());

    expect(handle.mock.calls.map(([channel]) => channel)).toEqual(CHANNELS);
    for (const [channel, listener] of handle.mock.calls) {
      expect(await listener({}, '/project')).toMatchObject({
        ok: false,
        error: { code: 'NOT_IMPLEMENTED', message: `${channel} is not implemented yet` },
      });
    }
  });

  it('bridges each method to its channel', () => {
    runsBridge.runsList('/project');
    runsBridge.artifactsGet('/project');
    runsBridge.artifactsVerify('/project', 'paper/main.pdf');
    runsBridge.artifactsCheckStale('/project');

    expect(renderer.invoke.mock.calls).toEqual([
      ['runs-list', '/project'],
      ['artifacts-get', '/project'],
      ['artifacts-verify', '/project', 'paper/main.pdf'],
      ['artifacts-check-stale', '/project'],
    ]);
  });

  it('pushes artifact changes through artifacts-changed', () => {
    const featureDeps = deps();
    const event = { projectDir: '/project', index: { schemaVersion: 1 as const, entries: {} } };
    broadcastArtifactsChanged(featureDeps, event);
    expect(featureDeps.broadcast).toHaveBeenCalledWith('artifacts-changed', event);

    const callback = vi.fn();
    const unsubscribe = runsBridge.onArtifactsChanged(callback);
    const [channel, listener] = renderer.on.mock.calls[0];
    expect(channel).toBe('artifacts-changed');
    listener({}, event);
    expect(callback).toHaveBeenCalledWith(event);
    unsubscribe();
    expect(renderer.removeListener).toHaveBeenCalledWith('artifacts-changed', listener);
  });
});
