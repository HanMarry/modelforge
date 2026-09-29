import Decimal from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../../test/pbt';
import {
  checkNumberConsistency,
  normalizeName,
  paperValueMatches,
  parsePaperNumber,
  parseTableValue,
  readResultTable,
  roundHalfUp,
  type ResultTable,
} from './numberConsistency';

/** Wide enough that the test's own arithmetic never rounds. */
const D = Decimal.clone({ precision: 100 });

describe('roundHalfUp', () => {
  it('rounds ties away from zero with decimal arithmetic', () => {
    expect(roundHalfUp('2.5', 0).toString()).toBe('3');
    expect(roundHalfUp('-2.5', 0).toString()).toBe('-3');
    expect(roundHalfUp('1.005', 2).toFixed(2)).toBe('1.01');
    expect(roundHalfUp('-1.005', 2).toFixed(2)).toBe('-1.01');
    expect(roundHalfUp('0.12345678905', 10).toFixed(10)).toBe('0.1234567891');
  });

  it('rounds to tens and hundreds for negative places', () => {
    expect(roundHalfUp('1234', -2).toString()).toBe('1200');
    expect(roundHalfUp('1250', -2).toString()).toBe('1300');
    expect(roundHalfUp('-1250', -2).toString()).toBe('-1300');
  });
});

describe('parsePaperNumber', () => {
  it('reads plain, grouped, signed, exponent and percent forms', () => {
    const grouped = parsePaperNumber('1,234.5');
    expect(grouped?.value.toString()).toBe('1234.5');
    expect(grouped?.places).toBe(1);

    const times = parsePaperNumber('1.2\\times10^{-3}');
    expect(times?.value.toFixed()).toBe('0.0012');
    expect(times?.places).toBe(4);

    const hundreds = parsePaperNumber('1.2e3');
    expect(hundreds?.value.toString()).toBe('1200');
    expect(hundreds?.places).toBe(-2);

    expect(parsePaperNumber('95.3\\%')).toMatchObject({ percent: true, places: 1 });
    expect(parsePaperNumber('−0.5')?.value.toString()).toBe('-0.5');
    expect(parsePaperNumber('.5')?.places).toBe(1);
    expect(parsePaperNumber('０.２５')?.value.toString()).toBe('0.25');
  });

  it('rejects text that is not one number', () => {
    expect(parsePaperNumber('abc')).toBeNull();
    expect(parsePaperNumber('1.2.3')).toBeNull();
    expect(parsePaperNumber('')).toBeNull();
  });
});

describe('parseTableValue', () => {
  it('reads decimal, exponent, grouped and percent cells', () => {
    expect(parseTableValue(' 0.12 ')?.toString()).toBe('0.12');
    expect(parseTableValue('1.2e-5')?.toFixed()).toBe('0.000012');
    expect(parseTableValue('1,234.5')?.toString()).toBe('1234.5');
    expect(parseTableValue('95.3%')?.toString()).toBe('95.3');
    expect(parseTableValue('−3')?.toString()).toBe('-3');
    expect(parseTableValue('n/a')).toBeNull();
    expect(parseTableValue('')).toBeNull();
    expect(parseTableValue('NaN')).toBeNull();
  });
});

describe('paperValueMatches', () => {
  it('rounds the table value to the decimals of the paper number', () => {
    expect(paperValueMatches('1.01', '1.005')).toBe(true);
    expect(paperValueMatches('1.00', '1.005')).toBe(false);
    expect(paperValueMatches('0.3', '0.30000000000000004')).toBe(true);
    expect(paperValueMatches('12.30', '12.3')).toBe(true);
    expect(paperValueMatches('12', '12.49')).toBe(true);
    expect(paperValueMatches('12', '12.5')).toBe(false);
  });

  it('accepts percentages written against fractions and exponent forms', () => {
    expect(paperValueMatches('95.3\\%', '0.953')).toBe(true);
    expect(paperValueMatches('95.3%', '95.3')).toBe(true);
    expect(paperValueMatches('95.3%', '0.9534')).toBe(true);
    expect(paperValueMatches('95.3%', '0.9535')).toBe(false);
    expect(paperValueMatches('95.3', '0.953')).toBe(false);
    expect(paperValueMatches('1.2\\times10^{-3}', '0.00123')).toBe(true);
    expect(paperValueMatches('1.2\\times10^{-3}', '0.00125')).toBe(false);
    expect(paperValueMatches('1.2\\times 10^{3}', '1234')).toBe(true);
  });

  it('never matches a table value that is not a number', () => {
    expect(paperValueMatches('0.1', 'abc')).toBe(false);
    expect(paperValueMatches('abc', '0.1')).toBe(false);
  });
});

