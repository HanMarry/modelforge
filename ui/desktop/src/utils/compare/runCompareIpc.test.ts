import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCompareBridge } from '../../bridges/runCompareBridge';
import type { RunRecord } from '../../types/runRecord';
import { registerRunCompareIpc, RUN_COMPARE_ERROR } from './runCompareIpc';

const renderer = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: renderer }));

const SECRET = 'sk-live-0123456789abcdef';
const deps = { sensitiveValues: () => [SECRET], userDataDir: '/user-data', broadcast: vi.fn() };

const RUN_A = '20260920T101530123-aaaaaa';
const RUN_B = '20260921T090000000-bbbbbb';
const RUN_C = '20260919T080000000-cccccc';
const HASH_1 = '1'.repeat(64);
const HASH_2 = '2'.repeat(64);

function record(runId: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: 1,
    runId,
    inputs: [{ path: 'data/data.csv', sha256: HASH_1 }],
    inputsTruncated: false,
    code: { path: 'code/model.py', sha256: HASH_1 },
    config: { provider: 'openai', model: 'gpt', runtime: 'python 3.12' },
    command: 'python code/model.py',
    dependencies: [],
    seed: '42',
    exitCode: 0,
    failure: null,
    startedAt: '2026-09-20T10:15:30.123+08:00',
    endedAt: '2026-09-20T10:16:35.623+08:00',
    outputs: [{ path: 'results/a.csv', sha256: HASH_2 }],
    outputsTruncated: false,
    ...overrides,
  };
}

let project: string;

function runsDir(): string {
  return path.join(project, '.modelforge', 'runs');
}

