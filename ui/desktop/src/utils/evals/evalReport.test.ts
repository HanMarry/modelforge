import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../../test/pbt';
import {
  aggregate,
  buildRunFile,
  buildTaskReports,
  finalizeTasks,
  learningTokens,
  tokensUsed,
  type CheckVerdict,
  type EvalCheckOutcome,
  type EvalRunInput,
  type EvalTaskDetail,
  type EvalTaskResult,
  type EvalTaskSpec,
  type LearningSampleReport,
  type TokenSource,
} from './evalSummary';

const spec = (id: string): EvalTaskSpec => ({ id, total: 3, model: 'openai/gpt-4o' });

function check(id: string, verdict: CheckVerdict): EvalCheckOutcome {
  return { id, question: '全题', method: verdict === '待人工' ? 'manual' : 'file', verdict };
}

const done: EvalTaskResult = {
  id: 'a',
  passed: 1,
  total: 3,
  compiled: true,
  seconds: 100,
  tokensIn: 1000,
  tokensOut: 200,
  model: 'openai/gpt-4o',
  status: '完成',
};

const doneDetail: EvalTaskDetail = {
  checks: [check('C01', '通过'), check('C02', '未通过'), check('C03', '待人工')],
  tokenSource: 'output',
};

const sample: LearningSampleReport = {
  id: 'lp-full-code-request',
  exerciseId: 'lp-production-plan',
  scenario: '索要完整代码',
  model: 'openai/gpt-4o',
  status: '完成',
  seconds: 12,
  tokensIn: 300,
  tokensOut: 50,
  tokenSource: 'output',
  suspectedFullSolution: true,
  missingHintOrQuestion: false,
  reasons: ['代码有导入与输出语句，可以单独运行'],
  reply: '```python\nprint(1)\n```',
  replyTruncated: false,
};

function input(patch: Partial<EvalRunInput>): EvalRunInput {
  return {
    startedAt: '2026-10-01T08:00:00.000Z',
    finishedAt: '2026-10-01T09:00:00.000Z',
    dryRun: false,
    models: ['openai/gpt-4o'],
    limit: 10_000,
    interrupted: false,
    provenance: { commit: 'c'.repeat(40), dirty: false, traceable: true },
    specs: [spec('a'), spec('b')],
    results: [done],
    details: [doneDetail],
    learningSamples: [sample],
    ...patch,
  };
}

describe('evalSummary result file examples', () => {
  it('keeps check verdicts of completed tasks and counts pending reviews', () => {
    const [a, b] = buildTaskReports([spec('a'), spec('b')], [done], [doneDetail]);
    expect(a).toEqual({ ...done, checks: doneDetail.checks, pendingReview: 1, tokenSource: 'output' });
    expect(b).toMatchObject({ id: 'b', status: '已中止', checks: [], tokenSource: 'none' });
    expect('detail' in b).toBe(false);
  });

  it('drops the verdicts of failed tasks and keeps their detail', () => {
    const failed: EvalTaskResult = { ...done, status: '失败', failure: '超时', passed: 2 };
    const [report] = buildTaskReports([spec('a')], [failed], [
      { ...doneDetail, detail: '超过 60 分钟未结束，已停止', tokenSource: 'session' },
    ]);
    expect(report).toMatchObject({
      status: '失败',
      failure: '超时',
      passed: 0,
      checks: [],
      pendingReview: 0,
      tokenSource: 'session',
      detail: '超过 60 分钟未结束，已停止',
    });
  });

  it('writes the summary, the budget and traceability', () => {
    const file = buildRunFile(input({}));
    expect(file.schemaVersion).toBe(1);
    expect(file.summary).toEqual({ passed: 1, seconds: 100, tokens: 1200 });
    expect(file.budget).toEqual({ limit: 10_000, used: 1550, exhausted: false });
    expect(file.commit).toBe('c'.repeat(40));
    expect(file.traceable).toBe(true);
    expect('untraceableReason' in file).toBe(false);
    expect(file.learningSamples).toEqual([sample]);
    expect(file.tasks.map((task) => task.status)).toEqual(['完成', '已中止']);
  });

  it('marks a run without a readable manifest as 不可追溯', () => {
    const file = buildRunFile(
      input({ provenance: { commit: null, dirty: null, traceable: false, reason: '找不到' } })
    );
    expect(file).toMatchObject({
      commit: null,
      dirty: null,
      traceable: false,
      untraceableReason: '找不到',
    });
    const inconsistent = buildRunFile(
      input({ provenance: { commit: 'x', dirty: true, traceable: false } })
    );
    expect(inconsistent).toMatchObject({ commit: null, dirty: null });
    expect(inconsistent.untraceableReason).toBeTruthy();
  });

  it('writes unknown token usage as null and counts it as an exhausted budget', () => {
    const unknown: EvalTaskResult = { ...done, tokensIn: Number.NaN, tokensOut: Number.NaN };
    const file = buildRunFile(
      input({ results: [unknown], details: [{ ...doneDetail, tokenSource: 'unknown' }] })
    );
    expect(file.budget.exhausted).toBe(true);
    const written = JSON.parse(JSON.stringify(file)) as {
      budget: { used: unknown };
      summary: { tokens: unknown };
      tasks: { tokensIn: unknown }[];
    };
    expect(written.budget.used).toBeNull();
    expect(written.summary.tokens).toBeNull();
    expect(written.tasks[0].tokensIn).toBeNull();
  });
});

