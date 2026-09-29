import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../test/pbt';
import type { RunFileHash, RunRecord } from '../types/runRecord';
import {
  isProjectRelativePath,
  loadRunRecords,
  locateJsonSyntaxError,
  parseRunRecord,
  RUN_RECORD_FIELDS,
  RUN_RECORD_MAX_FILES,
  RUN_RECORD_REQUIRED_FIELDS,
  serializeRunRecord,
} from './runRecord';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

interface RunRecordVectors {
  records: unknown[];
  invalid: Array<{ name: string; record: unknown; missing: string[]; invalid: string[] }>;
}

const vectors = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'fixtures/run-record-vectors.json'), 'utf8')
) as RunRecordVectors;

const schema = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'schemas/run-record.schema.json'), 'utf8')
) as { required: string[]; properties: Record<string, unknown> };

// --- generators ------------------------------------------------------------------------------

const RUN_ID_CHARS = Array.from('0123456789abcdefghijklmnopqrstuvwxyz');
const HEX_CHARS = Array.from('0123456789abcdef');

/** File name characters: Chinese, emoji, spaces, quotes, backslashes and dots. */
const nameUnit = fc.constantFrom(
  ...Array.from('abcXYZ019 _-.()$%\'"\\中文数据模型结果é'),
  '📊',
  '🔑',
  '🚀'
);
/** Free text additionally holds any grapheme, slashes, tabs, newlines and control characters. */
const textUnit = fc.oneof(
  nameUnit,
  fc.string({ unit: 'grapheme', minLength: 1, maxLength: 1 }),
  fc.constantFrom('/', '\n', '\t', '\u0001', '\u001f', '\u2028')
);
const textArb = fc.string({ unit: textUnit, maxLength: 40 });

const pathArb = fc
  .array(fc.string({ unit: nameUnit, minLength: 1, maxLength: 10 }), { minLength: 1, maxLength: 4 })
  .map((segments) => segments.join('/'))
  .filter(isProjectRelativePath);

const sha256Arb = fc.string({ unit: fc.constantFrom(...HEX_CHARS), minLength: 64, maxLength: 64 });
// fc.record may build objects with a null prototype, which toStrictEqual tells apart from the
// plain objects the parser returns; every record below asks for Object.prototype.
const plain = { noNullPrototype: true } as const;

const fileHashArb: fc.Arbitrary<RunFileHash> = fc.record(
  { path: pathArb, sha256: sha256Arb },
  plain
);

type FileList = { files: RunFileHash[]; truncated: boolean };

const shortFileListArb: fc.Arbitrary<FileList> = fc
  .array(fileHashArb, { maxLength: 5 })
  .map((files) => ({ files, truncated: false }));

/** Mostly short lists, sometimes up to the cap, sometimes exactly at the cap and truncated. */
const fileListArb: fc.Arbitrary<FileList> = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.array(fileHashArb, { maxLength: 20 }).map((files) => ({ files, truncated: false })),
  },
  {
    weight: 1,
    arbitrary: fc
      .array(fileHashArb, { maxLength: RUN_RECORD_MAX_FILES, size: 'max' })
      .map((files) => ({ files, truncated: false })),
  },
  {
    weight: 1,
    arbitrary: fc
      .array(fileHashArb, { minLength: RUN_RECORD_MAX_FILES, maxLength: RUN_RECORD_MAX_FILES })
      .map((files) => ({ files, truncated: true })),
  }
);

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const pad = (value: number, width: number) => String(value).padStart(width, '0');

const instantArb = fc
  .record({
    year: fc.integer({ min: 2000, max: 2099 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 31 }),
    hour: fc.integer({ min: 0, max: 23 }),
    minute: fc.integer({ min: 0, max: 59 }),
    second: fc.integer({ min: 0, max: 59 }),
    millis: fc.integer({ min: 0, max: 999 }),
    offset: fc.constantFrom('Z', '+00:00', '+08:00', '-05:00', '+05:45', '-12:00', '+14:00'),
  })
  .map((at) => ({ ...at, day: Math.min(at.day, daysInMonth(at.year, at.month)) }));

