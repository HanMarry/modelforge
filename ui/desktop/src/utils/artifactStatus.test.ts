import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../test/pbt';
import type {
  ArtifactEntry,
  ArtifactIndex,
  StaleReason,
  StaleReasonKind,
  VerifyRejectReason,
} from '../types/artifactStatus';
import type {
  FileHashSnapshot,
  RunFailure,
  RunFileHash,
  RunRecord,
  RunRecordMap,
} from '../types/runRecord';
import {
  applyRunFinished,
  applyRunStarted,
  ARTIFACT_STATUSES,
  detectStaleness,
  emptyArtifactIndex,
  findStaleReasons,
  getArtifactEntry,
  isArtifactStatus,
  markVerified,
  STALE_REASON_KINDS,
} from './artifactStatus';
import { FILE_HASH_MISSING, FILE_HASH_UNREADABLE, RUN_FAILURES } from './runRecord';

// --- fixtures and generators -----------------------------------------------------------------

/** A small pool, so that entries, run inputs, run outputs and snapshots name the same files. */
const PATHS = [
  'data/附件1.xlsx',
  'data/附件 2.csv',
  'code/问题一.py',
  'code/q2.R',
  'results/q1.csv',
  'results/问题二结果.csv',
  'figures/图1.png',
  'paper/论文.pdf',
];
const RUN_IDS = [
  '20260920T101530123-a1b2c3',
  '20260920T111500000-zz09yy',
  '20260921T080000456-000000',
];
/** Linked from some entries but never present as a record. */
const ORPHAN_RUN_ID = '20260101T000000000-orphan';

/** Most recorded hashes equal the current one, so that both stale and current Artifacts occur. */
const HASH_CURRENT = 'a'.repeat(64);
const HASH_OLD = 'b'.repeat(64);
const HASH_OTHER = 'c'.repeat(64);

const FAILURES: ReadonlyArray<RunFailure | null> = [null, ...RUN_FAILURES];
const SECOND_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

// fc.record may build objects with a null prototype, which toStrictEqual tells apart from plain
// objects; every record below asks for Object.prototype.
const plain = { noNullPrototype: true } as const;

const pathArb = fc.constantFrom(...PATHS);
const runIdArb = fc.constantFrom(...RUN_IDS);

const entryFieldsArb = fc.record(
  {
    status: fc.constantFrom(...ARTIFACT_STATUSES),
    runId: fc.option(fc.constantFrom(...RUN_IDS, ORPHAN_RUN_ID), { nil: null }),
    failure: fc.constantFrom(...FAILURES),
    verification: fc.option(
      fc.record(
        {
          verifiedAt: fc.constantFrom('2026-09-20T10:20:05+08:00', '2026-09-22T01:00:00+00:00'),
          runId: runIdArb,
        },
        plain
      ),
      { nil: null }
    ),
    staleReasons: fc.array(
      fc.record({ kind: fc.constantFrom(...STALE_REASON_KINDS), path: pathArb }, plain),
      { maxLength: 2 }
    ),
  },
  plain
);

/** Any index over the path pool, including combinations no transition produces. */
const indexArb: fc.Arbitrary<ArtifactIndex> = fc
  .array(fc.tuple(pathArb, entryFieldsArb), { maxLength: 8 })
  .map((pairs) => ({
    schemaVersion: 1 as const,
    entries: Object.fromEntries(
      pairs.map(([path, fields]): [string, ArtifactEntry] => [path, { path, ...fields }])
    ),
  }));

const recordedHashArb = fc.oneof(
  { weight: 4, arbitrary: fc.constant(HASH_CURRENT) },
  { weight: 1, arbitrary: fc.constant(HASH_OLD) }
);

const fileHashArb: fc.Arbitrary<RunFileHash> = fc.record(
  { path: pathArb, sha256: recordedHashArb },
  plain
);