const digitsArb = (maxLength: number) =>
  fc.array(fc.integer({ min: 0, max: 9 }), { maxLength }).map((digits) => digits.join(''));

const integerPartArb = fc.oneof(
  fc.constant('0'),
  fc.bigInt({ min: 1n, max: 10n ** 12n }).map((value) => value.toString())
);

/** A decimal with up to 15 fraction digits. */
const genericValueArb = fc
  .tuple(fc.boolean(), integerPartArb, digitsArb(15))
  .map(([negative, integer, fraction]) => ({ negative, integer, fraction }));

// Feature: mathmodel-parity-and-beyond, Property 44: 论文数值四舍五入比较
describe('Property 44: 论文数值四舍五入比较', () => {
  it('matches the value rounded half up to d places and rejects ±1 in the last place', () => {
    const caseArb = fc.integer({ min: 0, max: 10 }).chain((places) =>
      fc.tuple(
        fc.constant(places),
        fc.oneof(
          genericValueArb,
          // Exactly halfway at place d + 1: x.…5, optionally followed by zeros.
          fc
            .tuple(fc.boolean(), integerPartArb, digitsArb(places), fc.integer({ min: 0, max: 3 }))
            .map(([negative, integer, head, zeros]) => ({
              negative,
              integer,
              fraction: `${head.padEnd(places, '0')}5${'0'.repeat(zeros)}`,
            }))
        )
      )
    );

    fc.assert(
      fc.property(caseArb, ([places, { negative, integer, fraction }]) => {
        const value = `${negative ? '-' : ''}${integer}${fraction === '' ? '' : `.${fraction}`}`;
        const literal = new D(value).toFixed(places, Decimal.ROUND_HALF_UP);
        const step = new D(10).pow(-places);
        const above = new D(literal).plus(step).toFixed(places);
        const below = new D(literal).minus(step).toFixed(places);

        expect(paperValueMatches(literal, value)).toBe(true);
        expect(paperValueMatches(above, value)).toBe(false);
        expect(paperValueMatches(below, value)).toBe(false);
        // The table may write the same value in exponent form; the outcome is unchanged.
        const exponent = new D(value).toExponential();
        expect(paperValueMatches(literal, exponent)).toBe(true);
        expect(paperValueMatches(above, exponent)).toBe(false);
      }),
      pbtParams
    );
  });
});

describe('readResultTable', () => {
  it('names CSV cells by row label and column header, dropping generic names', () => {
    const csv = 'model,RMSE,value\nLR,0.1234,1\nRF,0.0912,2\n';
    expect(readResultTable('results/models.csv', csv)).toEqual([
      { names: ['LR', 'RMSE'], raw: '0.1234' },
      { names: ['LR'], raw: '1' },
      { names: ['RF', 'RMSE'], raw: '0.0912' },
      { names: ['RF'], raw: '2' },
    ]);
    expect(readResultTable('a.csv', 'id,value\n1,0.5\n')).toEqual([]);
  });

  it('reads key-value rows, quoted fields, semicolons and TSV', () => {
    expect(readResultTable('kv.csv', '\ufeffrmse,0.1\r\nmae,0.2')).toEqual([
      { names: ['rmse'], raw: '0.1' },
      { names: ['mae'], raw: '0.2' },
    ]);
    expect(readResultTable('q.csv', '"name","score, test"\n"a ""b""",1.5\n')).toEqual([
      { names: ['a "b"', 'score, test'], raw: '1.5' },
    ]);
    expect(readResultTable('eu.csv', 'metric;score\nacc;0.9\n')).toEqual([
      { names: ['acc', 'score'], raw: '0.9' },
    ]);
    expect(readResultTable('t.tsv', 'rmse\t0.1\n')).toEqual([{ names: ['rmse'], raw: '0.1' }]);
  });

  it('names JSON numbers by their keys and the string fields next to them', () => {
    const json = JSON.stringify({
      q1: { objective: 12.5, method: 'LP' },
      models: [{ name: 'lr', rmse: 0.1 }],
      count: 3,
    });
    expect(readResultTable('results/summary.json', json)).toEqual([
      { names: ['q1', 'LP', 'objective'], raw: '12.5' },
      { names: ['models', 'lr', 'rmse'], raw: '0.1' },
      { names: ['count'], raw: '3' },
    ]);
    expect(readResultTable('bad.json', '{')).toEqual([]);
    expect(readResultTable('notes.txt', 'rmse,0.1')).toEqual([]);
  });

  it('normalises names to letters and digits', () => {
    expect(normalizeName('R^2')).toBe('r2');
    expect(normalizeName('RMSE (test)')).toBe('rmsetest');
    expect(normalizeName('Ｒ２')).toBe('r2');
  });
});

