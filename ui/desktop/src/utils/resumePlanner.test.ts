import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../test/pbt';
import type { RunFileHash, RunRecord } from '../types/runRecord';
import type {
  ResumeFileRole,
  StepStaleReason,
  TaskPlan,
  TaskStatus,
  TaskStep,
} from '../types/taskPlan';
import {
  loadTaskPlans,
  parseTaskPlan,
  planResume,
  serializeTaskPlan,
  TASK_PLAN_FIELDS,
  TASK_STATUSES,
  taskPlanFileName,
} from './resumePlanner';
import {
  FILE_HASH_MISSING,
  FILE_HASH_UNREADABLE,
  loadRunRecords,
  RUN_RECORD_MAX_FILES,
  serializeRunRecord,
} from './runRecord';

type Outcome = Pick<RunRecord, 'exitCode' | 'failure'>;

const OK: Outcome = { exitCode: 0, failure: null };

/** A distinct lowercase SHA-256 for every `n`. */
const sha = (n: number) => n.toString(16).padStart(64, '0');

/** A distinct valid run id for every `n` below 1000. */
const runIdAt = (n: number) =>
  `20260920T101530${String(n).padStart(3, '0')}-r${String(n).padStart(5, '0')}`;

const file = (path: string, n: number): RunFileHash => ({ path, sha256: sha(n) });

function makeRecord(
  runId: string,
  inputs: RunFileHash[],
  code: RunFileHash,
  outputs: RunFileHash[],
  outcome: Outcome = OK
): RunRecord {
  return {
    schemaVersion: 1,
    runId,
    inputs,
    inputsTruncated: false,
    code,
    config: { provider: 'openai', model: 'gpt-4o', runtime: 'python 3.12.4' },
    command: `python "${code.path}"`,
    dependencies: [],
    seed: '未设置',
    exitCode: outcome.exitCode,
    failure: outcome.failure,
    startedAt: '2026-09-20T10:15:30.123+08:00',
    endedAt: '2026-09-20T10:15:31.456+08:00',
    outputs,
    outputsTruncated: false,
  };
}

/** The snapshot of a Project whose files all still match `records`. */
function unchanged(records: RunRecord[]): Map<string, string> {
  return new Map(
    records
      .flatMap((record) => [...record.inputs, record.code, ...record.outputs])
      .map((entry): [string, string] => [entry.path, entry.sha256])
  );
}

function byId(records: RunRecord[]): Map<string, RunRecord> {
  return new Map(records.map((record): [string, RunRecord] => [record.runId, record]));
}

function samplePlan(): TaskPlan {
  return {
    schemaVersion: 1,
    taskId: '20260920T101530123-a1b2c3',
    title: '问题一求解',
    status: '执行中',
    dismissed: false,
    createdAt: '2026-09-20T10:15:30.123+08:00',
    steps: [
      { id: 'clean', title: '数据清洗', runIds: ['20260920T101531000-x1y2z3'] },
      { id: 'fit', title: '模型求解', runIds: [] },
    ],
  };
}

const sorted = (values: readonly string[]) => [...values].sort();

// --- task plan file --------------------------------------------------------------------------