const timestampArb = instantArb.map(
  (at) =>
    `${pad(at.year, 4)}-${pad(at.month, 2)}-${pad(at.day, 2)}T${pad(at.hour, 2)}:` +
    `${pad(at.minute, 2)}:${pad(at.second, 2)}.${pad(at.millis, 3)}${at.offset}`
);

const runIdArb = fc
  .tuple(instantArb, fc.string({ unit: fc.constantFrom(...RUN_ID_CHARS), minLength: 6, maxLength: 6 }))
  .map(
    ([at, suffix]) =>
      `${pad(at.year, 4)}${pad(at.month, 2)}${pad(at.day, 2)}T${pad(at.hour, 2)}` +
      `${pad(at.minute, 2)}${pad(at.second, 2)}${pad(at.millis, 3)}-${suffix}`
  );

const outcomeArb: fc.Arbitrary<Pick<RunRecord, 'exitCode' | 'failure'>> = fc.oneof(
  fc.constant({ exitCode: 0, failure: null }),
  fc
    .integer({ min: -2147483648, max: 2147483647 })
    .filter((code) => code !== 0)
    .map((exitCode) => ({ exitCode, failure: '非零退出码' as const })),
  fc.constant({ exitCode: null, failure: '超时' as const }),
  fc.constant({ exitCode: null, failure: '用户取消' as const })
);

const recordArb = (files: fc.Arbitrary<FileList>): fc.Arbitrary<RunRecord> =>
  fc
    .record({
      runId: runIdArb,
      inputs: files,
      code: fileHashArb,
      config: fc.record({ provider: textArb, model: textArb, runtime: textArb }, plain),
      command: textArb,
      dependencies: fc.array(fc.record({ name: textArb, version: textArb }, plain), {
        maxLength: 8,
      }),
      seed: fc.oneof(fc.constant('未设置'), textArb),
      outcome: outcomeArb,
      startedAt: timestampArb,
      endedAt: timestampArb,
      outputs: files,
    })
    .map(
      (r): RunRecord => ({
        schemaVersion: 1,
        runId: r.runId,
        inputs: r.inputs.files,
        inputsTruncated: r.inputs.truncated,
        code: r.code,
        config: r.config,
        command: r.command,
        dependencies: r.dependencies,
        seed: r.seed,
        exitCode: r.outcome.exitCode,
        failure: r.outcome.failure,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        outputs: r.outputs.files,
        outputsTruncated: r.outputs.truncated,
      })
    );

/** Records with list lengths 0 to 1000, including full truncated lists. */
const runRecordArb = recordArb(fileListArb);
/** Cheaper records for properties that build several files per run. */
const smallRunRecordArb = recordArb(shortFileListArb);

function sampleRecord(): RunRecord {
  return {
    schemaVersion: 1,
    runId: '20260920T101530123-a1b2c3',
    inputs: [{ path: 'data/附件1.xlsx', sha256: 'a'.repeat(64) }],
    inputsTruncated: false,
    code: { path: 'code/问题一.py', sha256: 'b'.repeat(64) },
    config: { provider: 'openai', model: 'gpt-4o', runtime: 'python 3.12.4' },
    command: 'python "code/问题一.py"',
    dependencies: [{ name: 'numpy', version: '1.26.4' }],
    seed: '未设置',
    exitCode: 0,
    failure: null,
    startedAt: '2026-09-20T10:15:30.123+08:00',
    endedAt: '2026-09-20T10:15:31.456+08:00',
    outputs: [{ path: 'results/q1.csv', sha256: 'c'.repeat(64) }],
    outputsTruncated: false,
  };
}

function expectedPosition(text: string, offset: number) {
  const before = text.slice(0, offset);
  return { line: before.split('\n').length, column: before.length - before.lastIndexOf('\n') };
}

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

const sorted = (values: readonly string[]) => [...values].sort();

// --- tests -----------------------------------------------------------------------------------