describe('checkNumberConsistency', () => {
  const summary: ResultTable = {
    path: 'results/summary.csv',
    runId: '20260920T101530123-abc123',
    values: readResultTable('results/summary.csv', 'metric,value\nrmse,0.1234\nmae,0.4567\n'),
  };
  const models: ResultTable = {
    path: 'results/models.csv',
    runId: '20260920T111530123-def456',
    values: readResultTable(
      'results/models.csv',
      'model,RMSE,MAE\nLR,0.1234,0.4567\nRF,0.0912,0.3104\n'
    ),
  };

  it('links prose and table numbers to named values and lists mismatches', () => {
    const paper = {
      path: 'paper/main.tex',
      text: [
        '\\section{结果}',
        '模型的 RMSE 为 0.123，MAE 为 0.50。',
        '% RMSE 为 9.99',
        '\\begin{tabular}{lcc}',
        '模型 & RMSE & MAE \\\\',
        '\\hline',
        'LR & 0.123 & 0.457 \\\\',
        'RF & 0.090 & 0.310 \\\\',
        '\\end{tabular}',
        '共有 2020 个样本，见图 \\ref{fig:1}。',
      ].join('\n'),
    };

    const report = checkNumberConsistency([paper], [summary, models]);

    expect(report.verdict).toBe('发现问题');
    expect(report.checked).toBe(6);
    expect(report.mismatches).toEqual([
      {
        paperValue: '0.50',
        path: 'paper/main.tex',
        line: 2,
        runId: summary.runId,
        table: 'results/summary.csv',
        tableValue: '0.4567',
      },
      {
        paperValue: '0.090',
        path: 'paper/main.tex',
        line: 8,
        runId: models.runId,
        table: 'results/models.csv',
        tableValue: '0.0912',
      },
    ]);
  });

  it('reads Markdown tables and passes when every linked number matches', () => {
    const table: ResultTable = {
      path: 'results/metrics.json',
      runId: '20260920T121530123-ghi789',
      values: readResultTable('results/metrics.json', '{"RMSE": 0.1234, "R^2": 0.9512}'),
    };
    const paper = {
      path: 'paper.md',
      text: ['| 指标 | 数值 |', '|---|---|', '| RMSE | 0.12 |', '', '$R^2=0.95$'].join('\n'),
    };

    const report = checkNumberConsistency([paper], [table]);

    expect(report).toEqual({ verdict: '通过', missing: null, checked: 2, mismatches: [] });
  });

  it('cannot run without sources, without tables or without any linked number', () => {
    const paper = { path: 'main.tex', text: '共有 2020 个样本。' };
    expect(checkNumberConsistency([], [summary]).missing).toBe('paper-source');
    expect(checkNumberConsistency([paper], []).missing).toBe('result-tables');
    const unlinked = checkNumberConsistency([paper], [summary]);
    expect(unlinked.verdict).toBe('无法执行');
    expect(unlinked.missing).toBe('linked-values');
  });
});
