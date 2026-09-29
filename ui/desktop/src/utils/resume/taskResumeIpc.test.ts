import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { taskResumeBridge } from '../../bridges/taskResumeBridge';
import type { RunRecord } from '../../types/runRecord';
import type { ResumePlan, TaskPlan } from '../../types/taskPlan';
import type { ResumableTask } from '../../types/taskResumeApi';
import type { IpcResult } from '../ipcResult';
import { parseTaskPlan, serializeTaskPlan } from '../resumePlanner';
import { serializeRunRecord } from '../runRecord';
import { registerTaskResumeIpc, TASK_RESUME_CHANNELS } from './taskResumeIpc';

const renderer = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: renderer }));

const SECRET = 's3cr3t-value';
const deps = { sensitiveValues: () => [SECRET], userDataDir: '/user-data', broadcast: vi.fn() };

const TASK_ID = '20260920T101530123-a1b2c3';
const RUN_CLEAN = '20260920T101531000-aaaaaa';
const RUN_FIT = '20260920T101541000-bbbbbb';

type Listener = (event: unknown, ...args: unknown[]) => Promise<IpcResult<unknown>>;

function listeners(): Map<string, Listener> {
  const handle = vi.fn();
  registerTaskResumeIpc({ handle }, deps);
  return new Map(
    handle.mock.calls.map(([channel, listener]) => [channel as string, listener as Listener])
  );
}

async function call<T>(channel: string, argument: unknown): Promise<IpcResult<T>> {
  const listener = listeners().get(channel);
  if (!listener) {
    throw new Error(`${channel} is not registered`);
  }
  return (await listener({}, argument)) as IpcResult<T>;
}

async function data<T>(channel: string, argument: unknown): Promise<T> {
  const result = await call<T>(channel, argument);
  if (!result.ok) {
    throw new Error(`${channel} failed: ${result.error.code} ${result.error.message}`);
  }
  return result.data;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function record(runId: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: 1,
    runId,
    inputs: [],
    inputsTruncated: false,
    code: { path: 'code/q1.py', sha256: sha256('') },
    config: { provider: 'p', model: 'm', runtime: 'python 3.12' },
    command: 'python code/q1.py',
    dependencies: [],
    seed: '未设置',
    exitCode: 0,
    failure: null,
    startedAt: '2026-09-20T10:15:31.000+08:00',
    endedAt: '2026-09-20T10:15:40.000+08:00',
    outputs: [],
    outputsTruncated: false,
    ...overrides,
  };
}

function plan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
    title: '问题一求解',
    status: '执行中',
    dismissed: false,
    createdAt: '2026-09-20T10:15:30.123+08:00',
    steps: [
      { id: 'clean', title: '数据清洗', runIds: [RUN_CLEAN] },
      { id: 'fit', title: '模型求解', runIds: [RUN_FIT] },
    ],
    ...overrides,
  };
}

const roots: string[] = [];

async function write(root: string, relative: string, text: string): Promise<void> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

async function readPlanFile(root: string, taskId = TASK_ID): Promise<string> {
  return fs.readFile(path.join(root, '.modelforge', 'tasks', `${taskId}.json`), 'utf8');
}

/**
 * A Project whose task ran `clean` successfully (input, code and output recorded) and `fit` with
 * the given exit code.
 */
async function project(fitExitCode = 1): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-resume-'));
  roots.push(root);
  await write(root, 'data/in.csv', 'x,y\n1,2\n');
  await write(root, 'code/clean.py', 'print(1)');
  await write(root, 'results/clean.csv', 'cleaned');
  await write(root, 'code/fit.py', 'print(2)');
  const clean = record(RUN_CLEAN, {
    inputs: [{ path: 'data/in.csv', sha256: sha256('x,y\n1,2\n') }],
    code: { path: 'code/clean.py', sha256: sha256('print(1)') },
    outputs: [{ path: 'results/clean.csv', sha256: sha256('cleaned') }],
  });
  const fit = record(RUN_FIT, {
    inputs: [{ path: 'results/clean.csv', sha256: sha256('cleaned') }],
    code: { path: 'code/fit.py', sha256: sha256('print(2)') },
    exitCode: fitExitCode,
    failure: fitExitCode === 0 ? null : '非零退出码',
    startedAt: '2026-09-20T10:15:41.000+08:00',
    endedAt: '2026-09-20T10:16:02.500+08:00',
  });
  await write(root, `.modelforge/runs/${RUN_CLEAN}.json`, serializeRunRecord(clean));
  await write(root, `.modelforge/runs/${RUN_FIT}.json`, serializeRunRecord(fit));
  await write(root, `.modelforge/tasks/${TASK_ID}.json`, serializeTaskPlan(plan()));
  return root;
}