const outcomeArb: fc.Arbitrary<Pick<RunRecord, 'exitCode' | 'failure'>> = fc.oneof(
  { weight: 3, arbitrary: fc.constant({ exitCode: 0, failure: null }) },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom(1, 2, 137, -1073741819)
      .map((exitCode) => ({ exitCode, failure: '非零退出码' as const })),
  },
  { weight: 1, arbitrary: fc.constant({ exitCode: null, failure: '超时' as const }) },
  { weight: 1, arbitrary: fc.constant({ exitCode: null, failure: '用户取消' as const }) }
);

type RunFields = Pick<RunRecord, 'runId' | 'inputs' | 'code' | 'outputs' | 'exitCode' | 'failure'>;

function makeRun(fields: RunFields): RunRecord {
  return {
    schemaVersion: 1,
    runId: fields.runId,
    inputs: fields.inputs,
    inputsTruncated: false,
    code: fields.code,
    config: { provider: 'openai', model: 'gpt-4o', runtime: 'python 3.12.4' },
    command: `python "${fields.code.path}"`,
    dependencies: [{ name: 'numpy', version: '1.26.4' }],
    seed: '未设置',
    exitCode: fields.exitCode,
    failure: fields.failure,
    startedAt: '2026-09-20T10:15:30.123+08:00',
    endedAt: '2026-09-20T10:15:31.456+08:00',
    outputs: fields.outputs,
    outputsTruncated: false,
  };
}

const runArb: fc.Arbitrary<RunRecord> = fc
  .record(
    {
      runId: runIdArb,
      inputs: fc.array(fileHashArb, { maxLength: 3 }),
      code: fileHashArb,
      outputs: fc.array(fileHashArb, { maxLength: 3 }),
      outcome: outcomeArb,
    },
    plain
  )
  .map(({ outcome, ...files }) => makeRun({ ...files, ...outcome }));

function toRunMap(runs: readonly RunRecord[]): RunRecordMap {
  return new Map(runs.map((run): [string, RunRecord] => [run.runId, run]));
}

const runsArb: fc.Arbitrary<RunRecordMap> = fc.array(runArb, { maxLength: 4 }).map(toRunMap);

/** Current state of one file: mostly unchanged, sometimes changed, deleted, unreadable or absent. */
const currentHashArb: fc.Arbitrary<string | undefined> = fc.oneof(
  { weight: 12, arbitrary: fc.constant(HASH_CURRENT) },
  { weight: 1, arbitrary: fc.constant(HASH_OLD) },
  { weight: 1, arbitrary: fc.constant(HASH_OTHER) },
  { weight: 1, arbitrary: fc.constant(FILE_HASH_MISSING) },
  { weight: 1, arbitrary: fc.constant(FILE_HASH_UNREADABLE) },
  { weight: 1, arbitrary: fc.constant(undefined) }
);

const snapshotArb: fc.Arbitrary<FileHashSnapshot> = fc
  .array(currentHashArb, { minLength: PATHS.length, maxLength: PATHS.length })
  .map((values) => {
    const snapshot = new Map<string, string>();
    PATHS.forEach((path, index) => {
      const value = values[index];
      if (value !== undefined) {
        snapshot.set(path, value);
      }
    });
    return snapshot;
  });

const dateArb = fc.date({
  min: new Date('2000-01-01T00:00:00.000Z'),
  max: new Date('2099-12-31T23:59:59.999Z'),
  noInvalidDate: true,
});

// --- helpers ---------------------------------------------------------------------------------

/** Freezes plain objects and arrays deeply, and the values of a Map. */
function deepFreeze<T>(value: T): T {
  if (value instanceof Map) {
    for (const item of value.values()) {
      deepFreeze(item);
    }
  } else if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
  }
  return value;
}

const cloneIndex = (index: ArtifactIndex) => JSON.parse(JSON.stringify(index)) as ArtifactIndex;

const cloneRuns = (runs: RunRecordMap) =>
  new Map(
    [...runs].map(([runId, run]): [string, RunRecord] => [
      runId,
      JSON.parse(JSON.stringify(run)) as RunRecord,
    ])
  );

