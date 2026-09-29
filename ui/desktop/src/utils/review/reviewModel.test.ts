import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../../test/pbt';
import {
  MAX_SCORE,
  MIN_SCORE,
  REVIEW_DIMENSIONS,
  compareReviews,
  validateReview,
  type DimensionName,
  type ReviewRecord,
} from './reviewModel';

const SKILL_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../crates/goose/src/skills/builtins'
);

/** A generated value together with whether the validator should accept it. */
interface Judged<T> {
  value: T;
  ok: boolean;
}

const nonBlank = fc.string({ minLength: 1, maxLength: 10 }).filter((text) => text.trim() !== '');

const scoreArb: fc.Arbitrary<Judged<unknown>> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.integer({ min: MIN_SCORE, max: MAX_SCORE }).map((value) => ({ value, ok: true })),
  },
  {
    weight: 1,
    arbitrary: fc
      .oneof(
        fc.integer({ min: -5, max: -1 }),
        fc.integer({ min: 11, max: 20 }),
        fc.double({ min: 0.1, max: 9.9, noNaN: true }).filter((value) => !Number.isInteger(value)),
        fc.constantFrom<unknown>('7', null, undefined, Number.NaN, Number.POSITIVE_INFINITY)
      )
      .map((value) => ({ value, ok: false })),
  }
);

const reasonsArb: fc.Arbitrary<Judged<unknown>> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.array(nonBlank, { minLength: 1, maxLength: 3 }).map((value) => ({
      value,
      ok: true,
    })),
  },
  {
    weight: 1,
    arbitrary: fc
      .oneof(
        fc.constant<unknown>([]),
        fc.array(fc.constantFrom('', '   ', '\n'), { minLength: 1, maxLength: 2 }),
        fc.tuple(nonBlank, fc.constantFrom<unknown>('', ' ', 3)).map(([good, bad]) => [good, bad]),
        fc.constantFrom<unknown>(undefined, null, '只有一条字符串', 5)
      )
      .map((value) => ({ value, ok: false })),
  }
);

interface Occurrence {
  entry: { name: DimensionName; score: unknown; reasons: unknown };
  ok: boolean;
}

const occurrenceArb = (name: DimensionName): fc.Arbitrary<Occurrence> =>
  fc.tuple(scoreArb, reasonsArb).map(([score, reasons]) => ({
    entry: { name, score: score.value, reasons: reasons.value },
    ok: score.ok && reasons.ok,
  }));

/** Each dimension appears once most of the time, sometimes not at all or twice. */
const slotArb = (name: DimensionName): fc.Arbitrary<Occurrence[]> =>
  fc
    .constantFrom(1, 1, 1, 1, 1, 1, 1, 1, 0, 2)
    .chain((count) => fc.array(occurrenceArb(name), { minLength: count, maxLength: count }));

/** Entries that can never be part of a valid review. */
const extraEntryArb = fc.oneof(
  fc
    .tuple(
      fc.constantFrom('总体评价', '摘要', '问题分析 ', 'Problem analysis', ''),
      fc.integer({ min: MIN_SCORE, max: MAX_SCORE })
    )
    .map(([name, score]): unknown => ({ name, score, reasons: ['理由'] })),
  fc.constantFrom<unknown>(null, 3, '问题分析', [], { score: 5, reasons: ['理由'] })
);

interface DimensionsCase {
  value: unknown;
  isArray: boolean;
  /** Occurrences of each dimension, in generation order. */
  slots: Record<string, Occurrence[]>;
  extras: number;
}

const slotsArb: fc.Arbitrary<Occurrence[][]> = fc
  .tuple(
    slotArb(REVIEW_DIMENSIONS[0]),
    slotArb(REVIEW_DIMENSIONS[1]),
    slotArb(REVIEW_DIMENSIONS[2]),
    slotArb(REVIEW_DIMENSIONS[3]),
    slotArb(REVIEW_DIMENSIONS[4]),
    slotArb(REVIEW_DIMENSIONS[5])
  )
  .map((slots) => [...slots]);

const extrasArb: fc.Arbitrary<unknown[]> = fc.oneof(
  { weight: 5, arbitrary: fc.constant<unknown[]>([]) },
  { weight: 1, arbitrary: fc.array(extraEntryArb, { minLength: 1, maxLength: 2 }) }
);