describe('task plan file', () => {
  it('serializes the fields in contract order with a trailing newline and reads them back', () => {
    const text = serializeTaskPlan(samplePlan());
    expect(Object.keys(JSON.parse(text) as object)).toEqual([...TASK_PLAN_FIELDS]);
    expect(text.endsWith('}\n')).toBe(true);
    expect(parseTaskPlan(text)).toStrictEqual({ ok: true, plan: samplePlan() });
  });

  it('reads a missing dismissed as false and drops unknown properties', () => {
    const value = JSON.parse(serializeTaskPlan(samplePlan())) as Record<string, unknown>;
    delete value.dismissed;
    value.extra = 1;
    (value.steps as Array<Record<string, unknown>>)[0].status = '已完成';
    expect(parseTaskPlan(JSON.stringify(value))).toStrictEqual({ ok: true, plan: samplePlan() });
  });

  it('reports every missing and invalid field', () => {
    const value = JSON.parse(serializeTaskPlan(samplePlan())) as Record<string, unknown>;
    delete value.title;
    value.taskId = '../x';
    value.status = 'done';
    value.dismissed = 'yes';
    value.createdAt = '2026-02-30T10:15:30.123+08:00';
    value.steps = [
      { id: 'a', title: 'A', runIds: ['../evil', '20260920T101531000-x1y2z3'] },
      { id: 'a', title: 'B', runIds: [] },
      'step',
      { title: 7, runIds: {} },
      { id: '', title: 'E' },
    ];
    const result = parseTaskPlan(JSON.stringify(value), 'tasks/t.json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.path).toBe('tasks/t.json');
      expect(sorted(result.missing)).toEqual(sorted(['title', 'steps[3].id', 'steps[4].runIds']));
      expect(sorted(result.invalid)).toEqual(
        sorted([
          'taskId',
          'status',
          'dismissed',
          'createdAt',
          'steps[0].runIds[0]',
          'steps[1].id',
          'steps[2]',
          'steps[3].title',
          'steps[3].runIds',
          'steps[4].id',
        ])
      );
    }
  });

  it('rejects a root that is not an object', () => {
    expect(parseTaskPlan('[]', 't.json')).toStrictEqual({
      ok: false,
      path: 't.json',
      missing: [],
      invalid: ['$'],
    });
  });

  it('reports the position of a JSON syntax error', () => {
    expect(parseTaskPlan('{"taskId": "a",', 't.json')).toStrictEqual({
      ok: false,
      path: 't.json',
      missing: [],
      invalid: [],
      parseErrorAt: { line: 1, column: 16 },
    });
  });

  it('loads the valid plans of a Project and reports the rest', () => {
    const plan = samplePlan();
    const text = serializeTaskPlan(plan);
    const loaded = loadTaskPlans([
      { path: `.modelforge/tasks/${taskPlanFileName(plan.taskId)}`, text },
      { path: '.modelforge/tasks/copy.json', text },
      { path: '.modelforge/tasks/broken.json', text: text.slice(0, 20) },
    ]);
    expect(loaded.plans).toStrictEqual([
      { path: '.modelforge/tasks/20260920T101530123-a1b2c3.json', plan },
    ]);
    expect(loaded.problems.map((problem) => problem.path)).toEqual([
      '.modelforge/tasks/copy.json',
      '.modelforge/tasks/broken.json',
    ]);
    expect(loaded.problems[0]).toStrictEqual({
      path: '.modelforge/tasks/copy.json',
      missing: [],
      invalid: ['taskId'],
    });
    expect(loaded.problems[1].parseErrorAt).toBeDefined();
  });
});

// --- planResume examples ---------------------------------------------------------------------

