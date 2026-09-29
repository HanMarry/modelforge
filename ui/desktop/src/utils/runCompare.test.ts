import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../test/pbt';
import type {
  CompareCell,
  CompareRowKind,
  ComparedRun,
  RunMeta,
  RunMetaJson,
} from '../types/runCompare';
import type { RunFileHash, RunRecord } from '../types/runRecord';
import {
  COMPARE_MISSING,
  compareRuns,
  formatMetaValue,
  parseRunMeta,
  RUN_META_MAX_DEPTH,
  runMetaFileName,
} from './runCompare';

const sha = (char: string) => char.repeat(64);

function recordWith(inputs: RunFileHash[]): RunRecord {
  return {
    schemaVersion: 1,
    runId: '20260920T101530123-a1b2c3',
    inputs,
    inputsTruncated: false,
    code: { path: 'code/问题一.py', sha256: sha('d') },
    config: { provider: 'openai', model: 'gpt-4o', runtime: 'python 3.12.4' },
    command: 'python "code/问题一.py"',
    dependencies: [],
    seed: '未设置',
    exitCode: 0,
    failure: null,
    startedAt: '2026-09-20T10:15:30.123+08:00',
    endedAt: '2026-09-20T10:15:31.456+08:00',
    outputs: [],
    outputsTruncated: false,
  };
}

function run(inputs: RunFileHash[], meta: RunMeta | null): ComparedRun {
  return { record: recordWith(inputs), meta };
}

function metaOf(text: string): RunMeta {
  const result = parseRunMeta(text);
  if (!result.ok) {
    throw new Error(`unexpected invalid meta: ${JSON.stringify(result)}`);
  }
  return result.meta;
}

const present = (text: string): CompareCell => ({ present: true, text });
const absent: CompareCell = { present: false, text: COMPARE_MISSING };

/** Independent oracle: equal JSON values, ignoring the order of object keys. */
function jsonEqual(x: RunMetaJson, y: RunMetaJson): boolean {
  if (Array.isArray(x) || Array.isArray(y)) {
    if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) {
      return false;
    }
    const ys: RunMetaJson[] = y;
    return x.every((item, index) => jsonEqual(item, ys[index]));
  }
  if (x === null || y === null || typeof x !== 'object' || typeof y !== 'object') {
    return x === y;
  }
  const left: { [key: string]: RunMetaJson } = x;
  const right: { [key: string]: RunMetaJson } = y;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.prototype.hasOwnProperty.call(right, key) && jsonEqual(left[key], right[key])
    )
  );
}

// --- generators ------------------------------------------------------------------------------

// fc.record may build objects with a null prototype, which toStrictEqual tells apart from the
// plain objects the parser returns; every record below asks for Object.prototype.
const plain = { noNullPrototype: true } as const;

/** Few names, so both runs often share one; includes names that are Object.prototype members. */
const nameArb = fc.constantFrom(
  'population',
  'rate',
  '学习率',
  'max iter',
  '__proto__',
  'constructor',
  'toString'
);

/** Finite doubles without -0, which JSON cannot tell from 0. */
const finiteArb = fc.double({ noNaN: true, noDefaultInfinity: true }).map((v) => (v === 0 ? 0 : v));

const scalarArb: fc.Arbitrary<RunMetaJson> = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer({ min: -3, max: 3 }),
  finiteArb,
  fc.string({ unit: fc.constantFrom(...Array.from('ab1 中—"\\')), maxLength: 6 })
);

/** Values that collide across runs, including objects that differ only in key order. */
const pooledValueArb = fc.constantFrom<RunMetaJson>(
  0,
  1,
  2.5,
  'adam',
  '1',
  true,
  null,
  [1, 2],
  { a: 1, b: [1, 2] },
  { b: [1, 2], a: 1 }
);

