// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paperCheckBridge } from '../../bridges/paperCheckBridge';
import type { PaperCheckReport } from '../../types/paperCheckApi';
import type { IpcResult } from '../ipcResult';
import {
  OFFLINE_TIMEOUT_MS,
  ONLINE_TIMEOUT_MS,
  PAPER_CHECK_RUN_CHANNEL,
  parsePaperCheckRequest,
  registerPaperCheckIpc,
  type PaperCheckLauncher,
} from './paperCheckIpc';

const renderer = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: renderer, utilityProcess: { fork: vi.fn() } }));

const SECRET = 'sk-test-secret-value-123456';

const REPORT: PaperCheckReport = {
  items: [
    {
      id: 'references',
      verdict: '无法执行',
      issues: [
        {
          code: 'reference-network',
          params: { index: 1, title: `leaked ${SECRET}` },
          message: `[1] leaked ${SECRET} 未核实（网络原因）`,
        },
      ],
      reason: 'check-failed',
      reasonDetail: `request failed with ${SECRET}`,
    },
  ],
  finishedAt: '2026-09-29T00:00:00.000Z',
};

type Handler = (event: unknown, request: unknown) => Promise<IpcResult<PaperCheckReport>>;

function setup(launch: PaperCheckLauncher) {
  const handle = vi.fn();
  registerPaperCheckIpc(
    { handle },
    { sensitiveValues: () => [SECRET], userDataDir: '/user-data', broadcast: vi.fn() },
    launch
  );
  return { handle, handler: handle.mock.calls[0][1] as Handler };
}

let root = '';

beforeEach(() => {
  vi.clearAllMocks();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paper-ipc-')));
  fs.mkdirSync(path.join(root, 'paper'));
  fs.writeFileSync(path.join(root, 'paper', 'main.tex'), '\\documentclass{article}');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('parsePaperCheckRequest', () => {
  it('normalises the paper path and keeps the anonymity terms', () => {
    expect(
      parsePaperCheckRequest({
        projectDir: root,
        paperPath: 'paper\\.\\main.tex',
        online: true,
        anonymity: { names: ['张三'], school: '某某大学', team: '' },
      })
    ).toEqual({
      projectDir: root,
      paperPath: 'paper/main.tex',
      online: true,
      anonymity: { names: ['张三'], school: '某某大学', team: '' },
    });
  });

  it('rejects malformed requests', () => {
    const valid = { projectDir: root, paperPath: 'main.tex', online: false };
    for (const request of [
      null,
      'main.tex',
      {},
      { ...valid, projectDir: 'relative/dir' },
      { ...valid, paperPath: '../outside.tex' },
      { ...valid, paperPath: path.join(root, 'main.tex') },
      { ...valid, paperPath: '' },
      { ...valid, paperPath: 'a\0b.tex' },
      { ...valid, online: 'yes' },
      { ...valid, anonymity: { names: '张三', school: '', team: '' } },
      { ...valid, anonymity: { names: [], school: 'x'.repeat(201), team: '' } },
    ]) {
      expect(parsePaperCheckRequest(request), JSON.stringify(request)).toBeNull();
    }
  });
});

describe('paper-check-run', () => {
  it('registers only paper-check-run', () => {
    const { handle } = setup(vi.fn());
    expect(handle.mock.calls.map(([channel]) => channel)).toEqual([PAPER_CHECK_RUN_CHANNEL]);
  });

  it('runs the check on the real project root with the offline or online time limit', async () => {
    const launch = vi.fn<PaperCheckLauncher>().mockResolvedValue({ ok: true, data: REPORT });
    const { handler } = setup(launch);

    await handler({}, { projectDir: root, paperPath: 'paper/main.tex', online: false });
    expect(launch).toHaveBeenLastCalledWith(
      { root, paperPath: 'paper/main.tex', online: false },
      OFFLINE_TIMEOUT_MS
    );

    const anonymity = { names: ['张三'], school: '', team: '数模队' };
    await handler({}, { projectDir: root, paperPath: 'paper/main.tex', online: true, anonymity });
    expect(launch).toHaveBeenLastCalledWith(
      { root, paperPath: 'paper/main.tex', online: true, anonymity },
      ONLINE_TIMEOUT_MS
    );
  });

  it('passes a paper that does not exist yet so the checks can report it missing', async () => {
    const launch = vi.fn<PaperCheckLauncher>().mockResolvedValue({ ok: true, data: REPORT });
    const { handler } = setup(launch);

    await handler({}, { projectDir: root, paperPath: 'draft/new.tex', online: false });
    expect(launch).toHaveBeenLastCalledWith(
      { root, paperPath: 'draft/new.tex', online: false },
      OFFLINE_TIMEOUT_MS
    );
  });

  it('refuses malformed requests, missing projects and papers outside the project', async () => {
    const launch = vi.fn<PaperCheckLauncher>();
    const { handler } = setup(launch);

    expect(await handler({}, { projectDir: root })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
    expect(
      await handler({}, { projectDir: path.join(root, 'nope'), paperPath: 'a.tex', online: false })
    ).toMatchObject({ ok: false, error: { code: 'PROJECT_NOT_FOUND' } });

    if (process.platform !== 'win32') {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-outside-'));
      try {
        fs.writeFileSync(path.join(outside, 'secret.tex'), 'x');
        fs.symlinkSync(path.join(outside, 'secret.tex'), path.join(root, 'link.tex'));
        expect(
          await handler({}, { projectDir: root, paperPath: 'link.tex', online: false })
        ).toMatchObject({ ok: false, error: { code: 'OUTSIDE_PROJECT' } });
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    }
    expect(launch).not.toHaveBeenCalled();
  });

  it('masks key values in errors and in the report', async () => {
    const failing = vi.fn<PaperCheckLauncher>().mockResolvedValue({
      ok: false,
      error: { code: 'CHECK_FAILED', message: `boom ${SECRET}` },
    });
    const failed = await setup(failing).handler({}, {
      projectDir: root,
      paperPath: 'paper/main.tex',
      online: false,
    });
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).not.toContain(SECRET);
    expect(failed).toMatchObject({ error: { code: 'CHECK_FAILED' } });

    const passing = vi.fn<PaperCheckLauncher>().mockResolvedValue({ ok: true, data: REPORT });
    const passed = await setup(passing).handler({}, {
      projectDir: root,
      paperPath: 'paper/main.tex',
      online: false,
    });
    expect(passed.ok).toBe(true);
    expect(JSON.stringify(passed)).not.toContain(SECRET);
    expect(JSON.stringify(passed)).toContain('********3456');
  });

  it('reports a launcher failure as CHECK_FAILED', async () => {
    const launch = vi.fn<PaperCheckLauncher>().mockRejectedValue(new Error(`spawn ${SECRET}`));
    const result = await setup(launch).handler({}, {
      projectDir: root,
      paperPath: 'paper/main.tex',
      online: false,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'CHECK_FAILED' } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('bridges paperCheckRun to paper-check-run', () => {
    const request = { projectDir: '/project', paperPath: 'paper/main.tex', online: false };
    paperCheckBridge.paperCheckRun(request);
    expect(renderer.invoke).toHaveBeenCalledWith('paper-check-run', request);
  });
});