describe('planResume', () => {
  it('has nothing to resume without steps', () => {
    expect(planResume([], new Map(), new Map())).toStrictEqual({
      skip: [],
      resumeFrom: null,
      staleReasons: [],
    });
  });

  it('skips the matching prefix and stops at the first step that fails', () => {
    const records = [0, 1, 3].map((n) =>
      makeRecord(runIdAt(n), [file(`in/${n}.csv`, n)], file(`code/${n}.py`, n + 10), [
        file(`out/${n}.csv`, n + 20),
      ])
    );
    const steps = [
      { id: 'a', runIds: [runIdAt(0)] },
      { id: 'b', runIds: [runIdAt(1)] },
      { id: 'c', runIds: [runIdAt(2)] },
      { id: 'd', runIds: [runIdAt(3)] },
    ];
    expect(planResume(steps, byId(records), unchanged(records))).toStrictEqual({
      skip: ['a', 'b'],
      resumeFrom: 'c',
      staleReasons: [{ kind: 'record-missing', runId: runIdAt(2) }],
    });
  });

  it('does not skip a step without runs, or whose record is stored under another run id', () => {
    const record = makeRecord(runIdAt(1), [], file('code/q1.py', 1), []);
    const hashes = unchanged([record]);
    expect(planResume([{ id: 'a', runIds: [] }], byId([record]), hashes)).toStrictEqual({
      skip: [],
      resumeFrom: 'a',
      staleReasons: [{ kind: 'record-missing', runId: null }],
    });
    const misfiled = new Map([[runIdAt(2), record]]);
    expect(planResume([{ id: 'a', runIds: [runIdAt(2)] }], misfiled, hashes)).toStrictEqual({
      skip: [],
      resumeFrom: 'a',
      staleReasons: [{ kind: 'record-missing', runId: runIdAt(2) }],
    });
  });

  it('lists every failed condition of the first stale step in check order', () => {
    const runId = runIdAt(7);
    const record = makeRecord(
      runId,
      [file('in/a.csv', 1), file('in/b.csv', 2)],
      file('code/q1.py', 3),
      [file('out/r.csv', 4), file('out/s.csv', 5)],
      { exitCode: 1, failure: '非零退出码' }
    );
    // out/s.csv is not in the snapshot at all.
    const hashes = new Map<string, string>([
      ['in/a.csv', sha(10)],
      ['in/b.csv', FILE_HASH_MISSING],
      ['code/q1.py', FILE_HASH_UNREADABLE],
      ['out/r.csv', sha(4)],
    ]);
    const steps = [
      { id: 'solve', runIds: [runId] },
      { id: 'later', runIds: [] },
    ];
    expect(planResume(steps, byId([record]), hashes)).toStrictEqual({
      skip: [],
      resumeFrom: 'solve',
      staleReasons: [
        { kind: 'run-failed', runId, exitCode: 1, failure: '非零退出码' },
        {
          kind: 'hash-mismatch',
          runId,
          role: 'input',
          path: 'in/a.csv',
          expected: sha(1),
          actual: sha(10),
        },
        { kind: 'file-missing', runId, role: 'input', path: 'in/b.csv' },
        {
          kind: 'hash-mismatch',
          runId,
          role: 'code',
          path: 'code/q1.py',
          expected: sha(3),
          actual: FILE_HASH_UNREADABLE,
        },
        {
          kind: 'hash-mismatch',
          runId,
          role: 'output',
          path: 'out/s.csv',
          expected: sha(5),
          actual: FILE_HASH_UNREADABLE,
        },
      ],
    });
  });

  it('does not skip a step whose record lists only the first 1000 outputs', () => {
    const outputs = Array.from({ length: RUN_RECORD_MAX_FILES }, (_, i) => file(`out/${i}.csv`, i));
    const record = {
      ...makeRecord(runIdAt(1), [], file('code/q1.py', 5000), outputs),
      outputsTruncated: true,
    };
    expect(
      planResume([{ id: 'a', runIds: [record.runId] }], byId([record]), unchanged([record]))
    ).toStrictEqual({
      skip: [],
      resumeFrom: 'a',
      staleReasons: [{ kind: 'record-truncated', runId: record.runId, role: 'output' }],
    });
  });
});

// --- Property 50 -----------------------------------------------------------------------------

/** How a run's record file looks on disk: fine, absent, cut off, or without a required field. */
type RecordState = 'valid' | 'absent' | 'syntax' | 'incomplete';
/** A recorded file now: same hash, other hash, deleted, unreadable, or not in the snapshot. */
type FileState = 'same' | 'changed' | 'missing' | 'unreadable' | 'unknown';

interface RunScenario {
  record: RecordState;
  outcome: Outcome;
  inputs: FileState[];
  code: FileState;
  outputs: FileState[];
}

// fc.record may build objects with a null prototype; ask for plain ones throughout.
const plain = { noNullPrototype: true } as const;

