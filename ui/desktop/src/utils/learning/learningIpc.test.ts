// @vitest-environment node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { learningBridge } from '../../bridges/learningBridge';
import type { LearningCatalog } from '../../types/learningApi';
import type { IpcResult } from '../ipcResult';
import { LEARNING_CATALOG, registerLearningIpc, type LearningIpcOptions } from './learningIpc';
import type { CheckOutcome, ExerciseRecord } from './progress';
import { LEARNING_PROGRESS_FILE } from './progressStore';

const renderer = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: renderer }));

const CHANNELS = [
  'learning-catalog',
  'learning-progress-get',
  'learning-progress-save',
  'learning-check-materials',
  'learning-check-submit',
  'learning-solution-unlock',
];

/** A two-exercise catalogue: one deterministic, one with a subjective item. */
const catalog: LearningCatalog = {
  version: 1,
  updatedAt: '2026-10-01',
  groups: [
    {
      id: 'data-processing',
      title: '数据处理',
      courses: [
        {
          id: 'course',
          title: '课程',
          objectives: ['目标'],
          skills: ['data-prep'],
          exercises: [
            {
              id: 'numbers',
              title: '数值',
              prompt: '写出 results/answer.json',
              checks: [
                {
                  id: 'answer',
                  kind: 'number-in-range',
                  description: '答案正确',
                  path: 'results/answer.json',
                  field: 'value',
                  min: 1,
                  max: 2,
                },
              ],
            },
            {
              id: 'notes',
              title: '说明',
              prompt: '写 notes.md',
              checks: [
                { id: 'file', kind: 'file-exists', description: '有文件', path: 'notes.md' },
                { id: 'quality', kind: 'subjective', description: '写清楚', files: ['notes.md'] },
              ],
            },
          ],
        },
      ],
    },
  ],
};

type Listener = (event: unknown, ...args: unknown[]) => unknown;

let userData: string;
let project: string;
let clock: number;

beforeEach(async () => {
  vi.clearAllMocks();
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'learning-ipc-user-'));
  project = await fs.mkdtemp(path.join(os.tmpdir(), 'learning-ipc-project-'));
  clock = Date.parse('2026-10-01T08:00:00.000Z');
});

afterEach(async () => {
  await fs.rm(userData, { recursive: true, force: true });
  await fs.rm(project, { recursive: true, force: true });
});

function register(options: LearningIpcOptions = {}) {
  const handlers = new Map<string, Listener>();
  const handle = vi.fn((channel: string, listener: Listener) => {
    handlers.set(channel, listener);
  });
  const deps = { sensitiveValues: () => ['sk-secret'], userDataDir: userData, broadcast: vi.fn() };
  registerLearningIpc({ handle }, deps, { catalog, now: () => new Date(clock), ...options });
  const call = async <T>(channel: string, ...args: unknown[]) =>
    (await handlers.get(channel)?.({}, ...args)) as IpcResult<T>;
  return { handle, call };
}