/** Test oracle for `findStaleReasons`, written from the rules in its documentation. */
function expectedStaleReasons(
  path: string,
  run: RunRecord,
  hashes: FileHashSnapshot
): StaleReason[] {
  const firstHash = (files: RunFileHash[], file: string) =>
    files.find((entry) => entry.path === file)?.sha256;
  const inputPaths = [...new Set(run.inputs.map((file) => file.path))].filter(
    (file) => file !== path && file !== run.code.path
  );
  const dependencies: Array<{ file: string; recorded: string | undefined; kind: StaleReasonKind }> =
    [
      ...inputPaths.map((file) => ({
        file,
        recorded: firstHash(run.outputs, file) ?? firstHash(run.inputs, file),
        kind: 'input-changed' as const,
      })),
      ...(run.code.path === path
        ? []
        : [
            {
              file: run.code.path,
              recorded: firstHash(run.outputs, run.code.path) ?? run.code.sha256,
              kind: 'code-changed' as const,
            },
          ]),
      { file: path, recorded: firstHash(run.outputs, path), kind: 'output-modified' },
    ];
  return dependencies.flatMap(({ file, recorded, kind }): StaleReason[] => {
    const current = hashes.get(file) ?? FILE_HASH_MISSING;
    if (current === FILE_HASH_MISSING) {
      return [{ kind: 'missing', path: file }];
    }
    if (current === FILE_HASH_UNREADABLE) {
      return [{ kind: 'unreadable', path: file }];
    }
    return recorded !== undefined && current !== recorded ? [{ kind, path: file }] : [];
  });
}

function expectedRejection(
  entry: ArtifactEntry | undefined,
  run: RunRecord | undefined
): VerifyRejectReason {
  if (!entry) {
    return 'not-tracked';
  }
  if (entry.status !== '已生成') {
    return 'not-generated';
  }
  return run ? 'run-failed' : 'run-record-missing';
}

// --- examples --------------------------------------------------------------------------------