const failedOutcomeArb: fc.Arbitrary<Outcome> = fc.oneof(
  fc
    .integer({ min: -2147483648, max: 2147483647 })
    .filter((code) => code !== 0)
    .map((exitCode) => ({ exitCode, failure: '非零退出码' as const })),
  fc.constant({ exitCode: null, failure: '超时' as const }),
  fc.constant({ exitCode: null, failure: '用户取消' as const })
);

const fileStateArb: fc.Arbitrary<FileState> = fc.oneof(
  { weight: 12, arbitrary: fc.constant<FileState>('same') },
  {
    weight: 1,
    arbitrary: fc.constantFrom<FileState>('changed', 'missing', 'unreadable', 'unknown'),
  }
);

/** A run that meets every condition, so that long skippable prefixes are common. */
const cleanRunArb: fc.Arbitrary<RunScenario> = fc.record(
  {
    record: fc.constant<RecordState>('valid'),
    outcome: fc.constant(OK),
    inputs: fc.array(fc.constant<FileState>('same'), { maxLength: 3 }),
    code: fc.constant<FileState>('same'),
    outputs: fc.array(fc.constant<FileState>('same'), { maxLength: 3 }),
  },
  plain
);

const anyRunArb: fc.Arbitrary<RunScenario> = fc.record(
  {
    record: fc.oneof(
      { weight: 6, arbitrary: fc.constant<RecordState>('valid') },
      { weight: 1, arbitrary: fc.constantFrom<RecordState>('absent', 'syntax', 'incomplete') }
    ),
    outcome: fc.oneof(
      { weight: 3, arbitrary: fc.constant(OK) },
      { weight: 1, arbitrary: failedOutcomeArb }
    ),
    inputs: fc.array(fileStateArb, { maxLength: 3 }),
    code: fileStateArb,
    outputs: fc.array(fileStateArb, { maxLength: 3 }),
  },
  plain
);

/** Each step has 0 to 2 runs; an empty step has not finished any run yet. */
const stepArb: fc.Arbitrary<RunScenario[]> = fc.oneof(
  { weight: 3, arbitrary: fc.array(cleanRunArb, { minLength: 1, maxLength: 2 }) },
  { weight: 2, arbitrary: fc.array(anyRunArb, { maxLength: 2 }) }
);

const taskArb = fc.record(
  {
    steps: fc.array(stepArb, { maxLength: 6 }),
    status: fc.constantFrom<TaskStatus>(...TASK_STATUSES),
    dismissed: fc.boolean(),
  },
  plain
);

interface BuiltTask {
  plan: TaskPlan;
  /** Record files as the I/O layer would read them from `.modelforge/runs/`. */
  files: Array<{ path: string; text: string }>;
  hashes: Map<string, string>;
  /** Per step, the reasons it cannot be skipped, known from the scenario alone. */
  expected: StepStaleReason[][];
}

