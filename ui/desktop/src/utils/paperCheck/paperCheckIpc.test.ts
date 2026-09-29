import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paperCheckBridge } from '../../bridges/paperCheckBridge';
import { registerPaperCheckIpc } from './paperCheckIpc';

const renderer = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: renderer }));

const deps = { sensitiveValues: () => [], userDataDir: '/user-data', broadcast: vi.fn() };

describe('paper check IPC skeleton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers paper-check-run', async () => {
    const handle = vi.fn();
    registerPaperCheckIpc({ handle }, deps);

    expect(handle.mock.calls.map(([channel]) => channel)).toEqual(['paper-check-run']);
    expect(await handle.mock.calls[0][1]({}, {})).toMatchObject({
      ok: false,
      error: { code: 'NOT_IMPLEMENTED' },
    });
  });

  it('bridges paperCheckRun to paper-check-run', () => {
    const request = { projectDir: '/project', paperPath: 'paper/main.tex', online: false };
    paperCheckBridge.paperCheckRun(request);
    expect(renderer.invoke).toHaveBeenCalledWith('paper-check-run', request);
  });
});