const dimensionsArb: fc.Arbitrary<DimensionsCase> = fc.oneof(
  {
    weight: 12,
    arbitrary: fc.tuple(slotsArb, extrasArb).chain(([slotList, extras]) => {
      const entries: unknown[] = slotList.flat().map((occurrence) => occurrence.entry);
      entries.push(...extras);
      const slots: Record<string, Occurrence[]> = {};
      REVIEW_DIMENSIONS.forEach((name, index) => {
        slots[name] = slotList[index];
      });
      return fc
        .shuffledSubarray(entries, { minLength: entries.length, maxLength: entries.length })
        .map((value): DimensionsCase => ({ value, isArray: true, slots, extras: extras.length }));
    }),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom<unknown>(undefined, null, {}, '问题分析')
      .map((value): DimensionsCase => ({ value, isArray: false, slots: {}, extras: 0 })),
  }
);

const validLocationArb = fc.oneof(
  fc
    .tuple(nonBlank, fc.integer({ min: 1, max: 500 }), fc.integer({ min: 0, max: 40 }))
    .map(([section, start, span]): unknown => ({ section, lines: [start, start + span] })),
  fc
    .tuple(nonBlank, fc.integer({ min: 1, max: 60 }))
    .map(([section, page]): unknown => ({ section, page })),
  fc
    .tuple(nonBlank, fc.integer({ min: 1, max: 60 }))
    .map(([section, page]): unknown => ({ section, lines: null, page }))
);

const invalidLocationArb = fc.constantFrom<unknown>(
  { section: '', page: 1 },
  { section: '  ', lines: [1, 2] },
  { section: '1 引言' },
  { section: '1 引言', lines: [5, 3] },
  { section: '1 引言', lines: [0, 2] },
  { section: '1 引言', lines: [1.5, 2] },
  { section: '1 引言', lines: [1, 2, 3] },
  { section: '1 引言', page: 0 },
  { section: '1 引言', page: '3' },
  { section: '1 引言', lines: [1, 2], page: -1 },
  { section: '1 引言', lines: null, page: null },
  null
);

const suggestionArb: fc.Arbitrary<Judged<unknown>> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc
      .tuple(nonBlank, validLocationArb)
      .map(([text, location]) => ({ value: { text, location }, ok: true })),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(nonBlank, invalidLocationArb)
      .map(([text, location]) => ({ value: { text, location }, ok: false })),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(fc.constantFrom<unknown>('', ' ', undefined, 7), validLocationArb)
      .map(([text, location]) => ({ value: { text, location }, ok: false })),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom<unknown>(null, '补充灵敏度分析', 3)
      .map((value) => ({ value, ok: false })),
  }
);

const suggestionsArb: fc.Arbitrary<Judged<unknown>> = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.array(suggestionArb, { maxLength: 3 }).map((items) => ({
      value: items.map((item) => item.value),
      ok: items.every((item) => item.ok),
    })),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom<unknown>(undefined, null, '无', {})
      .map((value) => ({ value, ok: false })),
  }
);

/** The validator's verdict, derived from the generation facts rather than the output. */
function expectedValid(dimensions: DimensionsCase, suggestions: Judged<unknown>): boolean {
  if (!dimensions.isArray || dimensions.extras > 0 || !suggestions.ok) return false;
  return REVIEW_DIMENSIONS.every((name) => {
    const occurrences = dimensions.slots[name];
    return occurrences.length === 1 && occurrences[0].ok;
  });
}

const BASE_TIME = Date.parse('2026-09-01T08:00:00.000Z');
const PAPER = 'paper/main.tex';

function makeRecord(paper: string, minutes: number, scores: number[]): ReviewRecord {
  return {
    paper,
    competitionId: 'cumcm',
    completedAt: new Date(BASE_TIME + minutes * 60000).toISOString(),
    dimensions: REVIEW_DIMENSIONS.map((name, index) => ({
      name,
      score: scores[index],
      reasons: ['理由'],
    })),
    suggestions: [],
  };
}

const scoresArb = fc.array(fc.integer({ min: MIN_SCORE, max: MAX_SCORE }), {
  minLength: REVIEW_DIMENSIONS.length,
  maxLength: REVIEW_DIMENSIONS.length,
});

const historyEntryArb = fc.tuple(fc.constantFrom(PAPER, 'paper/other.tex'), scoresArb);