/** Turns scenarios into a plan, record files and a snapshot; every path and run id is unique. */
function buildTask(scenario: RunScenario[][], status: TaskStatus, dismissed: boolean): BuiltTask {
  const files: Array<{ path: string; text: string }> = [];
  const hashes = new Map<string, string>();
  const expected: StepStaleReason[][] = [];
  let runCount = 0;
  let fileCount = 0;

  const steps: TaskStep[] = scenario.map((runs, stepIndex) => {
    const stepReasons: StepStaleReason[] = [];
    const runIds = runs.map((run) => {
      const runId = runIdAt(runCount);
      runCount += 1;
      const fileReasons: StepStaleReason[] = [];
      const recordFile = (role: ResumeFileRole, state: FileState): RunFileHash => {
        const n = fileCount;
        fileCount += 1;
        const path = `step${stepIndex}/${role}-${n}.csv`;
        const sha256 = sha(n);
        const other = sha(n + 100000);
        if (state === 'same') {
          hashes.set(path, sha256);
        } else if (state === 'changed') {
          hashes.set(path, other);
          fileReasons.push({
            kind: 'hash-mismatch',
            runId,
            role,
            path,
            expected: sha256,
            actual: other,
          });
        } else if (state === 'missing') {
          hashes.set(path, FILE_HASH_MISSING);
          fileReasons.push({ kind: 'file-missing', runId, role, path });
        } else {
          if (state === 'unreadable') {
            hashes.set(path, FILE_HASH_UNREADABLE);
          }
          fileReasons.push({
            kind: 'hash-mismatch',
            runId,
            role,
            path,
            expected: sha256,
            actual: FILE_HASH_UNREADABLE,
          });
        }
        return { path, sha256 };
      };
      const inputs = run.inputs.map((state) => recordFile('input', state));
      const code = recordFile('code', run.code);
      const outputs = run.outputs.map((state) => recordFile('output', state));
      const text = serializeRunRecord(makeRecord(runId, inputs, code, outputs, run.outcome));
      const path = `.modelforge/runs/${runId}.json`;

      if (run.record === 'valid') {
        files.push({ path, text });
        if (run.outcome.exitCode !== 0) {
          stepReasons.push({
            kind: 'run-failed',
            runId,
            exitCode: run.outcome.exitCode,
            failure: run.outcome.failure,
          });
        }
        stepReasons.push(...fileReasons);
      } else {
        if (run.record === 'syntax') {
          files.push({ path, text: text.slice(0, text.length >> 1) });
        } else if (run.record === 'incomplete') {
          const value = JSON.parse(text) as Record<string, unknown>;
          delete value.outputs;
          files.push({ path, text: JSON.stringify(value) });
        }
        stepReasons.push({ kind: 'record-missing', runId });
      }
      return runId;
    });
    expected.push(runs.length === 0 ? [{ kind: 'record-missing', runId: null }] : stepReasons);
    return { id: `step-${stepIndex}`, title: `步骤 ${stepIndex + 1}`, runIds };
  });

  const plan: TaskPlan = {
    schemaVersion: 1,
    taskId: '20260920T101530123-a1b2c3',
    title: '问题一求解',
    status,
    dismissed,
    createdAt: '2026-09-20T10:15:30.123+08:00',
    steps,
  };
  return { plan, files, hashes, expected };
}

// Feature: mathmodel-parity-and-beyond, Property 50: 中断恢复跳过规则
describe('Property 50: 中断恢复跳过规则', () => {
  it('skips exactly the longest prefix of steps that meet every condition, and resumeFrom is the first other step with its actual reasons', () => {
    fc.assert(
      fc.property(taskArb, ({ steps: scenario, status, dismissed }) => {
        const task = buildTask(scenario, status, dismissed);

        // The plan goes through its file format, as the desktop reads it.
        const parsed = parseTaskPlan(
          serializeTaskPlan(task.plan),
          `.modelforge/tasks/${taskPlanFileName(task.plan.taskId)}`
        );
        expect(parsed).toStrictEqual({ ok: true, plan: task.plan });
        if (!parsed.ok) {
          return;
        }
        // Absent and damaged record files drop out here, as they do in the desktop.
        const loaded = loadRunRecords(task.files);
        const runs = byId(loaded.records.map((entry) => entry.record));

        const result = planResume(parsed.plan.steps, runs, task.hashes);

        const firstStale = task.expected.findIndex((reasons) => reasons.length > 0);
        const prefix = firstStale === -1 ? task.plan.steps.length : firstStale;
        expect(result).toStrictEqual({
          skip: task.plan.steps.slice(0, prefix).map((step) => step.id),
          resumeFrom: firstStale === -1 ? null : task.plan.steps[firstStale].id,
          staleReasons: firstStale === -1 ? [] : task.expected[firstStale],
        });
        // The kernel receives the plan over ACP unchanged.
        expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result);
      }),
      pbtParams
    );
  });
});
