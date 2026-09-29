import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../../test/pbt';
import type { ColumnType, DataTable } from '../../types/datasets';
import { parseCsv, parseJson } from './datasetTable';
import { computePreviewStats, inferColumnType } from './previewStats';

const COLUMN_TYPES = ['int', 'float', 'bool', 'datetime', 'string'] as const;
type GenType = (typeof COLUMN_TYPES)[number];

// fast-check v4 的 fc.date 默认会生成 Invalid Date，这里显式排除
const dateArb = fc
  .date({
    min: new Date(Date.UTC(2000, 0, 1)),
    max: new Date(Date.UTC(2099, 11, 31)),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString().slice(0, 10));

function valueArb(kind: GenType): fc.Arbitrary<unknown> {
  switch (kind) {
    case 'int':
      return fc.integer({ min: -1_000_000, max: 1_000_000 });
    case 'float':
      return fc.float({ min: -1000, max: 1000, noNaN: true });
    case 'bool':
      return fc.boolean();
    case 'datetime':
      return dateArb;
    case 'string':
      return fc.string({ minLength: 1, maxLength: 12 }).map((s) => s.replace(/,/g, ''));
  }
}

const cellArb = (kind: GenType): fc.Arbitrary<unknown> =>
  fc.oneof(valueArb(kind), fc.constant(null), fc.constant(''));

const tableArb: fc.Arbitrary<DataTable> = fc
  .record({
    kinds: fc.array(fc.constantFrom(...COLUMN_TYPES), { minLength: 1, maxLength: 6 }),
    rowCount: fc.integer({ min: 1, max: 250 }),
  })
  .chain(({ kinds, rowCount }) => {
    const columns: Array<fc.Arbitrary<unknown[]>> = kinds.map((kind) =>
      fc.array(cellArb(kind), { minLength: rowCount, maxLength: rowCount })
    );
    const merged = columns.reduce<fc.Arbitrary<unknown[][]>>(
      (acc, col) => acc.chain((cols) => col.map((next) => [...cols, next])),
      fc.constant([] as unknown[][])
    );
    return merged.map((cols) => ({
      fields: kinds.map((_, i) => `f${i}`),
      rows: Array.from({ length: rowCount }, (_, r) => cols.map((col) => col[r])),
    }));
  });

function isMissing(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

// Feature: mathmodel-parity-and-beyond, Property 23: 数据预览统计
describe('Property 23: 数据预览统计', () => {
  it('reports row counts, preview limit, missing counts and one of five types', () => {
    fc.assert(
      fc.property(tableArb, (table) => {
        const preview = computePreviewStats(table);

        expect(preview.totalRows).toBe(table.rows.length);
        expect(preview.previewRows).toHaveLength(Math.min(table.rows.length, 100));

        for (let c = 0; c < table.fields.length; c += 1) {
          expect(['整数', '浮点数', '字符串', '布尔', '日期时间']).toContain(preview.types[c]);
          const expectedMissing = table.rows.filter((row) => isMissing(row[c])).length;
          expect(preview.missingCounts[c]).toBe(expectedMissing);
        }
      }),
      pbtParams
    );
  });

  it('infers an all-integer column as 整数', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -1000, max: 1000 }), { minLength: 1 }), (values) => {
        expect(inferColumnType(values)).toBe('整数');
      }),
      pbtParams
    );
  });

  it('survives a JSON round-trip', () => {
    fc.assert(
      fc.property(tableArb, (table) => {
        const objects = table.rows.map((row) =>
          Object.fromEntries(table.fields.map((field, i) => [field, row[i]]))
        );
        const reparsed = parseJson(JSON.stringify(objects));
        const preview = computePreviewStats(reparsed);

        expect(preview.totalRows).toBe(table.rows.length);
        expect(preview.previewRows).toHaveLength(Math.min(table.rows.length, 100));
        for (let c = 0; c < table.fields.length; c += 1) {
          expect(preview.missingCounts[c]).toBe(
            table.rows.filter((row) => isMissing(row[c])).length
          );
        }
      }),
      pbtParams
    );
  });

  it('parses a CSV table and counts missing cells', () => {
    const csv = ['name,age', 'alice,30', 'bob,', ',40'].join('\n');
    const table = parseCsv(csv);
    const preview = computePreviewStats(table);

    expect(preview.fields).toEqual(['name', 'age']);
    expect(preview.totalRows).toBe(3);
    expect(preview.types[1]).toBe('整数');
    expect(preview.missingCounts[0]).toBe(1);
    expect(preview.missingCounts[1]).toBe(1);
  });

  it('rejects JSON that is not an array of objects', () => {
    expect(() => parseJson('[1,2,3]')).toThrow();
    expect(() => parseJson('{"a":1}')).toThrow();
  });
});

describe('inferColumnType', () => {
  it('returns one of the five types for representative inputs', () => {
    const cases: Array<[unknown[], ColumnType]> = [
      [[1, 2, 3], '整数'],
      [[1, 2.5], '浮点数'],
      [[true, false], '布尔'],
      [['2026-01-01', '2026-02-01'], '日期时间'],
      [['a', 'b'], '字符串'],
    ];
    for (const [values, type] of cases) {
      expect(inferColumnType(values)).toBe(type);
    }
  });
});
