import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCompareBridge } from '../../bridges/runCompareBridge';
import { registerRunCompareIpc } from './runCompareIpc';

const renderer = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: renderer }));

const deps = { sensitiveValues: () => [], userDataDir: '/user-data', broadcast: vi.fn() };

describe('run compare IPC skeleton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers runs-compare', async () => {
    const handle = vi.fn();
    registerRunCompareIpc({ handle }, deps);

    expect(handle.mock.calls.map(([channel]) => channel)).toEqual(['runs-compare']);
    expect(await handle.mock.calls[0][1]({}, {})).toMatchObject({
      ok: false,
      error: { code: 'NOT_IMPLEMENTED' },
    });
  });

  it('bridges runsCompare to runs-compare', () => {
    const request = { projectDir: '/project', runIdA: 'a', runIdB: 'b' };
    runCompareBridge.runsCompare(request);
    expect(renderer.invoke).toHaveBeenCalledWith('runs-compare', request);
  });
});