describe('task resume IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it('registers the task-resume-* channels', () => {
    const handle = vi.fn();
    registerTaskResumeIpc({ handle }, deps);

    expect(handle.mock.calls.map(([channel]) => channel)).toEqual([...TASK_RESUME_CHANNELS]);
    expect(TASK_RESUME_CHANNELS).toEqual([
      'task-resume-list',
      'task-resume-continue',
      'task-resume-dismiss',
      'task-resume-complete',
    ]);
  });

  it('bridges each method to its channel', () => {
    const list = { projectDirs: ['/project'], includeDismissed: false };
    const target = { projectDir: '/project', taskId: 'task-1' };
    taskResumeBridge.taskResumeList(list);
    taskResumeBridge.taskResumeContinue(target);
    taskResumeBridge.taskResumeDismiss(target);
    taskResumeBridge.taskResumeComplete(target);

    expect(renderer.invoke.mock.calls).toEqual([
      ['task-resume-list', list],
      ['task-resume-continue', target],
      ['task-resume-dismiss', target],
      ['task-resume-complete', target],
    ]);
  });

  it('lists unfinished tasks with their steps, runs and failure point', async () => {
    const root = await project();

    const tasks = await data<ResumableTask[]>('task-resume-list', {
      projectDirs: [root, path.join(root, 'missing'), 'relative/project', root],
      includeDismissed: false,
    });

    expect(tasks).toHaveLength(1);
    const [task] = tasks;
    expect(task.projectDir).toBe(root);
    expect(task.plan).toEqual(plan());
    expect(task.failedStep).toBe('fit');
    expect(task.steps.map((step) => [step.id, step.completed])).toEqual([
      ['clean', true],
      ['fit', false],
    ]);
    expect(task.steps[1].runs).toEqual([
      {
        runId: RUN_FIT,
        recorded: true,
        startedAt: '2026-09-20T10:15:41.000+08:00',
        endedAt: '2026-09-20T10:16:02.500+08:00',
        exitCode: 1,
        failure: '非零退出码',
      },
    ]);
  });

  it('leaves out finished, dismissed and unusable plans unless dismissed ones are asked for', async () => {
    const root = await project();
    const dismissed = plan({
      taskId: 'dismissed-task',
      dismissed: true,
      createdAt: '2026-09-21T08:00:00.000+08:00',
    });
    await write(root, '.modelforge/tasks/dismissed-task.json', serializeTaskPlan(dismissed));
    await write(
      root,
      '.modelforge/tasks/done.json',
      serializeTaskPlan(plan({ taskId: 'done', status: '已完成' }))
    );
    await write(root, '.modelforge/tasks/broken.json', '{ "schemaVersion": 1,');
    await write(root, '.modelforge/tasks/.task-123.tmp', serializeTaskPlan(plan()));
    await write(root, '.modelforge/tasks/renamed.json', serializeTaskPlan(plan()));

    const offered = await data<ResumableTask[]>('task-resume-list', {
      projectDirs: [root],
      includeDismissed: false,
    });
    expect(offered.map((task) => task.plan.taskId)).toEqual([TASK_ID]);

    const all = await data<ResumableTask[]>('task-resume-list', {
      projectDirs: [root],
      includeDismissed: true,
    });
    expect(all.map((task) => task.plan.taskId)).toEqual(['dismissed-task', TASK_ID]);
  });

  it('plans the resume on the files as they are now', async () => {
    const root = await project();

    const failed = await data<ResumePlan>('task-resume-continue', {
      projectDir: root,
      taskId: TASK_ID,
    });
    expect(failed).toEqual({
      skip: ['clean'],
      resumeFrom: 'fit',
      staleReasons: [{ kind: 'run-failed', runId: RUN_FIT, exitCode: 1, failure: '非零退出码' }],
    });

    await write(root, 'results/clean.csv', 'edited by hand');
    const edited = await data<ResumePlan>('task-resume-continue', {
      projectDir: root,
      taskId: TASK_ID,
    });
    expect(edited.skip).toEqual([]);
    expect(edited.resumeFrom).toBe('clean');
    expect(edited.staleReasons).toEqual([
      {
        kind: 'hash-mismatch',
        runId: RUN_CLEAN,
        role: 'output',
        path: 'results/clean.csv',
        expected: sha256('cleaned'),
        actual: sha256('edited by hand'),
      },
    ]);

    await fs.rm(path.join(root, 'results', 'clean.csv'));
    const removed = await data<ResumePlan>('task-resume-continue', {
      projectDir: root,
      taskId: TASK_ID,
    });
    expect(removed.staleReasons).toEqual([
      { kind: 'file-missing', runId: RUN_CLEAN, role: 'output', path: 'results/clean.csv' },
    ]);
  });

  it('dismisses a task by setting only its flag', async () => {
    const root = await project();

    await expect(
      data<null>('task-resume-dismiss', { projectDir: root, taskId: TASK_ID })
    ).resolves.toBeNull();

    const text = await readPlanFile(root);
    expect(text).toBe(serializeTaskPlan(plan({ dismissed: true })));
    expect(parseTaskPlan(text)).toMatchObject({ ok: true, plan: { dismissed: true } });
    await expect(fs.readFile(path.join(root, 'results', 'clean.csv'), 'utf8')).resolves.toBe(
      'cleaned'
    );
  });

  it('marks a task completed only when no step is left to run', async () => {
    const failing = await project(1);
    const before = await readPlanFile(failing);
    const stillFailing = await data<ResumePlan>('task-resume-complete', {
      projectDir: failing,
      taskId: TASK_ID,
    });
    expect(stillFailing.resumeFrom).toBe('fit');
    expect(await readPlanFile(failing)).toBe(before);

    const finished = await project(0);
    const done = await data<ResumePlan>('task-resume-complete', {
      projectDir: finished,
      taskId: TASK_ID,
    });
    expect(done).toEqual({ skip: ['clean', 'fit'], resumeFrom: null, staleReasons: [] });
    expect(await readPlanFile(finished)).toBe(serializeTaskPlan(plan({ status: '已完成' })));
  });

  it('answers bad requests and unusable plans with stable codes and masked messages', async () => {
    const root = await project();
    await write(root, '.modelforge/tasks/broken.json', '{ "schemaVersion": 1,');

    const cases: Array<[string, unknown, string]> = [
      [
        'task-resume-list',
        { projectDirs: 'not a list', includeDismissed: false },
        'INVALID_REQUEST',
      ],
      ['task-resume-continue', { projectDir: 'relative', taskId: TASK_ID }, 'INVALID_REQUEST'],
      ['task-resume-continue', { projectDir: root, taskId: '../escape' }, 'INVALID_REQUEST'],
      ['task-resume-continue', { projectDir: root, taskId: 'unknown' }, 'TASK_NOT_FOUND'],
      ['task-resume-dismiss', { projectDir: root, taskId: 'broken' }, 'INVALID_TASK_PLAN'],
      [
        'task-resume-continue',
        { projectDir: path.join(root, SECRET), taskId: TASK_ID },
        'TASK_NOT_FOUND',
      ],
    ];
    for (const [channel, argument, code] of cases) {
      const result = await call(channel, argument);
      expect(result.ok, `${channel} ${JSON.stringify(argument)}`).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(code);
        expect(result.error.message).not.toContain(SECRET);
      }
    }
  });
});