describe('Artifact_Status transitions', () => {
  const data = 'data/附件1.xlsx';
  const code = 'code/问题一.py';
  const figure = 'figures/图1.png';
  const baseRun: RunFields = {
    runId: RUN_IDS[0],
    inputs: [{ path: data, sha256: HASH_CURRENT }],
    code: { path: code, sha256: HASH_CURRENT },
    outputs: [],
    exitCode: 0,
    failure: null,
  };

  it('has exactly the seven glossary values', () => {
    expect(ARTIFACT_STATUSES).toHaveLength(7);
    expect(ARTIFACT_STATUSES.every(isArtifactStatus)).toBe(true);
    expect(isArtifactStatus('已完成')).toBe(false);
  });

  it('walks one Artifact through the state diagram', () => {
    const timedOut = makeRun({ ...baseRun, exitCode: null, failure: '超时' });
    let state = applyRunStarted(emptyArtifactIndex(), timedOut.runId, [figure]);
    expect(getArtifactEntry(state, figure)?.status).toBe('执行中');
    state = applyRunFinished(state, timedOut);
    expect(getArtifactEntry(state, figure)).toStrictEqual({
      path: figure,
      status: '执行失败',
      runId: timedOut.runId,
      failure: '超时',
      verification: null,
      staleReasons: [],
    });

    const generated = makeRun({
      ...baseRun,
      runId: RUN_IDS[1],
      outputs: [{ path: figure, sha256: HASH_CURRENT }],
    });
    state = applyRunFinished(applyRunStarted(state, generated.runId, [figure]), generated);
    expect(getArtifactEntry(state, figure)?.status).toBe('已生成');

    const runs = toRunMap([timedOut, generated]);
    const now = new Date(Date.UTC(2026, 8, 20, 2, 20, 5, 999));
    const verified = markVerified(state, runs, figure, now);
    expect(verified.ok).toBe(true);
    state = verified.index;
    const verification = getArtifactEntry(state, figure)?.verification;
    expect(verification?.runId).toBe(generated.runId);
    expect(Date.parse(verification?.verifiedAt ?? '')).toBe(Date.UTC(2026, 8, 20, 2, 20, 5));

    const edited = new Map([
      [data, HASH_OTHER],
      [code, HASH_CURRENT],
      [figure, HASH_CURRENT],
    ]);
    state = detectStaleness(state, runs, edited);
    expect(getArtifactEntry(state, figure)).toStrictEqual({
      path: figure,
      status: '已过期',
      runId: generated.runId,
      failure: null,
      verification,
      staleReasons: [{ kind: 'input-changed', path: data }],
    });
    expect(markVerified(state, runs, figure, new Date())).toStrictEqual({
      ok: false,
      index: state,
      reason: 'not-generated',
    });

    const rerun = makeRun({
      ...baseRun,
      runId: RUN_IDS[2],
      inputs: [{ path: data, sha256: HASH_OTHER }],
      outputs: [{ path: figure, sha256: HASH_OLD }],
    });
    state = applyRunFinished(state, rerun);
    expect(getArtifactEntry(state, figure)).toStrictEqual({
      path: figure,
      status: '已生成',
      runId: rerun.runId,
      failure: null,
      verification: null,
      staleReasons: [],
    });
  });

  it('reports absent, unreadable and modified files as inputs, code, then the Artifact', () => {
    const run = makeRun({
      ...baseRun,
      inputs: [
        { path: 'data/a.csv', sha256: HASH_CURRENT },
        { path: 'data/b.csv', sha256: HASH_CURRENT },
        { path: 'data/a.csv', sha256: HASH_OLD },
      ],
      outputs: [{ path: 'results/q1.csv', sha256: HASH_CURRENT }],
    });
    const hashes = new Map([
      ['data/b.csv', FILE_HASH_UNREADABLE],
      [code, HASH_OLD],
      ['results/q1.csv', HASH_OTHER],
    ]);
    expect(findStaleReasons('results/q1.csv', run, hashes)).toStrictEqual([
      { kind: 'missing', path: 'data/a.csv' },
      { kind: 'unreadable', path: 'data/b.csv' },
      { kind: 'code-changed', path: code },
      { kind: 'output-modified', path: 'results/q1.csv' },
    ]);
  });

  it('compares files the run also wrote with their output hash', () => {
    // The script reads its cache and last run's result, then overwrites both.
    const run = makeRun({
      ...baseRun,
      inputs: [
        { path: 'data/cache.csv', sha256: HASH_OLD },
        { path: 'results/q1.csv', sha256: HASH_OLD },
      ],
      outputs: [
        { path: 'results/q1.csv', sha256: HASH_CURRENT },
        { path: 'data/cache.csv', sha256: HASH_CURRENT },
      ],
    });
    const hashes = new Map([
      ['data/cache.csv', HASH_CURRENT],
      [code, HASH_CURRENT],
      ['results/q1.csv', HASH_CURRENT],
    ]);
    expect(findStaleReasons('results/q1.csv', run, hashes)).toEqual([]);
  });

  it('keeps file names such as __proto__ as ordinary entries', () => {
    const run = makeRun({
      ...baseRun,
      inputs: [],
      outputs: [
        { path: '__proto__', sha256: HASH_CURRENT },
        { path: 'constructor', sha256: HASH_CURRENT },
      ],
    });
    const runs = toRunMap([run]);
    const state = applyRunFinished(emptyArtifactIndex(), run);
    expect(Object.getPrototypeOf(state.entries)).toBe(Object.prototype);
    expect(Object.keys(state.entries)).toEqual(['__proto__', 'constructor']);
    expect(getArtifactEntry(state, '__proto__')?.status).toBe('已生成');
    expect(getArtifactEntry(state, 'toString')).toBeUndefined();

    const verified = markVerified(state, runs, '__proto__', new Date());
    expect(verified.ok).toBe(true);
    expect(Object.getPrototypeOf(verified.index.entries)).toBe(Object.prototype);
    expect(getArtifactEntry(verified.index, '__proto__')?.status).toBe('已验证');
    expect(markVerified(state, runs, 'toString', new Date()).ok).toBe(false);

    const stale = detectStaleness(verified.index, runs, new Map([[code, HASH_CURRENT]]));
    expect(getArtifactEntry(stale, '__proto__')?.staleReasons).toStrictEqual([
      { kind: 'missing', path: '__proto__' },
    ]);
  });
});

