import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../../test/pbt';
import {
  abortedTask,
  aggregate,
  budgetGate,
  finalizeTasks,
  nextTask,
  normalizeTask,
  tokensUsed,
  type EvalFailure,
  type EvalTaskResult,
  type EvalTaskSpec,
  type EvalTaskStatus,
} from './evalSummary';

const idArb = fc.string({
  unit: fc.constantFrom('a', 'b', 'z', '0', '-', '中', '文', '题'),
  minLength: 1,
  maxLength: 8,
});
const modelArb = fc.constantFrom('deepseek-chat', 'qwen-max', 'claude-sonnet-4', '本地模型');
const statusArb: fc.Arbitrary<EvalTaskStatus> = fc.constantFrom('完成', '失败', '已中止');
/** The runner only records 完成 or 失败 for a task it started. */
const ranStatusArb: fc.Arbitrary<EvalTaskStatus> = fc.constantFrom('完成', '失败');
const failureArb: fc.Arbitrary<EvalFailure> = fc.constantFrom('模型调用失败', '超时');
/** Up to two hours, with millisecond precision. */
const secondsArb = fc.integer({ min: 0, max: 7_200_000 }).map((ms) => ms / 1000);

interface RawTask {
  id: string;
  total: number;
  passed: number;
  compiled: boolean;
  seconds: number;
  tokensIn: number;
  tokensOut: number;
  model: string;
  status: EvalTaskStatus;
  failure: EvalFailure;
}

/** Builds a result the way the runner writes it: `failure` only on failed tasks. */
function toResult(raw: RawTask): EvalTaskResult {
  const result: EvalTaskResult = {
    id: raw.id,
    passed: Math.min(raw.passed, raw.total),
    total: raw.total,
    compiled: raw.compiled,
    seconds: raw.seconds,
    tokensIn: raw.tokensIn,
    tokensOut: raw.tokensOut,
    model: raw.model,
    status: raw.status,
  };
  return raw.status === '失败' ? { ...result, failure: raw.failure } : result;
}

function rawTaskArb(status: fc.Arbitrary<EvalTaskStatus>): fc.Arbitrary<RawTask> {
  return fc.record(
    {
      id: idArb,
      total: fc.integer({ min: 0, max: 12 }),
      passed: fc.integer({ min: 0, max: 12 }),
      compiled: fc.boolean(),
      seconds: secondsArb,
      tokensIn: fc.integer({ min: 0, max: 200_000 }),
      tokensOut: fc.integer({ min: 0, max: 50_000 }),
      model: modelArb,
      status,
      failure: failureArb,
    },
    { noNullPrototype: true }
  );
}

/** Any recorded result, including failed and aborted tasks that still claim passed checks. */
const taskArb = rawTaskArb(statusArb).map(toResult);

/** What one started task ends as. */
const ranTaskArb = rawTaskArb(ranStatusArb);

describe('evalSummary examples', () => {
  it('stops at the limit and on unknown usage or limit', () => {
    expect(budgetGate(0, 1)).toBe('continue');
    expect(budgetGate(999, 1000)).toBe('continue');
    expect(budgetGate(1000, 1000)).toBe('stop');
    expect(budgetGate(0, 0)).toBe('stop');
    expect(budgetGate(Number.NaN, 1000)).toBe('stop');
    expect(budgetGate(0, Number.NaN)).toBe('stop');
  });

  it('counts a failed task as 0 passed but keeps its time and tokens', () => {
    const failed: EvalTaskResult = {
      id: 'practice-air-quality',
      passed: 3,
      total: 9,
      compiled: false,
      seconds: 3600.5,
      tokensIn: 1200,
      tokensOut: 300,
      model: 'deepseek-chat',
      status: '失败',
      failure: '超时',
    };
    const done: EvalTaskResult = {
      ...failed,
      id: 'practice-bike-rebalancing',
      passed: 7,
      compiled: true,
      seconds: 100,
      status: '完成',
      failure: undefined,
    };
    expect(aggregate([failed, done])).toEqual({ passed: 7, seconds: 3700.5, tokens: 3000 });
    expect(normalizeTask(failed)).toEqual({ ...failed, passed: 0 });
    expect('failure' in normalizeTask(done)).toBe(false);
  });

  it('aborts every task when the budget is 0', () => {
    const specs: EvalTaskSpec[] = [
      { id: 'a', total: 5, model: 'm' },
      { id: 'b', total: 6, model: 'm' },
    ];
    expect(nextTask(specs, [], 0)).toBeNull();
    expect(finalizeTasks(specs, [])).toEqual(specs.map(abortedTask));
  });
});

