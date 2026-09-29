import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runsBridge } from '../../bridges/runsBridge';
import { serializeRunRecord } from '../runRecord';
import type { FeatureIpcDeps } from '../featureIpc';
import {
  CODE_TEXT,
  INPUT_TEXT,
  OUTPUT_TEXT,
  RUN_ID,
  runRecord,
} from '../../test/runRecordFixtures';
import { createArtifactStore, type ArtifactStore } from './artifactStore';
import { broadcastArtifactsChanged, registerRunsIpc, RUNS_IPC_CHANNELS } from './runsIpc';

const renderer = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: renderer }));

const OUT = 'results/out.csv';
const RECORD_PATH = `.modelforge/runs/${RUN_ID}.json`;

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const tempDirs: string[] = [];
let store: ArtifactStore | null = null;

function deps(): FeatureIpcDeps {
  return {
    sensitiveValues: () => ['sk-secret-value'],
    userDataDir: '/user-data',
    broadcast: vi.fn(),
  };
}

function register(featureDeps: FeatureIpcDeps): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  store = createArtifactStore({ watch: null, log: () => undefined });
  registerRunsIpc(
    { handle: (channel: string, listener: Handler) => handlers.set(channel, listener) },
    featureDeps,
    store
  );
  return handlers;
}

async function call(handlers: Map<string, Handler>, channel: string, ...args: unknown[]) {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`${channel} is not registered`);
  }
  return handler({}, ...args);
}

async function project(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'modelforge-ipc-')));
  tempDirs.push(root);
  const files: Record<string, string> = {
    'data/in.csv': INPUT_TEXT,
    'code/q1.py': CODE_TEXT,
    [OUT]: OUTPUT_TEXT,
    [RECORD_PATH]: serializeRunRecord(runRecord()),
    '.modelforge/runs/broken.json': '{ "runId": ',
  };
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  return root;
}

describe('runs IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    store?.close();
    store = null;
    const dirs = tempDirs.splice(0);
    await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('registers the runs and artifacts channels', () => {
    const handlers = register(deps());

    expect([...handlers.keys()]).toEqual([...RUNS_IPC_CHANNELS]);
  });

  it('lists records, keeps the index and verifies through the channels', async () => {
    const root = await project();
    const featureDeps = deps();
    const handlers = register(featureDeps);

    expect(await call(handlers, 'runs-list', root)).toMatchObject({
      ok: true,
      data: {
        records: [{ path: RECORD_PATH, record: { runId: RUN_ID } }],
        problems: [{ path: '.modelforge/runs/broken.json' }],
      },
    });

    const opened = await call(handlers, 'artifacts-get', root);
    expect(opened).toMatchObject({
      ok: true,
      data: { entries: { [OUT]: { status: '已生成', runId: RUN_ID } } },
    });
    expect(featureDeps.broadcast).toHaveBeenCalledWith('artifacts-changed', {
      projectDir: root,
      index: (opened as { data: unknown }).data,
    });

    expect(await call(handlers, 'artifacts-verify', root, OUT)).toMatchObject({
      ok: true,
      data: { ok: true, index: { entries: { [OUT]: { status: '已验证' } } } },
    });
    expect(await call(handlers, 'artifacts-inspect', root, OUT)).toMatchObject({
      ok: true,
      data: { path: OUT, record: { runId: RUN_ID }, entry: { status: '已验证' } },
    });

    await fs.writeFile(path.join(root, 'code', 'q1.py'), 'print(2)\n');
    expect(await call(handlers, 'artifacts-check-stale', root)).toMatchObject({
      ok: true,
      data: {
        entries: {
          [OUT]: { status: '已过期', staleReasons: [{ kind: 'code-changed', path: 'code/q1.py' }] },
        },
      },
    });
    // "标记已验证" on an outdated result comes back refused, with the reason (17.7).
    expect(await call(handlers, 'artifacts-verify', root, OUT)).toMatchObject({
      ok: true,
      data: { ok: false, reason: 'not-generated' },
    });
  });

  it('passes run notifications on to the store', async () => {
    const root = await project();
    const handlers = register(deps());
    const later = '20260920T101531123-d4e5f6';

    expect(
      await call(handlers, 'artifacts-run-started', {
        workingDir: root,
        runId: later,
        declaredOutputs: ['results/next.csv'],
      })
    ).toMatchObject({ ok: true, data: { entries: { 'results/next.csv': { status: '执行中' } } } });
    expect(
      await call(handlers, 'artifacts-run-finished', {
        workingDir: root,
        runId: RUN_ID,
        recordPath: RECORD_PATH,
      })
    ).toMatchObject({ ok: true, data: { entries: { [OUT]: { status: '已生成' } } } });
  });

  it('returns stable error codes with sensitive values masked', async () => {
    const handlers = register(deps());
    const secretDir = path.join(os.tmpdir(), 'sk-secret-value-missing');

    const result = (await call(handlers, 'artifacts-get', secretDir)) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_PROJECT');
    expect(result.error.message).not.toContain('sk-secret-value');

    expect(await call(handlers, 'artifacts-verify', os.tmpdir(), '../x.csv')).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PATH' },
    });
    expect(await call(handlers, 'artifacts-run-finished', { runId: RUN_ID })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_EVENT' },
    });
  });

  it('bridges each method to its channel', () => {
    const started = { workingDir: '/project', runId: RUN_ID, declaredOutputs: [OUT] };
    const finished = { workingDir: '/project', runId: RUN_ID, recordPath: RECORD_PATH };
    runsBridge.runsList('/project');
    runsBridge.artifactsGet('/project');
    runsBridge.artifactsVerify('/project', 'paper/main.pdf');
    runsBridge.artifactsCheckStale('/project');
    runsBridge.artifactsInspect('/project', 'paper/main.pdf');
    runsBridge.artifactsRunStarted(started);
    runsBridge.artifactsRunFinished(finished);

    expect(renderer.invoke.mock.calls).toEqual([
      ['runs-list', '/project'],
      ['artifacts-get', '/project'],
      ['artifacts-verify', '/project', 'paper/main.pdf'],
      ['artifacts-check-stale', '/project'],
      ['artifacts-inspect', '/project', 'paper/main.pdf'],
      ['artifacts-run-started', started],
      ['artifacts-run-finished', finished],
    ]);
    expect(renderer.invoke.mock.calls.map(([channel]) => channel)).toEqual([...RUNS_IPC_CHANNELS]);
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
