import { describe, expect, it } from 'vitest';
import type { RunRecord, RunRecordMap } from '../../types/runRecord';
import type { TaskPlan } from '../../types/taskPlan';
import {
  compareByCreatedAtDesc,
  isResumableTask,
  planFilePaths,
  planRunIds,
  summarizeRun,
  summarizeTaskSteps,
} from './taskSummary';

const RUN_CLEAN = '20260920T101531000-aaaaaa';
const RUN_CLEAN_2 = '20260920T101535000-cccccc';
const RUN_FIT = '20260920T101541000-bbbbbb';
const HASH = 'a'.repeat(64);

function record(runId: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: 1,
    runId,
    inputs: [],
    inputsTruncated: false,
    code: { path: 'code/q1.py', sha256: HASH },
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
    taskId: 'task-1',
    title: '问题一求解',
    status: '执行中',
    dismissed: false,
    createdAt: '2026-09-20T10:15:30.123+08:00',
    steps: [
      { id: 'clean', title: '数据清洗', runIds: [RUN_CLEAN, RUN_CLEAN_2] },
      { id: 'fit', title: '模型求解', runIds: [RUN_FIT] },
      { id: 'plot', title: '绘图', runIds: [] },
    ],
    ...overrides,
  };
}

function runs(...records: RunRecord[]): RunRecordMap {
  return new Map(records.map((item) => [item.runId, item]));
}

describe('task summaries for the resume prompt', () => {
  it('marks completed steps and the first step without exit code 0 as the failure point', () => {
    const summary = summarizeTaskSteps(
      plan(),
      runs(
        record(RUN_CLEAN),
        record(RUN_CLEAN_2),
        record(RUN_FIT, { exitCode: 1, failure: '非零退出码' })
      )
    );

    expect(summary.steps.map((step) => step.completed)).toEqual([true, false, false]);
    expect(summary.failedStep).toBe('fit');
    expect(summary.steps[0].runs.map((run) => run.runId)).toEqual([RUN_CLEAN, RUN_CLEAN_2]);
    expect(summary.steps[1].runs).toEqual([
      {
        runId: RUN_FIT,
        recorded: true,
        startedAt: '2026-09-20T10:15:31.000+08:00',
        endedAt: '2026-09-20T10:15:40.000+08:00',
        exitCode: 1,
        failure: '非零退出码',
      },
    ]);
    expect(summary.steps[2].runs).toEqual([]);
  });

  it('does not count a step with a missing record or a timed-out run as completed', () => {
    const missing = summarizeTaskSteps(plan(), runs(record(RUN_CLEAN)));
    expect(missing.failedStep).toBe('clean');
    expect(missing.steps[0].runs[1]).toEqual({
      runId: RUN_CLEAN_2,
      recorded: false,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      failure: null,
    });

    const timedOut = summarizeRun(
      RUN_FIT,
      runs(record(RUN_FIT, { exitCode: null, failure: '超时' }))
    );
    expect(timedOut).toMatchObject({ recorded: true, exitCode: null, failure: '超时' });
  });

  it('reports no failure point when every step finished with exit code 0', () => {
    const finished = plan({ steps: plan().steps.slice(0, 2) });
    const summary = summarizeTaskSteps(
      finished,
      runs(record(RUN_CLEAN), record(RUN_CLEAN_2), record(RUN_FIT))
    );

    expect(summary.steps.every((step) => step.completed)).toBe(true);
    expect(summary.failedStep).toBeNull();
  });

  it('ignores a record filed under another run id', () => {
    const misfiled: RunRecordMap = new Map([[RUN_FIT, record(RUN_CLEAN)]]);
    expect(summarizeRun(RUN_FIT, misfiled).recorded).toBe(false);
  });

  it('offers unfinished tasks, and dismissed ones only when asked', () => {
    expect(isResumableTask(plan(), false)).toBe(true);
    expect(isResumableTask(plan({ status: '已暂停' }), false)).toBe(true);
    expect(isResumableTask(plan({ status: '已完成' }), true)).toBe(false);
    expect(isResumableTask(plan({ dismissed: true }), false)).toBe(false);
    expect(isResumableTask(plan({ dismissed: true }), true)).toBe(true);
  });

  it('lists every run once and every recorded file once', () => {
    const repeated = plan({
      steps: [
        { id: 'a', title: 'A', runIds: [RUN_CLEAN, RUN_FIT] },
        { id: 'b', title: 'B', runIds: [RUN_FIT] },
      ],
    });
    expect(planRunIds(repeated)).toEqual([RUN_CLEAN, RUN_FIT]);

    const paths = planFilePaths(
      repeated,
      runs(
        record(RUN_CLEAN, {
          inputs: [{ path: 'data/in.csv', sha256: HASH }],
          outputs: [{ path: 'results/clean.csv', sha256: HASH }],
        }),
        record(RUN_FIT, {
          inputs: [{ path: 'results/clean.csv', sha256: HASH }],
          code: { path: 'code/fit.py', sha256: HASH },
        })
      )
    );
    expect(paths).toEqual(['data/in.csv', 'code/q1.py', 'results/clean.csv', 'code/fit.py']);
  });

  it('sorts the newest task first', () => {
    const older = plan({ taskId: 'older', createdAt: '2026-09-19T10:00:00.000+08:00' });
    const newer = plan({ taskId: 'newer', createdAt: '2026-09-20T01:00:00.000Z' });
    expect([older, newer].sort(compareByCreatedAtDesc).map((item) => item.taskId)).toEqual([
      'newer',
      'older',
    ]);
  });
});