const valueArb: fc.Arbitrary<RunMetaJson> = fc.oneof(
  { weight: 3, arbitrary: pooledValueArb },
  { weight: 2, arbitrary: scalarArb },
  { weight: 1, arbitrary: fc.array(scalarArb, { maxLength: 3 }) },
  {
    weight: 1,
    arbitrary: fc
      .uniqueArray(fc.tuple(fc.constantFrom('a', 'b', 'c', '中'), scalarArb), {
        selector: ([key]) => key,
        maxLength: 3,
      })
      .map((pairs) => Object.fromEntries(pairs)),
  }
);

const metricValueArb = fc.oneof(fc.constantFrom(0, 0.5, 1, 0.012), finiteArb);

const entriesArb = <T>(values: fc.Arbitrary<T>) =>
  fc
    .uniqueArray(fc.tuple(nameArb, values), { selector: ([name]) => name, maxLength: 5 })
    .map((pairs) => pairs.map(([name, value]) => ({ name, value })));

const metaArb: fc.Arbitrary<RunMeta> = fc.record(
  {
    method: fc.option(fc.constantFrom('遗传算法', '模拟退火', '')),
    params: entriesArb(valueArb),
    metrics: entriesArb(metricValueArb),
  },
  plain
);

/** How an empty field is written: left out, `null`, or `{}` (method: left out). */
type EmptyStyle = 'omit' | 'null' | 'empty';

const INPUT_PATHS = ['data/附件1.xlsx', 'data/b.csv', 'x y/z.json', 'c.txt'];
const INPUT_HASHES = [sha('a'), sha('b'), sha('c')];

const inputsArb: fc.Arbitrary<RunFileHash[]> = fc.uniqueArray(
  fc.record(
    { path: fc.constantFrom(...INPUT_PATHS), sha256: fc.constantFrom(...INPUT_HASHES) },
    plain
  ),
  { selector: (file) => file.path, maxLength: INPUT_PATHS.length }
);

interface Side {
  inputs: RunFileHash[];
  /** `null`: the run has no `.meta.json`. */
  meta: RunMeta | null;
  empty: EmptyStyle;
}

const sideArb: fc.Arbitrary<Side> = fc.record(
  {
    inputs: inputsArb,
    meta: fc.option(metaArb),
    empty: fc.constantFrom<EmptyStyle>('omit', 'null', 'empty'),
  },
  plain
);

/** The `.meta.json` text a script would write for `meta`, with an unknown field. */
function renderMeta(meta: RunMeta, empty: EmptyStyle): string {
  const doc: Record<string, unknown> = { tool: 'run_script' };
  if (meta.method !== null) {
    doc.method = meta.method;
  } else if (empty === 'null') {
    doc.method = null;
  }
  const put = (
    field: 'params' | 'metrics',
    entries: ReadonlyArray<{ name: string; value: RunMetaJson }>
  ) => {
    if (entries.length > 0 || empty === 'empty') {
      // Object.fromEntries keeps a `__proto__` name as an own property, as JSON.parse does.
      doc[field] = Object.fromEntries(entries.map(({ name, value }) => [name, value]));
    } else if (empty === 'null') {
      doc[field] = null;
    }
  };
  put('params', meta.params);
  put('metrics', meta.metrics);
  return JSON.stringify(doc, null, 2);
}

/** Reads the side's metadata back through `parseRunMeta`, as the desktop will. */
function toComparedRun(side: Side): ComparedRun {
  const record = recordWith(side.inputs);
  if (side.meta === null) {
    return { record, meta: null };
  }
  const parsed = parseRunMeta(renderMeta(side.meta, side.empty), runMetaFileName(record.runId));
  expect(parsed).toStrictEqual({ ok: true, meta: side.meta });
  return { record, meta: parsed.ok ? parsed.meta : null };
}

function entriesOf(side: ComparedRun, kind: CompareRowKind): Map<string, RunMetaJson> {
  const entries: ReadonlyArray<{ name: string; value: RunMetaJson }> =
    (kind === 'param' ? side.meta?.params : side.meta?.metrics) ?? [];
  return new Map(entries.map(({ name, value }): [string, RunMetaJson] => [name, value]));
}