// --- properties ------------------------------------------------------------------------------

// Feature: mathmodel-parity-and-beyond, Property 39: 执行结束的状态转换
describe('Property 39: 执行结束的状态转换', () => {
  it('generates the outputs of a successful run and fails every Artifact of a failed one', () => {
    fc.assert(
      fc.property(indexArb, runArb, (state, run) => {
        const before = cloneIndex(state);
        const next = applyRunFinished(deepFreeze(state), deepFreeze(run));
        expect(state).toStrictEqual(before);

        const outputs = new Set(run.outputs.map((file) => file.path));
        const pending = Object.keys(state.entries).filter(
          (path) =>
            state.entries[path].status === '执行中' && state.entries[path].runId === run.runId
        );
        const related = new Set([...outputs, ...pending]);
        expect(Object.keys(next.entries).sort()).toEqual(
          [...new Set([...Object.keys(state.entries), ...outputs])].sort()
        );

        for (const path of Object.keys(next.entries)) {
          const entry = next.entries[path];
          if (!related.has(path)) {
            expect(entry).toStrictEqual(state.entries[path]);
          } else if (run.exitCode !== 0) {
            expect(entry).toStrictEqual({
              path,
              status: '执行失败',
              runId: run.runId,
              failure: run.failure,
              verification: null,
              staleReasons: [],
            });
          } else if (outputs.has(path)) {
            expect(entry).toStrictEqual({
              path,
              status: '已生成',
              runId: run.runId,
              failure: null,
              verification: null,
              staleReasons: [],
            });
          } else {
            // Marked for this run but not written by it.
            expect(entry).toStrictEqual({
              path,
              status: '未开始',
              runId: null,
              failure: null,
              verification: null,
              staleReasons: [],
            });
          }
          if (run.exitCode !== 0 && entry.status === '已生成') {
            expect(getArtifactEntry(state, path)).toBe(entry);
          }
        }
      }),
      pbtParams
    );
  });
});

interface VerifyCase {
  state: ArtifactIndex;
  runs: RunRecordMap;
  path: string;
  now: Date;
}

/** Half of the cases hold a `已生成` entry at `path` whose run is known, so both outcomes occur. */
const verifyCaseArb: fc.Arbitrary<VerifyCase> = fc
  .record(
    {
      state: indexArb,
      runs: fc.array(runArb, { maxLength: 3 }),
      path: pathArb,
      now: dateArb,
      forced: fc.boolean(),
      target: runArb,
    },
    plain
  )
  .map(({ state, runs, path, now, forced, target }): VerifyCase => {
    if (!forced) {
      return { state, runs: toRunMap(runs), path, now };
    }
    const entry: ArtifactEntry = {
      path,
      status: '已生成',
      runId: target.runId,
      failure: null,
      verification: null,
      staleReasons: [],
    };
    return {
      state: { ...state, entries: { ...state.entries, [path]: entry } },
      runs: toRunMap([...runs, target]),
      path,
      now,
    };
  });