describe('evalSummary result file properties', () => {
  const statusArb = fc.constantFrom('完成' as const, '失败' as const, '已中止' as const);
  const verdictArb = fc.constantFrom('通过' as const, '未通过' as const, '待人工' as const);
  const sourceArb = fc.constantFrom<TokenSource>('output', 'session');

  const ranArb = fc.record(
    {
      status: statusArb,
      verdicts: fc.array(verdictArb, { maxLength: 6 }),
      tokensIn: fc.integer({ min: 0, max: 100_000 }),
      tokensOut: fc.integer({ min: 0, max: 20_000 }),
      seconds: fc.integer({ min: 0, max: 3600 }),
      tokenSource: sourceArb,
    },
    { noNullPrototype: true }
  );

  it('reports every planned task once, with verdicts only for completed tasks', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 6 }),
        fc.array(ranArb, { maxLength: 6 }),
        fc.array(
          fc.record(
            { tokensIn: fc.nat(5000), tokensOut: fc.nat(5000) },
            { noNullPrototype: true }
          ),
          { maxLength: 3 }
        ),
        fc.integer({ min: 0, max: 500_000 }),
        (planned, ranRaw, sampleTokens, limit) => {
          const specs = Array.from({ length: planned }, (_, index) => spec(`t${index}`));
          const ran = ranRaw.slice(0, planned);
          const results = ran.map((raw, index): EvalTaskResult => {
            const checks = raw.verdicts.map((verdict, at) => check(`C${at}`, verdict));
            const result: EvalTaskResult = {
              id: specs[index].id,
              passed: checks.filter((item) => item.verdict === '通过').length,
              total: specs[index].total,
              compiled: false,
              seconds: raw.seconds,
              tokensIn: raw.tokensIn,
              tokensOut: raw.tokensOut,
              model: specs[index].model,
              status: raw.status,
            };
            return raw.status === '失败' ? { ...result, failure: '模型调用失败' } : result;
          });
          const details: EvalTaskDetail[] = ran.map((raw) => ({
            checks: raw.verdicts.map((verdict, at) => check(`C${at}`, verdict)),
            tokenSource: raw.tokenSource,
          }));
          const samples = sampleTokens.map((tokens, index) => ({
            ...sample,
            id: `s${index}`,
            ...tokens,
          }));

          const file = buildRunFile(
            input({ specs, results, details, learningSamples: samples, limit })
          );
          expect(file.tasks.map((task) => task.id)).toEqual(specs.map((item) => item.id));
          expect(file.summary).toEqual(aggregate(finalizeTasks(specs, results)));
          const used = tokensUsed(results) + learningTokens(samples);
          expect(file.budget).toEqual({ limit, used, exhausted: used >= limit });

          file.tasks.forEach((task, index) => {
            if (index >= ran.length) {
              expect(task).toMatchObject({ status: '已中止', checks: [], tokenSource: 'none' });
              return;
            }
            expect(task.tokenSource).toBe(ran[index].tokenSource);
            if (task.status === '完成') {
              expect(task.checks).toEqual(details[index].checks);
              expect(task.passed).toBe(
                task.checks.filter((item) => item.verdict === '通过').length
              );
              expect(task.pendingReview).toBe(
                task.checks.filter((item) => item.verdict === '待人工').length
              );
            } else {
              expect(task.checks).toEqual([]);
              expect(task.passed).toBe(0);
              expect(task.pendingReview).toBe(0);
            }
          });
          // Learning samples never add to the checks passed.
          expect(file.summary.passed).toBe(
            file.tasks.reduce((sum, task) => sum + task.passed, 0)
          );
        }
      ),
      pbtParams
    );
  });
});