// Feature: mathmodel-parity-and-beyond, Property 52: 评测汇总与预算门
describe('Property 52: 评测汇总与预算门', () => {
  it('sums per-task values and counts 0 passed checks for tasks that did not complete', () => {
    fc.assert(
      fc.property(fc.array(taskArb, { maxLength: 10 }), (tasks) => {
        let passed = 0;
        let seconds = 0;
        let tokens = 0;
        for (const task of tasks) {
          passed += task.status === '完成' ? task.passed : 0;
          seconds += task.seconds;
          tokens += task.tokensIn + task.tokensOut;
        }
        expect(aggregate(tasks)).toEqual({ passed, seconds, tokens });

        // The normalized records written to the result file add up to the same summary.
        const normalized = tasks.map(normalizeTask);
        expect(aggregate(normalized)).toEqual(aggregate(tasks));
        expect(normalized.reduce((sum, task) => sum + task.passed, 0)).toBe(passed);
        normalized.forEach((task, index) => {
          const original = tasks[index];
          expect(task.status).toBe(original.status);
          expect(task.passed).toBe(original.status === '完成' ? original.passed : 0);
          expect(task.failure).toBe(original.status === '失败' ? original.failure : undefined);
          expect(task.seconds).toBe(original.seconds);
          expect(task.tokensIn + task.tokensOut).toBe(original.tokensIn + original.tokensOut);
        });
      }),
      pbtParams
    );
  });

  it('stops at the limit for any finite usage and budget', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (used, limit) => {
          expect(budgetGate(used, limit)).toBe(used >= limit ? 'stop' : 'continue');
        }
      ),
      pbtParams
    );
  });

  it('starts no task once the budget is reached, aborts the rest and keeps finished results', () => {
    const casesArb = fc.uniqueArray(
      fc.record(
        {
          spec: fc.record(
            { id: idArb, total: fc.integer({ min: 1, max: 12 }), model: modelArb },
            { noNullPrototype: true }
          ),
          outcome: ranTaskArb,
        },
        { noNullPrototype: true }
      ),
      { selector: (entry) => entry.spec.id, maxLength: 8 }
    );

    fc.assert(
      fc.property(casesArb, fc.integer({ min: 0, max: 1_000_000 }), (cases, limit) => {
        const specs: EvalTaskSpec[] = cases.map(({ spec }) => ({ ...spec }));
        const simulate = (index: number): EvalTaskResult =>
          toResult({ ...cases[index].outcome, id: specs[index].id, total: specs[index].total });

        // Drive the run the way evals/modeling/run.mts does, recording every model call.
        const started: string[] = [];
        const results: EvalTaskResult[] = [];
        for (
          let spec = nextTask(specs, results, limit);
          spec !== null;
          spec = nextTask(specs, results, limit)
        ) {
          expect(spec).toBe(specs[results.length]);
          expect(tokensUsed(results)).toBeLessThan(limit);
          started.push(spec.id);
          results.push(simulate(results.length));
        }

        // A task starts exactly when the tokens spent before it are still below the limit.
        let expectedStarted = 0;
        let spent = 0;
        while (expectedStarted < specs.length && spent < limit) {
          const outcome = simulate(expectedStarted);
          spent += outcome.tokensIn + outcome.tokensOut;
          expectedStarted += 1;
        }
        expect(started).toEqual(specs.slice(0, expectedStarted).map((spec) => spec.id));
        if (started.length < specs.length) {
          expect(budgetGate(tokensUsed(results), limit)).toBe('stop');
        }

        const tasks = finalizeTasks(specs, results);
        expect(tasks.map((task) => task.id)).toEqual(specs.map((spec) => spec.id));
        tasks.forEach((task, index) => {
          if (index < started.length) {
            // Finished results are kept as they were, apart from 0 passed for failed tasks.
            expect(task).toEqual(normalizeTask(simulate(index)));
          } else {
            expect(task.status).toBe('已中止');
            expect(task.passed).toBe(0);
            expect(task.total).toBe(specs[index].total);
            expect(task.model).toBe(specs[index].model);
            expect(task.compiled).toBe(false);
            expect(task.seconds).toBe(0);
            expect(task.tokensIn + task.tokensOut).toBe(0);
            expect('failure' in task).toBe(false);
          }
        });
        expect(aggregate(tasks).tokens).toBe(tokensUsed(results));
      }),
      pbtParams
    );
  });
});
