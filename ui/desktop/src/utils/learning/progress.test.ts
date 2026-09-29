import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import learningPath from '../../catalog/learning-path.json';
import { pbtParams } from '../../test/pbt';
import {
  NO_VERDICT_REASON,
  UNEXPLAINED_FAILURE_REASON,
  applyCheckResults,
  progressByGroup,
  type CheckResult,
  type ExerciseChecks,
  type ExerciseRecord,
  type ExerciseStatus,
  type ProgressCatalog,
} from './progress';

const STATUSES: ExerciseStatus[] = ['未开始', '未通过', '已完成'];
const CHECKED_AT = '2026-09-30T10:15:00+08:00';

/** How the checker answered for one check item. */
type Answer =
  | { kind: 'pass' }
  | { kind: 'pass-twice' }
  | { kind: 'fail'; reason: string }
  | { kind: 'pass-and-fail'; reason: string }
  | { kind: 'missing' };

const reasonArb = fc.oneof(
  { weight: 4, arbitrary: fc.string({ minLength: 1, maxLength: 12 }) },
  { weight: 1, arbitrary: fc.constantFrom('', '  ') }
);

const answerArb: fc.Arbitrary<Answer> = fc.oneof(
  { weight: 5, arbitrary: fc.constant<Answer>({ kind: 'pass' }) },
  { weight: 1, arbitrary: fc.constant<Answer>({ kind: 'pass-twice' }) },
  { weight: 2, arbitrary: reasonArb.map((reason): Answer => ({ kind: 'fail', reason })) },
  { weight: 1, arbitrary: reasonArb.map((reason): Answer => ({ kind: 'pass-and-fail', reason })) },
  { weight: 1, arbitrary: fc.constant<Answer>({ kind: 'missing' }) }
);

function verdictsFor(checkId: string, answer: Answer): CheckResult[] {
  const pass: CheckResult = { checkId, passed: true, reason: '' };
  if (answer.kind === 'pass') return [pass];
  if (answer.kind === 'pass-twice') return [pass, { ...pass }];
  if (answer.kind === 'missing') return [];
  const fail: CheckResult = { checkId, passed: false, reason: answer.reason };
  return answer.kind === 'fail' ? [fail] : [pass, fail];
}

/** The failure reason the item should be reported with, or null when it passes. */
function expectedReason(answer: Answer): string | null {
  if (answer.kind === 'pass' || answer.kind === 'pass-twice') return null;
  if (answer.kind === 'missing') return NO_VERDICT_REASON;
  return answer.reason.trim() === '' ? UNEXPLAINED_FAILURE_REASON : answer.reason;
}

const EXERCISE_ID = 'lp-production-plan';

const previousArb: fc.Arbitrary<ExerciseRecord | undefined> = fc.oneof(
  fc.constant(undefined),
  fc
    .tuple(
      fc.constantFrom(EXERCISE_ID, 'another-exercise'),
      fc.constantFrom(...STATUSES),
      fc.boolean()
    )
    .map(
      ([exerciseId, status, solutionViewed]): ExerciseRecord => ({
        exerciseId,
        status,
        solutionViewed,
        lastSubmission: '上一次提交',
      })
    )
);

/** A catalogue shape: groups → courses → number of exercises in each course. */
const catalogShapeArb = fc.array(
  fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 3 }),
  { minLength: 1, maxLength: 5 }
);

function buildCatalog(shape: number[][]): { catalog: ProgressCatalog; exerciseIds: string[] } {
  const exerciseIds: string[] = [];
  const groups = shape.map((courses, groupIndex) => ({
    id: `group-${groupIndex}`,
    title: `分组 ${groupIndex}`,
    courses: courses.map((count) => ({
      exercises: Array.from({ length: count }, () => {
        const id = `exercise-${exerciseIds.length}`;
        exerciseIds.push(id);
        return { id };
      }),
    })),
  }));
  return { catalog: { groups }, exerciseIds };
}