async function write(relative: string, content: string): Promise<void> {
  const target = path.join(project, ...relative.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function storedRecords(): Promise<ExerciseRecord[]> {
  const text = await fs.readFile(path.join(userData, LEARNING_PROGRESS_FILE), 'utf8');
  return (JSON.parse(text) as { records: ExerciseRecord[] }).records;
}

describe('learning IPC', () => {
  it('registers the learning-* channels and bridges each method to its channel', () => {
    const { handle } = register();
    expect(handle.mock.calls.map(([channel]) => channel)).toEqual(CHANNELS);

    const submit = { exerciseId: 'numbers', projectDir: '/project', submission: '' };
    const materials = { exerciseId: 'notes', projectDir: '/project' };
    learningBridge.learningCatalog();
    learningBridge.learningProgressGet();
    learningBridge.learningProgressSave([]);
    learningBridge.learningCheckMaterials(materials);
    learningBridge.learningCheckSubmit(submit);
    learningBridge.learningSolutionUnlock('numbers');

    expect(renderer.invoke.mock.calls).toEqual([
      ['learning-catalog'],
      ['learning-progress-get'],
      ['learning-progress-save', []],
      ['learning-check-materials', materials],
      ['learning-check-submit', submit],
      ['learning-solution-unlock', 'numbers'],
    ]);
  });

  it('serves the bundled catalogue by default', async () => {
    const { call } = register({ catalog: undefined });
    const result = await call<LearningCatalog>('learning-catalog');
    expect(result).toEqual({ ok: true, data: LEARNING_CATALOG });
    expect(LEARNING_CATALOG.groups.map((group) => group.title)).toEqual([
      '数据处理',
      '优化模型',
      '预测模型',
      '评价模型',
      '论文写作',
    ]);
  });

  it('records a failed submission, then completion after a resubmission', async () => {
    const { call } = register();
    await write('results/answer.json', '{"value": 5}');

    const first = await call<CheckOutcome>('learning-check-submit', {
      exerciseId: 'numbers',
      projectDir: project,
      submission: '第一次',
    });
    expect(first.ok && first.data.record).toEqual({
      exerciseId: 'numbers',
      status: '未通过',
      solutionViewed: false,
      lastSubmission: '第一次',
    });
    expect(first.ok && first.data.failures).toEqual([
      { checkId: 'answer', reason: 'value = 5，结果不正确' },
    ]);

    await write('results/answer.json', '{"value": 1.5}');
    clock += 60_000;
    const second = await call<CheckOutcome>('learning-check-submit', {
      exerciseId: 'numbers',
      projectDir: project,
      submission: '第二次',
    });
    expect(second.ok && second.data).toEqual({
      record: {
        exerciseId: 'numbers',
        status: '已完成',
        completedAt: '2026-10-01T08:01:00.000Z',
        solutionViewed: false,
        lastSubmission: '第二次',
      },
      failures: [],
    });

    // Progress survives a restart: a fresh registration reads the same file.
    const restarted = register();
    const progress = await restarted.call<ExerciseRecord[]>('learning-progress-get');
    expect(progress).toEqual({ ok: true, data: [second.ok && second.data.record] });
  });

  it('keeps only the verdicts for subjective items', async () => {
    const { call } = register();
    await write('notes.md', '# 说明');

    const result = await call<CheckOutcome>('learning-check-submit', {
      exerciseId: 'notes',
      projectDir: project,
      submission: '',
      subjectiveResults: [
        { checkId: 'file', passed: false, reason: 'forged' },
        { checkId: 'quality', passed: true, reason: '写得清楚' },
        { checkId: 'unknown', passed: false, reason: 'ignored' },
        'junk',
      ],
    });

    expect(result.ok && result.data.record.status).toBe('已完成');
  });

  it('counts a subjective item without a verdict as not passed', async () => {
    const { call } = register();
    await write('notes.md', '# 说明');

    const result = await call<CheckOutcome>('learning-check-submit', {
      exerciseId: 'notes',
      projectDir: project,
      submission: '',
    });

    expect(result.ok && result.data.record.status).toBe('未通过');
    expect(result.ok && result.data.failures.map((failure) => failure.checkId)).toEqual([
      'quality',
    ]);
  });

  it('leaves the record untouched when the check misses its deadline or cannot run', async () => {
    const { call } = register();
    await write('results/answer.json', '{"value": 1}');
    await call('learning-check-submit', {
      exerciseId: 'numbers',
      projectDir: project,
      submission: 'ok',
    });
    const before = await storedRecords();

    await write('results/answer.json', '{"value": 9}');
    const late = await call('learning-check-submit', {
      exerciseId: 'numbers',
      projectDir: project,
      submission: 'late',
      deadline: clock - 1,
    });
    expect(late).toMatchObject({ ok: false, error: { code: 'CHECK_TIMEOUT' } });

    const noProject = await call('learning-check-submit', {
      exerciseId: 'numbers',
      projectDir: path.join(project, 'missing'),
      submission: 'x',
    });
    expect(noProject).toMatchObject({ ok: false, error: { code: 'INVALID_PROJECT' } });

    const unknown = await call('learning-check-submit', {
      exerciseId: 'nope',
      projectDir: project,
      submission: 'x',
    });
    expect(unknown).toMatchObject({ ok: false, error: { code: 'UNKNOWN_EXERCISE' } });

    const badRequest = await call('learning-check-submit', {
      exerciseId: 'numbers',
      projectDir: project,
      submission: 42,
    });
    expect(badRequest).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });

    expect(await storedRecords()).toEqual(before);
  });

  it('does not record anything when the progress file cannot be written', async () => {
    const { call } = register({
      writeFile: async () => {
        throw new Error('disk full near sk-secret');
      },
    });
    await write('results/answer.json', '{"value": 1}');

    const result = await call('learning-check-submit', {
      exerciseId: 'numbers',
      projectDir: project,
      submission: 'ok',
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'CHECK_FAILED' } });
    expect(!result.ok && result.error.message).not.toContain('sk-secret');
    await expect(fs.access(path.join(userData, LEARNING_PROGRESS_FILE))).rejects.toThrow();
  });

  it('returns the files the subjective items are judged on', async () => {
    const { call } = register();
    await write('notes.md', '# 说明');

    const result = await call('learning-check-materials', {
      exerciseId: 'notes',
      projectDir: project,
    });

    expect(result).toEqual({
      ok: true,
      data: {
        exerciseId: 'notes',
        checks: [{ id: 'quality', kind: 'subjective', description: '写清楚', files: ['notes.md'] }],
        files: [{ path: 'notes.md', content: '# 说明', truncated: false }],
      },
    });
    expect(await call('learning-check-materials', { exerciseId: 'notes' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PROJECT' },
    });
  });

  it('marks the solution as viewed and keeps the rest of the record', async () => {
    const { call } = register();

    const fresh = await call<ExerciseRecord>('learning-solution-unlock', 'notes');
    expect(fresh).toEqual({
      ok: true,
      data: { exerciseId: 'notes', status: '未开始', solutionViewed: true },
    });

    await write('results/answer.json', '{"value": 1}');
    await call('learning-check-submit', {
      exerciseId: 'numbers',
      projectDir: project,
      submission: 'done',
    });
    const unlocked = await call<ExerciseRecord>('learning-solution-unlock', 'numbers');
    expect(unlocked.ok && unlocked.data).toMatchObject({
      exerciseId: 'numbers',
      status: '已完成',
      solutionViewed: true,
      lastSubmission: 'done',
    });
    expect(await storedRecords()).toHaveLength(2);

    expect(await call('learning-solution-unlock', 'nope')).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_EXERCISE' },
    });
  });

  it('saves a list of records and rejects anything else', async () => {
    const { call } = register();
    const record: ExerciseRecord = { exerciseId: 'numbers', status: '未通过', solutionViewed: false };

    expect(await call('learning-progress-save', [record, { junk: true }])).toEqual({
      ok: true,
      data: null,
    });
    expect(await storedRecords()).toEqual([record]);
    expect(await call('learning-progress-save', 'nope')).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
  });
});