function expectCell(cell: CompareCell, entries: Map<string, RunMetaJson>, name: string) {
  if (entries.has(name)) {
    expect(cell).toStrictEqual(present(formatMetaValue(entries.get(name) as RunMetaJson)));
  } else {
    expect(cell).toStrictEqual(absent);
  }
}

// --- tests -----------------------------------------------------------------------------------

describe('compareRuns', () => {
  it('merges parameters and metrics by name and shows — for the run that lacks one', () => {
    const a = run([], {
      method: '遗传算法',
      params: [
        { name: 'population', value: 200 },
        { name: 'rate', value: 0.1 },
      ],
      metrics: [{ name: 'rmse', value: 0.012 }],
    });
    const b = run([], {
      method: '模拟退火',
      params: [
        { name: 'population', value: 300 },
        { name: 'elite', value: 5 },
      ],
      metrics: [{ name: 'rmse', value: 0.012 }],
    });
    expect(compareRuns(a, b)).toStrictEqual({
      rows: [
        {
          kind: 'param',
          name: 'population',
          a: present('200'),
          b: present('300'),
          highlight: true,
        },
        { kind: 'param', name: 'rate', a: present('0.1'), b: absent, highlight: false },
        { kind: 'param', name: 'elite', a: absent, b: present('5'), highlight: false },
        {
          kind: 'metric',
          name: 'rmse',
          a: present('0.012'),
          b: present('0.012'),
          highlight: false,
        },
      ],
      inputMismatch: [],
    });
  });

  it('compares values as JSON: key order and 1.0 do not matter, 1 and "1" differ', () => {
    const textA = '{"params": {"w": {"x": 1, "y": [1, 2]}, "seed": 1, "opt": "adam"}}';
    const textB = '{"params": {"w": {"y": [1, 2], "x": 1.0}, "seed": "1", "opt": "adam"}}';
    expect(compareRuns(run([], metaOf(textA)), run([], metaOf(textB))).rows).toStrictEqual([
      {
        kind: 'param',
        name: 'w',
        a: present('{"x":1,"y":[1,2]}'),
        b: present('{"x":1,"y":[1,2]}'),
        highlight: false,
      },
      { kind: 'param', name: 'seed', a: present('1'), b: present('1'), highlight: true },
      { kind: 'param', name: 'opt', a: present('adam'), b: present('adam'), highlight: false },
    ]);
  });

  it('shows every cell of a run without metadata as absent', () => {
    const a = run([], null);
    const b = run([], {
      method: null,
      params: [{ name: 'k', value: 3 }],
      metrics: [{ name: 'r2', value: 0.9 }],
    });
    expect(compareRuns(a, b).rows).toStrictEqual([
      { kind: 'param', name: 'k', a: absent, b: present('3'), highlight: false },
      { kind: 'metric', name: 'r2', a: absent, b: present('0.9'), highlight: false },
    ]);
  });

  it('lists inputs with other hashes or read by one run only, in the order of a, then b', () => {
    const a = run(
      [
        { path: 'x.csv', sha256: sha('a') },
        { path: 'y.csv', sha256: sha('b') },
        { path: 'z.csv', sha256: sha('c') },
      ],
      null
    );
    const b = run(
      [
        { path: 'w.csv', sha256: sha('a') },
        { path: 'y.csv', sha256: sha('e') },
        { path: 'x.csv', sha256: sha('a') },
      ],
      null
    );
    expect(compareRuns(a, b).inputMismatch).toEqual(['y.csv', 'z.csv', 'w.csv']);
  });

  it('compares a path listed twice by all of its hashes', () => {
    const a = run(
      [
        { path: 'x.csv', sha256: sha('a') },
        { path: 'x.csv', sha256: sha('b') },
      ],
      null
    );
    const b = run([{ path: 'x.csv', sha256: sha('a') }], null);
    expect(compareRuns(a, b).inputMismatch).toEqual(['x.csv']);
    expect(compareRuns(a, a).inputMismatch).toEqual([]);
  });
});