describe('Run_Record contract', () => {
  it('lists the same fields as schemas/run-record.schema.json, in the same order', () => {
    expect(schema.required).toEqual([...RUN_RECORD_REQUIRED_FIELDS]);
    expect(Object.keys(schema.properties)).toEqual([...RUN_RECORD_FIELDS]);
  });

  it('serializes the fields in schema order with a trailing newline', () => {
    const text = serializeRunRecord(sampleRecord());
    expect(Object.keys(JSON.parse(text) as object)).toEqual([...RUN_RECORD_FIELDS]);
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('reads a missing failure as null and drops unknown properties', () => {
    const value = JSON.parse(serializeRunRecord(sampleRecord())) as Record<string, unknown>;
    value.extra = 'x';
    delete value.failure;
    expect(parseRunRecord(JSON.stringify(value))).toStrictEqual({ ok: true, record: sampleRecord() });
  });

  it('rejects lists above the cap and truncated lists below it', () => {
    const over = sampleRecord();
    over.outputs = Array.from({ length: RUN_RECORD_MAX_FILES + 1 }, (_, i) => ({
      path: `results/${i}.csv`,
      sha256: 'c'.repeat(64),
    }));
    over.outputsTruncated = true;
    const overResult = parseRunRecord(serializeRunRecord(over));
    expect(overResult).toMatchObject({ ok: false, missing: [], invalid: ['outputs'] });

    const under = sampleRecord();
    under.outputs = over.outputs.slice(0, RUN_RECORD_MAX_FILES - 1);
    under.outputsTruncated = true;
    const underResult = parseRunRecord(serializeRunRecord(under));
    expect(underResult).toMatchObject({ ok: false, missing: [], invalid: ['outputsTruncated'] });
  });

  it('rejects a root that is not an object', () => {
    expect(parseRunRecord('[]', 'a.json')).toStrictEqual({
      ok: false,
      path: 'a.json',
      missing: [],
      invalid: ['$'],
    });
  });
});

describe('shared Run_Record vectors (fixtures/run-record-vectors.json)', () => {
  it('holds 100 records, one of them at the input cap', () => {
    expect(vectors.records).toHaveLength(100);
    expect(
      vectors.records.some(
        (value) => (value as RunRecord).inputs.length === RUN_RECORD_MAX_FILES
      )
    ).toBe(true);
  });

  const recordCases: Array<[number, unknown]> = vectors.records.map((value, index) => [index, value]);

  it.each(recordCases)(
    'record %i reads back unchanged',
    (_index, value) => {
      const result = parseRunRecord(JSON.stringify(value, null, 2));
      expect(result).toStrictEqual({ ok: true, record: value });
      if (result.ok) {
        expect(JSON.parse(serializeRunRecord(result.record))).toStrictEqual(value);
      }
    }
  );

  it.each(vectors.invalid)('rejects $name', ({ record, missing, invalid }) => {
    const result = parseRunRecord(JSON.stringify(record), 'r.json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(sorted(result.missing)).toEqual(sorted(missing));
      expect(sorted(result.invalid)).toEqual(sorted(invalid));
    }
  });
});

// Feature: mathmodel-parity-and-beyond, Property 36: Run_Record JSON 往返
describe('Property 36: Run_Record JSON 往返', () => {
  it('parse(serialize(r)) equals r field by field, with list order kept', () => {
    fc.assert(
      fc.property(runRecordArb, (record) => {
        expect(parseRunRecord(serializeRunRecord(record))).toStrictEqual({ ok: true, record });
      }),
      pbtParams
    );
  });
});

// Feature: mathmodel-parity-and-beyond, Property 38: 无效 Run_Record 报告
describe('Property 38: 无效 Run_Record 报告', () => {
  it('reports exactly the deleted required fields', () => {
    fc.assert(
      fc.property(runRecordArb, fc.subarray([...RUN_RECORD_REQUIRED_FIELDS]), (record, removed) => {
        const value = JSON.parse(serializeRunRecord(record)) as Record<string, unknown>;
        for (const field of removed) {
          delete value[field];
        }
        const result = parseRunRecord(JSON.stringify(value, null, 2), 'runs/r.json');
        if (removed.length === 0) {
          expect(result).toStrictEqual({ ok: true, record });
          return;
        }
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.path).toBe('runs/r.json');
          expect(sorted(result.missing)).toEqual(sorted(removed));
          expect(result.invalid).toEqual([]);
          expect(result.parseErrorAt).toBeUndefined();
        }
      }),
      pbtParams
    );
  });

  it('reports the position of the first syntax error in truncated or damaged JSON', () => {
    const brokenArb = runRecordArb.chain((record) => {
      const text = serializeRunRecord(record);
      const lastBrace = text.lastIndexOf('}');
      return fc.oneof(
        // Any prefix that stops before the closing brace.
        fc.integer({ min: 0, max: lastBrace }).map((cut) => ({ text: text.slice(0, cut), offset: cut })),
        // A raw control character is invalid everywhere in JSON, inside strings and between tokens.
        fc.integer({ min: 0, max: text.length }).map((at) => ({
          text: `${text.slice(0, at)}\u0001${text.slice(at)}`,
          offset: at,
        }))
      );
    });
    fc.assert(
      fc.property(brokenArb, ({ text, offset }) => {
        expect(isValidJson(text)).toBe(false);
        expect(parseRunRecord(text, 'runs/r.json')).toStrictEqual({
          ok: false,
          path: 'runs/r.json',
          missing: [],
          invalid: [],
          parseErrorAt: expectedPosition(text, offset),
        });
      }),
      pbtParams
    );
  });

  it('agrees with JSON.parse on which texts are valid', () => {
    const textArb = fc.oneof(
      fc.json(),
      fc.string({ maxLength: 30 }),
      fc
        .tuple(fc.json(), fc.nat(), fc.constantFrom(',', '}', ']', '"', '\\', ':', ' ', '0', 'e', '.'))
        .map(([json, at, char]) => {
          const index = at % (json.length + 1);
          return json.slice(0, index) + char + json.slice(index);
        })
    );
    fc.assert(
      fc.property(textArb, (text) => {
        expect(locateJsonSyntaxError(text) === null).toBe(isValidJson(text));
      }),
      pbtParams
    );
  });

  it('keeps loading the other records of the Project and leaves every file untouched', () => {
    const fileArb = fc.tuple(smallRunRecordArb, fc.constantFrom('valid', 'missing', 'syntax'));
    fc.assert(
      fc.property(fc.array(fileArb, { maxLength: 6 }), (entries) => {
        const files = entries.map(([record, kind]) => {
          const filePath = `.modelforge/runs/${record.runId}.json`;
          const text = serializeRunRecord(record);
          if (kind === 'valid') {
            return Object.freeze({ path: filePath, text });
          }
          if (kind === 'missing') {
            const value = JSON.parse(text) as Record<string, unknown>;
            delete value.seed;
            return Object.freeze({ path: filePath, text: JSON.stringify(value) });
          }
          return Object.freeze({ path: filePath, text: text.slice(0, text.length >> 1) });
        });
        const before = files.map((file) => ({ ...file }));

        const loaded = loadRunRecords(Object.freeze(files));

        expect(files).toStrictEqual(before);
        expect(loaded.records.map((entry) => entry.path)).toEqual(
          files.filter((_, i) => entries[i][1] === 'valid').map((file) => file.path)
        );
        expect(loaded.problems.map((problem) => problem.path)).toEqual(
          files.filter((_, i) => entries[i][1] !== 'valid').map((file) => file.path)
        );
      }),
      pbtParams
    );
  });

  it('reports a record whose file name is not <runId>.json', () => {
    const loaded = loadRunRecords([
      { path: '.modelforge/runs/copy.json', text: serializeRunRecord(sampleRecord()) },
    ]);
    expect(loaded.records).toEqual([]);
    expect(loaded.problems).toEqual([
      { path: '.modelforge/runs/copy.json', missing: [], invalid: ['runId'] },
    ]);
  });
});