// Feature: mathmodel-parity-and-beyond, Property 40: 标记已验证规则
describe('Property 40: 标记已验证规则', () => {
  it('verifies exactly a 已生成 Artifact whose run exited 0, and otherwise returns the input', () => {
    fc.assert(
      fc.property(verifyCaseArb, ({ state, runs, path, now }) => {
        deepFreeze(state);
        deepFreeze(runs);
        const before = cloneIndex(state);
        const entry = getArtifactEntry(state, path);
        const run = entry && entry.runId !== null ? runs.get(entry.runId) : undefined;

        const result = markVerified(state, runs, path, now);

        expect(state).toStrictEqual(before);
        expect(result.ok).toBe(entry?.status === '已生成' && run?.exitCode === 0);
        if (result.ok && entry) {
          const verifiedAt = getArtifactEntry(result.index, path)?.verification?.verifiedAt ?? '';
          expect(verifiedAt).toMatch(SECOND_TIMESTAMP);
          expect(Date.parse(verifiedAt)).toBe(Math.floor(now.getTime() / 1000) * 1000);
          expect(result.index).toStrictEqual({
            schemaVersion: 1,
            entries: {
              ...state.entries,
              [path]: {
                ...entry,
                status: '已验证',
                verification: { verifiedAt, runId: entry.runId },
              },
            },
          });
        }
        if (!result.ok) {
          expect(result.index).toBe(state);
          expect(result.reason).toBe(expectedRejection(entry, run));
        }
      }),
      pbtParams
    );
  });
});

// Feature: mathmodel-parity-and-beyond, Property 41: 过期检测正确性
describe('Property 41: 过期检测正确性', () => {
  it('outdates exactly the checked Artifacts with a changed, missing or unreadable file', () => {
    fc.assert(
      fc.property(indexArb, runsArb, snapshotArb, (state, runs, hashes) => {
        deepFreeze(state);
        deepFreeze(runs);
        const before = cloneIndex(state);
        const runsBefore = cloneRuns(runs);
        const hashesBefore = new Map(hashes);

        const next = detectStaleness(state, runs, hashes);

        expect(state).toStrictEqual(before);
        expect(runs).toStrictEqual(runsBefore);
        expect(hashes).toStrictEqual(hashesBefore);
        expect(Object.keys(next.entries)).toEqual(Object.keys(state.entries));
        for (const path of Object.keys(state.entries)) {
          const entry = state.entries[path];
          const after = next.entries[path];
          expect(isArtifactStatus(after.status)).toBe(true);
          const run = entry.runId === null ? undefined : runs.get(entry.runId);
          const checked = entry.status === '已生成' || entry.status === '已验证';
          const reasons = checked && run ? expectedStaleReasons(path, run, hashes) : [];
          if (reasons.length === 0) {
            expect(after).toStrictEqual(entry);
          } else {
            expect(after).toStrictEqual({ ...entry, status: '已过期', staleReasons: reasons });
          }
        }
      }),
      pbtParams
    );
  });
});

// Feature: mathmodel-parity-and-beyond, Property 42: 过期检测幂等
describe('Property 42: 过期检测幂等', () => {
  it('gives the same index when run twice on the same snapshot', () => {
    fc.assert(
      fc.property(indexArb, runsArb, snapshotArb, (state, runs, hashes) => {
        const once = detectStaleness(state, runs, hashes);
        expect(detectStaleness(once, runs, hashes)).toStrictEqual(once);
        for (const path of Object.keys(state.entries)) {
          expect(once.entries[path].runId).toBe(state.entries[path].runId);
          expect(once.entries[path].verification).toStrictEqual(state.entries[path].verification);
        }
      }),
      pbtParams
    );
  });

  it('holds for indexes built by finished runs and verifications', () => {
    fc.assert(
      fc.property(
        fc.array(runArb, { minLength: 1, maxLength: 4 }),
        fc.subarray(PATHS),
        dateArb,
        snapshotArb,
        (runList, toVerify, now, hashes) => {
          const runs = toRunMap(runList);
          let state = runList.reduce(
            (index, run) => applyRunFinished(index, run),
            emptyArtifactIndex()
          );
          for (const path of toVerify) {
            state = markVerified(state, runs, path, now).index;
          }
          const once = detectStaleness(state, runs, hashes);
          expect(detectStaleness(once, runs, hashes)).toStrictEqual(once);
        }
      ),
      pbtParams
    );
  });
});