describe('parseRunMeta', () => {
  it('names the file after the run', () => {
    expect(runMetaFileName('20260920T101530123-a1b2c3')).toBe(
      '20260920T101530123-a1b2c3.meta.json'
    );
  });

  it('reads absent and null fields as empty and ignores unknown fields', () => {
    expect(parseRunMeta('{"method": null, "params": null, "extra": [1]}')).toStrictEqual({
      ok: true,
      meta: { method: null, params: [], metrics: [] },
    });
    expect(parseRunMeta('{}')).toStrictEqual({
      ok: true,
      meta: { method: null, params: [], metrics: [] },
    });
  });

  it('lists every field with a wrong type, including metrics that overflow to Infinity', () => {
    const text = '{"method": 3, "params": [1], "metrics": {"rmse": "0.1", "r2": 0.9, "big": 1e400}}';
    expect(parseRunMeta(text, 'runs/r.meta.json')).toStrictEqual({
      ok: false,
      path: 'runs/r.meta.json',
      invalid: ['method', 'params', 'metrics.rmse', 'metrics.big'],
    });
  });

  it('rejects a root that is not an object', () => {
    expect(parseRunMeta('[]', 'm.json')).toStrictEqual({ ok: false, path: 'm.json', invalid: ['$'] });
  });

  it('limits the nesting of parameter values', () => {
    const nested = (depth: number) => `{"params": {"deep": ${'['.repeat(depth)}${']'.repeat(depth)}}}`;
    expect(parseRunMeta(nested(RUN_META_MAX_DEPTH)).ok).toBe(true);
    expect(parseRunMeta(nested(RUN_META_MAX_DEPTH + 1))).toStrictEqual({
      ok: false,
      path: '',
      invalid: ['params.deep'],
    });
  });

  it('reports the position of a JSON syntax error', () => {
    expect(parseRunMeta('{"method": }', 'm.json')).toStrictEqual({
      ok: false,
      path: 'm.json',
      invalid: [],
      parseErrorAt: { line: 1, column: 12 },
    });
  });
});

// Feature: mathmodel-parity-and-beyond, Property 49: 方案对比表
describe('Property 49: 方案对比表', () => {
  it('rows are the union of names, — marks the absent side, highlight means both differ, and inputMismatch is exactly the disagreeing inputs', () => {
    fc.assert(
      fc.property(sideArb, sideArb, (left, right) => {
        const [a, b] = [left, right].map(toComparedRun);
        const before = JSON.stringify([a, b]);

        const result = compareRuns(a, b);

        expect(JSON.stringify([a, b])).toBe(before);
        const kinds: CompareRowKind[] = ['param', 'metric'];
        let rowCount = 0;
        for (const kind of kinds) {
          const inA = entriesOf(a, kind);
          const inB = entriesOf(b, kind);
          const rows = result.rows.filter((row) => row.kind === kind);
          rowCount += rows.length;
          expect(rows.map((row) => row.name).sort()).toEqual(
            [...new Set([...inA.keys(), ...inB.keys()])].sort()
          );
          for (const row of rows) {
            expectCell(row.a, inA, row.name);
            expectCell(row.b, inB, row.name);
            const bothDiffer =
              inA.has(row.name) &&
              inB.has(row.name) &&
              !jsonEqual(inA.get(row.name) as RunMetaJson, inB.get(row.name) as RunMetaJson);
            expect(row.highlight).toBe(bothDiffer);
          }
        }
        expect(result.rows).toHaveLength(rowCount);

        const hashesA = new Map(a.record.inputs.map((f): [string, string] => [f.path, f.sha256]));
        const hashesB = new Map(b.record.inputs.map((f): [string, string] => [f.path, f.sha256]));
        const mismatch = [...new Set([...hashesA.keys(), ...hashesB.keys()])].filter(
          (path) => hashesA.get(path) !== hashesB.get(path)
        );
        expect([...result.inputMismatch].sort()).toEqual(mismatch.sort());
        expect(new Set(result.inputMismatch).size).toBe(result.inputMismatch.length);
      }),
      pbtParams
    );
  });
});