function writeFile(relative: string, text: string): void {
  const file = path.join(project, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function writeRun(run: RunRecord, meta?: unknown): void {
  writeFile(`.modelforge/runs/${run.runId}.json`, JSON.stringify(run, null, 2));
  if (meta !== undefined) {
    const text = typeof meta === 'string' ? meta : JSON.stringify(meta);
    writeFile(`.modelforge/runs/${run.runId}.meta.json`, text);
  }
}

function register() {
  const handle = vi.fn();
  registerRunCompareIpc({ handle }, deps);
  const call = (channel: string, arg: unknown) => {
    const entry = handle.mock.calls.find(([name]) => name === channel);
    if (!entry) {
      throw new Error(`${channel} is not registered`);
    }
    return entry[1]({}, arg);
  };
  return {
    handle,
    compare: (request: unknown) => call('runs-compare', request),
    list: (projectDir: unknown) => call('runs-compare-list', projectDir),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'modelforge-run-compare-'));
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

describe('run compare IPC registration', () => {
  it('registers runs-compare and runs-compare-list', () => {
    const { handle } = register();
    expect(handle.mock.calls.map(([channel]) => channel)).toEqual([
      'runs-compare',
      'runs-compare-list',
    ]);
  });

  it('bridges both methods to their channels', () => {
    const request = { projectDir: '/project', runIdA: RUN_A, runIdB: RUN_B };
    runCompareBridge.runsCompare(request);
    runCompareBridge.runsCompareList('/project');
    expect(renderer.invoke).toHaveBeenCalledWith('runs-compare', request);
    expect(renderer.invoke).toHaveBeenCalledWith('runs-compare-list', '/project');
  });
});

describe('runs-compare', () => {
  it('compares two runs with metadata, input mismatch, markers and verification', async () => {
    writeRun(record(RUN_A), {
      method: 'genetic algorithm',
      params: { population: 200 },
      metrics: { rmse: 0.1 },
    });
    writeRun(
      record(RUN_B, {
        exitCode: 1,
        failure: '非零退出码',
        inputs: [
          { path: 'data/data.csv', sha256: HASH_2 },
          { path: 'data/extra.csv', sha256: HASH_1 },
        ],
      }),
      { method: 'simulated annealing', params: { population: 100, temperature: 5 } }
    );
    writeFile(
      '.modelforge/artifacts.json',
      JSON.stringify({
        schemaVersion: 1,
        entries: {
          'results/a.csv': {
            path: 'results/a.csv',
            status: '已过期',
            runId: RUN_A,
            failure: null,
            verification: { verifiedAt: '2026-09-20T10:20:05+08:00', runId: RUN_A },
            staleReasons: [{ kind: 'input-changed', path: 'data/data.csv' }],
          },
          broken: { status: 'not a status' },
        },
      })
    );

    const result = await register().compare({ projectDir: project, runIdA: RUN_A, runIdB: RUN_B });

    expect(result.ok).toBe(true);
    const data = result.data;
    expect(data.inputMismatch).toEqual(['data/data.csv', 'data/extra.csv']);
    expect(data.artifactIndex).toBe('present');
    expect(data.rows).toEqual([
      {
        kind: 'param',
        name: 'population',
        a: { present: true, text: '200' },
        b: { present: true, text: '100' },
        highlight: true,
      },
      {
        kind: 'param',
        name: 'temperature',
        a: { present: false, text: '—' },
        b: { present: true, text: '5' },
        highlight: false,
      },
      {
        kind: 'metric',
        name: 'rmse',
        a: { present: true, text: '0.1' },
        b: { present: false, text: '—' },
        highlight: false,
      },
    ]);
    expect(data.a).toMatchObject({
      flags: ['stale'],
      failure: null,
      verifiedAt: '2026-09-20T10:20:05+08:00',
      metaProblem: null,
    });
    expect(data.a.meta.method).toBe('genetic algorithm');
    expect(data.a.record.runId).toBe(RUN_A);
    expect(data.b).toMatchObject({ flags: ['failed'], failure: '非零退出码', verifiedAt: null });
  });

  it('flags a failed Artifact even when the record exited with 0', async () => {
    writeRun(record(RUN_A));
    writeRun(record(RUN_B));
    writeFile(
      '.modelforge/artifacts.json',
      JSON.stringify({
        schemaVersion: 1,
        entries: {
          'results/b.csv': { status: '执行失败', runId: RUN_B, failure: '超时' },
        },
      })
    );

    const result = await register().compare({ projectDir: project, runIdA: RUN_A, runIdB: RUN_B });

    expect(result.data.a.flags).toEqual([]);
    expect(result.data.b).toMatchObject({ flags: ['failed'], failure: '超时' });
  });

  it('works without metadata or artifact index and reports an unusable .meta.json', async () => {
    writeRun(record(RUN_A), '{ "method": 1 ');
    writeRun(record(RUN_B));

    const result = await register().compare({ projectDir: project, runIdA: RUN_A, runIdB: RUN_B });

    expect(result.ok).toBe(true);
    expect(result.data.rows).toEqual([]);
    expect(result.data.inputMismatch).toEqual([]);
    expect(result.data.artifactIndex).toBe('missing');
    expect(result.data.a.meta).toBeNull();
    expect(result.data.a.metaProblem).toMatchObject({
      path: `.modelforge/runs/${RUN_A}.meta.json`,
    });
    expect(result.data.a.metaProblem.parseErrorAt).toBeDefined();
    expect(result.data.b.metaProblem).toBeNull();
  });

  it('reports an invalid artifact index without failing the comparison', async () => {
    writeRun(record(RUN_A));
    writeRun(record(RUN_B));
    writeFile('.modelforge/artifacts.json', '{ not json');

    const result = await register().compare({ projectDir: project, runIdA: RUN_A, runIdB: RUN_B });

    expect(result.ok).toBe(true);
    expect(result.data.artifactIndex).toBe('invalid');
  });

  it('rejects requests that do not name two different, well-formed runs', async () => {
    const { compare } = register();
    writeRun(record(RUN_A));

    const same = await compare({ projectDir: project, runIdA: RUN_A, runIdB: RUN_A });
    expect(same).toMatchObject({ ok: false, error: { code: RUN_COMPARE_ERROR.sameRun } });

    const traversal = await compare({ projectDir: project, runIdA: RUN_A, runIdB: '../../x' });
    expect(traversal).toMatchObject({
      ok: false,
      error: { code: RUN_COMPARE_ERROR.invalidRequest },
    });

    const shapeless = await compare({ projectDir: project });
    expect(shapeless).toMatchObject({
      ok: false,
      error: { code: RUN_COMPARE_ERROR.invalidRequest },
    });

    const relative = await compare({ projectDir: 'project', runIdA: RUN_A, runIdB: RUN_B });
    expect(relative).toMatchObject({
      ok: false,
      error: { code: RUN_COMPARE_ERROR.invalidRequest },
    });
  });

  it('reports a missing or invalid record by its path', async () => {
    const { compare } = register();
    writeRun(record(RUN_A));

    const missing = await compare({ projectDir: project, runIdA: RUN_A, runIdB: RUN_B });
    expect(missing).toMatchObject({ ok: false, error: { code: RUN_COMPARE_ERROR.runNotFound } });

    writeFile(`.modelforge/runs/${RUN_B}.json`, JSON.stringify({ schemaVersion: 1 }));
    const invalid = await compare({ projectDir: project, runIdA: RUN_A, runIdB: RUN_B });
    expect(invalid).toMatchObject({ ok: false, error: { code: RUN_COMPARE_ERROR.runInvalid } });
    expect(invalid.error.message).toContain(`.modelforge/runs/${RUN_B}.json`);
    expect(invalid.error.message).toContain('missing');
  });

  it('masks key values in error messages', async () => {
    const projectDir = path.join(project, `missing-${SECRET}`);

    const result = await register().compare({ projectDir, runIdA: RUN_A, runIdB: RUN_B });

    expect(result).toMatchObject({
      ok: false,
      error: { code: RUN_COMPARE_ERROR.projectUnavailable },
    });
    expect(result.error.message).not.toContain(SECRET);
  });

  it('refuses a runs directory that resolves outside the Project', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'modelforge-run-compare-outside-'));
    try {
      fs.writeFileSync(path.join(outside, `${RUN_A}.json`), JSON.stringify(record(RUN_A)));
      fs.writeFileSync(path.join(outside, `${RUN_B}.json`), JSON.stringify(record(RUN_B)));
      fs.mkdirSync(path.join(project, '.modelforge'));
      // A junction needs no extra privileges on Windows; other platforms ignore the type.
      fs.symlinkSync(outside, runsDir(), 'junction');

      const { compare, list } = register();
      const compared = await compare({ projectDir: project, runIdA: RUN_A, runIdB: RUN_B });
      const listed = await list(project);

      expect(compared).toMatchObject({
        ok: false,
        error: { code: RUN_COMPARE_ERROR.outsideProject },
      });
      expect(listed).toMatchObject({
        ok: false,
        error: { code: RUN_COMPARE_ERROR.outsideProject },
      });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('runs-compare-list', () => {
  it('lists records newest first, skips .meta.json and reports bad files', async () => {
    writeRun(record(RUN_A), { method: 'genetic algorithm' });
    writeRun(record(RUN_B, { exitCode: null, failure: '超时' }), '{ broken');
    writeRun(record(RUN_C));
    writeFile('.modelforge/runs/notes.json', JSON.stringify(record(RUN_C)));
    writeFile('.modelforge/runs/20260101T000000000-zzzzzz.json', '{ "schemaVersion": 1 }');
    writeFile('.modelforge/runs/.run-123.tmp', 'partial');

    const result = await register().list(project);

    expect(result.ok).toBe(true);
    expect(result.data.runs.map((run: { runId: string }) => run.runId)).toEqual([
      RUN_B,
      RUN_A,
      RUN_C,
    ]);
    expect(result.data.runs[0]).toEqual({
      runId: RUN_B,
      command: 'python code/model.py',
      startedAt: '2026-09-20T10:15:30.123+08:00',
      endedAt: '2026-09-20T10:16:35.623+08:00',
      exitCode: null,
      failure: '超时',
      method: null,
    });
    expect(result.data.runs[1].method).toBe('genetic algorithm');
    expect(result.data.problems.map((problem: { path: string }) => problem.path).sort()).toEqual([
      '.modelforge/runs/20260101T000000000-zzzzzz.json',
      '.modelforge/runs/notes.json',
    ]);
  });

  it('returns an empty list for a Project without runs', async () => {
    const result = await register().list(project);
    expect(result).toEqual({ ok: true, data: { runs: [], problems: [] } });
  });

  it('rejects a Project path that is not a directory', async () => {
    writeFile('file.txt', 'x');
    const result = await register().list(path.join(project, 'file.txt'));
    expect(result).toMatchObject({
      ok: false,
      error: { code: RUN_COMPARE_ERROR.projectUnavailable },
    });
  });
});