// Feature: mathmodel-parity-and-beyond, Property 48: 练习完成判定与进度
describe('Property 48: 练习完成判定与进度', () => {
  it('completes an exercise exactly when every check item passes, and lists each failure otherwise', () => {
    fc.assert(
      fc.property(
        fc
          .uniqueArray(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'), { maxLength: 5 })
          .chain((checkIds) =>
            fc.tuple(
              fc.constant(checkIds),
              fc.array(answerArb, { minLength: checkIds.length, maxLength: checkIds.length })
            )
          ),
        fc.array(fc.boolean(), { maxLength: 2 }),
        fc.nat(),
        previousArb,
        fc.string({ maxLength: 20 }),
        ([checkIds, answers], strayVerdicts, shuffleSeed, previous, submission) => {
          const exercise = { id: EXERCISE_ID, checks: checkIds.map((id) => ({ id })) };
          const results = checkIds.flatMap((id, index) => verdictsFor(id, answers[index]));
          // Verdicts for ids the exercise does not have are ignored.
          strayVerdicts.forEach((passed, index) =>
            results.push({ checkId: `stray-${index}`, passed, reason: '无关的检查项' })
          );
          // Rotate so the verdict order differs from the catalogue order.
          const shift = results.length === 0 ? 0 : shuffleSeed % results.length;
          const ordered = [...results.slice(shift), ...results.slice(0, shift)];

          const { record, failures } = applyCheckResults(
            previous,
            exercise,
            ordered,
            CHECKED_AT,
            submission
          );

          const expectedFailures = checkIds.flatMap((checkId, index) => {
            const reason = expectedReason(answers[index]);
            return reason === null ? [] : [{ checkId, reason }];
          });
          const completed = checkIds.length > 0 && expectedFailures.length === 0;

          expect(failures).toEqual(expectedFailures);
          expect(record.exerciseId).toBe(EXERCISE_ID);
          expect(record.status).toBe(completed ? '已完成' : '未通过');
          expect(record.completedAt).toBe(completed ? CHECKED_AT : undefined);
          expect(record.lastSubmission).toBe(submission);
          expect(record.solutionViewed).toBe(
            previous !== undefined && previous.exerciseId === EXERCISE_ID
              ? previous.solutionViewed
              : false
          );
        }
      ),
      pbtParams
    );
  });

  it('counts completed over total exercises per group, with the percentage rounded', () => {
    fc.assert(
      fc.property(
        catalogShapeArb.chain((shape) => {
          const { catalog, exerciseIds } = buildCatalog(shape);
          return fc.tuple(
            fc.constant(catalog),
            fc.constant(exerciseIds),
            // Status history per exercise; the last entry is the current status.
            fc.array(fc.array(fc.constantFrom(...STATUSES), { maxLength: 2 }), {
              minLength: exerciseIds.length,
              maxLength: exerciseIds.length,
            }),
            fc.array(fc.constantFrom(...STATUSES), { maxLength: 2 })
          );
        }),
        ([catalog, exerciseIds, histories, strayStatuses]) => {
          const records: ExerciseRecord[] = strayStatuses.map((status, index) => ({
            exerciseId: `not-in-catalog-${index}`,
            status,
            solutionViewed: false,
          }));
          exerciseIds.forEach((exerciseId, index) => {
            for (const status of histories[index]) {
              records.push({ exerciseId, status, solutionViewed: false });
            }
          });
          const done = new Set(
            exerciseIds.filter((_, index) => histories[index].at(-1) === '已完成')
          );

          const progress = progressByGroup(records, catalog);

          expect(progress.map((group) => group.groupId)).toEqual(
            catalog.groups.map((group) => group.id)
          );
          progress.forEach((group, index) => {
            const ids = catalog.groups[index].courses.flatMap((course) =>
              course.exercises.map((exercise) => exercise.id)
            );
            const completed = ids.filter((id) => done.has(id)).length;
            expect(group.title).toBe(catalog.groups[index].title);
            expect(group.total).toBe(ids.length);
            expect(group.completed).toBe(completed);
            expect(group.percent).toBe(
              ids.length === 0 ? 0 : Math.round((100 * completed) / ids.length)
            );
          });
        }
      ),
      pbtParams
    );
  });
});

/** The part of `learning-path.json` these tests read. */
interface ShippedCatalog extends ProgressCatalog {
  groups: { id: string; title: string; courses: { exercises: ExerciseChecks[] }[] }[];
}

describe('shipped learning path', () => {
  const catalog = learningPath as ShippedCatalog;
  const exercises = catalog.groups.flatMap((group) =>
    group.courses.flatMap((course) => course.exercises)
  );

  it('starts every group at zero progress', () => {
    const progress = progressByGroup([], catalog);
    expect(progress.map((group) => group.title)).toEqual([
      '数据处理',
      '优化模型',
      '预测模型',
      '评价模型',
      '论文写作',
    ]);
    for (const group of progress) {
      expect(group.total).toBeGreaterThan(0);
      expect(group.completed).toBe(0);
      expect(group.percent).toBe(0);
    }
  });

  it('reaches 100% when every check item of every exercise passes', () => {
    const records = exercises.map((exercise) => {
      const results = exercise.checks.map((check) => ({
        checkId: check.id,
        passed: true,
        reason: '',
      }));
      return applyCheckResults(undefined, exercise, results, CHECKED_AT, '提交内容').record;
    });
    for (const group of progressByGroup(records, catalog)) {
      expect(group.completed).toBe(group.total);
      expect(group.percent).toBe(100);
    }
  });
});