// Feature: mathmodel-parity-and-beyond, Property 47: 评审结果校验与对比
describe('Property 47: 评审结果校验与对比', () => {
  it('accepts a review exactly when all six dimensions are present once with 0..10 integer scores and reasons', () => {
    fc.assert(
      fc.property(dimensionsArb, suggestionsArb, (dimensions, suggestions) => {
        const raw = { dimensions: dimensions.value, suggestions: suggestions.value };
        const result = validateReview(raw);
        const valid = expectedValid(dimensions, suggestions);

        expect(result.valid).toBe(valid);
        if (result.valid) {
          expect(result.problems).toEqual([]);
          expect(result.review.dimensions.map((dimension) => dimension.name)).toEqual([
            ...REVIEW_DIMENSIONS,
          ]);
          for (const dimension of result.review.dimensions) {
            const source = dimensions.slots[dimension.name][0].entry;
            expect(dimension.score).toBe(source.score);
            expect(dimension.reasons).toEqual(source.reasons);
          }
          expect(result.review.suggestions).toHaveLength((suggestions.value as unknown[]).length);
        } else {
          expect(result.problems.length).toBeGreaterThan(0);
        }

        if (dimensions.isArray) {
          for (const name of REVIEW_DIMENSIONS) {
            const occurrences = dimensions.slots[name];
            const kinds = result.problems
              .filter((problem) => 'name' in problem && problem.name === name)
              .map((problem) => problem.kind);
            expect(kinds.includes('missing-dimension')).toBe(occurrences.length === 0);
            expect(kinds.includes('duplicate-dimension')).toBe(occurrences.length > 1);
          }
        } else {
          expect(result.problems).toContainEqual({ kind: 'dimensions-not-array' });
        }
      }),
      pbtParams
    );
  });

  it('rejects anything that is not an object', () => {
    fc.assert(
      fc.property(fc.constantFrom<unknown>(null, undefined, 7, '评审', [], true), (raw) => {
        expect(validateReview(raw)).toEqual({ valid: false, problems: [{ kind: 'not-object' }] });
      }),
      pbtParams
    );
  });

  it('diffs every dimension against the latest earlier review of the same paper, or marks a first review', () => {
    fc.assert(
      fc.property(
        scoresArb,
        fc.uniqueArray(fc.integer({ min: -60, max: 60 }), { maxLength: 6 }),
        fc.array(historyEntryArb, { minLength: 6, maxLength: 6 }),
        fc.boolean(),
        (currentScores, offsets, entries, includeCurrent) => {
          // Minutes relative to the current review; the current record itself sits at 0.
          const dated = offsets.map((minutes, index) => ({
            minutes,
            record: makeRecord(entries[index][0], minutes, entries[index][1]),
          }));
          const current = makeRecord(PAPER, 0, currentScores);
          const history = dated.map(({ record }) => record);
          if (includeCurrent) history.push(current);

          const earlier = dated
            .filter(({ record, minutes }) => record.paper === PAPER && minutes < 0)
            .sort((a, b) => b.minutes - a.minutes);

          const result = compareReviews(current, history);
          if (earlier.length === 0) {
            expect(result).toEqual({ firstReview: true });
            return;
          }
          const previous = earlier[0].record;
          expect(result).toEqual({
            firstReview: false,
            previousCompletedAt: previous.completedAt,
            deltas: REVIEW_DIMENSIONS.map((name, index) => ({
              name,
              previous: previous.dimensions[index].score,
              current: currentScores[index],
              delta: currentScores[index] - previous.dimensions[index].score,
            })),
          });
        }
      ),
      pbtParams
    );
  });
});

describe('mathmodel-mock-review skill contract', () => {
  it('lists the same six dimensions and score range in the output schema', () => {
    const schema = JSON.parse(
      fs.readFileSync(
        path.join(SKILL_DIR, 'mathmodel_mock_review', 'review-output.schema.json'),
        'utf8'
      )
    );
    expect(schema.$defs.dimensionName.enum).toEqual([...REVIEW_DIMENSIONS]);
    expect(schema.$defs.dimension.properties.score).toEqual({
      type: 'integer',
      minimum: MIN_SCORE,
      maximum: MAX_SCORE,
    });
  });

  it('shows an example output that passes validation', () => {
    const body = fs.readFileSync(path.join(SKILL_DIR, 'mathmodel_mock_review.md'), 'utf8');
    const example = body.match(/```json\r?\n([\s\S]*?)\r?\n```/);
    expect(example).not.toBeNull();
    const result = validateReview(JSON.parse((example as RegExpMatchArray)[1]));
    expect(result).toMatchObject({ valid: true, problems: [] });
  });
});
