import fc from 'fast-check';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { pbtParams } from '../../test/pbt';
import {
  NUMBER_SLACK,
  countVerdicts,
  extractReportedValues,
  isSafeRelativePath,
  jsonEqual,
  judgeBaselineValue,
  judgeChecks,
  parseBaselineDocument,
  parseChecksDocument,
  parseTaskDocument,
  pathsToInspect,
  type BaselineValue,
  type CheckDefinition,
  type PathState,
  type TaskFacts,
} from './evalChecks';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const suiteDir = path.join(repoRoot, 'evals', 'modeling');

const taskIds = fs
  .readdirSync(suiteDir, { withFileTypes: true })
  .filter(
    (entry) => entry.isDirectory() && fs.existsSync(path.join(suiteDir, entry.name, 'task.yaml'))
  )
  .map((entry) => entry.name)
  .sort();

function readText(taskId: string, file: string): string {
  return fs.readFileSync(path.join(suiteDir, taskId, file), 'utf8');
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.value;
}

function loadTask(taskId: string) {
  const config = unwrap(parseTaskDocument(parseYaml(readText(taskId, 'task.yaml')), taskId));
  const checks = unwrap(parseChecksDocument(parseYaml(readText(taskId, config.checks)), taskId));
  const baseline = unwrap(
    parseBaselineDocument(JSON.parse(readText(taskId, config.baseline)), taskId)
  );
  return { config, checks, baseline };
}

function facts(
  values: Record<string, unknown> | null,
  paths: Record<string, PathState> = {}
): TaskFacts {
  return { paths, values, valuesFile: 'results.json' };
}

const minimalTask = {
  eval: {
    id: 'demo',
    title: '示例',
    category: '优化类',
    example: 'ui/desktop/resources/examples/demo',
    inputs: ['problem.md'],
    timeoutMinutes: 60,
    outputs: { paper: 'paper.pdf', values: 'results.json' },
    checks: 'checks.yaml',
    baseline: 'baseline.json',
  },
  recipe: { title: 'demo', prompt: 'p' },
};

describe('evalChecks examples', () => {
  it('accepts only relative paths that stay inside their base directory', () => {
    for (const ok of ['a', 'code', 'attachments/air_quality.csv', 'a/b/c.txt', '.hidden']) {
      expect(isSafeRelativePath(ok), ok).toBe(true);
    }
    for (const bad of ['', '/abs', 'a/../b', '..', './a', 'a//b', 'a/', 'C:/x', 'a\\b', 'a\0']) {
      expect(isSafeRelativePath(bad), bad).toBe(false);
    }
    expect(isSafeRelativePath(3)).toBe(false);
  });

  it('reads the eval part of a task and rejects what the runner cannot use', () => {
    expect(parseTaskDocument(minimalTask, 'demo')).toEqual({
      ok: true,
      value: { ...minimalTask.eval },
    });
    expect(parseTaskDocument(minimalTask, 'other').ok).toBe(false);
    expect(parseTaskDocument({ eval: minimalTask.eval }, 'demo').ok).toBe(false);
    const withEval = (patch: Record<string, unknown>) => ({
      ...minimalTask,
      eval: { ...minimalTask.eval, ...patch },
    });
    expect(parseTaskDocument(withEval({ timeoutMinutes: 61 }), 'demo').ok).toBe(false);
    expect(parseTaskDocument(withEval({ timeoutMinutes: '60' }), 'demo').ok).toBe(false);
    expect(parseTaskDocument(withEval({ inputs: ['../secret'] }), 'demo').ok).toBe(false);
    expect(parseTaskDocument(withEval({ inputs: ['a', 'a'] }), 'demo').ok).toBe(false);
    const noValues = withEval({ outputs: { paper: 'paper.pdf' } });
    expect(parseTaskDocument(noValues, 'demo').ok).toBe(false);
  });

  it('reads checks and rejects duplicates and incomplete entries', () => {
    const doc = {
      id: 'demo',
      checks: [
        { id: 'C01', question: '全题', method: 'file', path: 'code', criterion: 'c' },
        { id: 'C02', question: '问题一', method: 'baseline', keys: ['a'], criterion: 'c' },
        { id: 'C03', question: '问题二', method: 'manual', criterion: 'c' },
      ],
    };
    expect(unwrap(parseChecksDocument(doc, 'demo')).map((check) => check.method)).toEqual([
      'file',
      'baseline',
      'manual',
    ]);
    const bad = (check: Record<string, unknown>) =>
      parseChecksDocument({ id: 'demo', checks: [check] }, 'demo').ok;
    expect(bad({ id: 'C', question: 'q', method: 'file', criterion: 'c' })).toBe(false);
    expect(bad({ id: 'C', question: 'q', method: 'baseline', keys: [], criterion: 'c' })).toBe(
      false
    );
    expect(bad({ id: 'C', question: 'q', method: 'llm', criterion: 'c' })).toBe(false);
    expect(
      parseChecksDocument({ id: 'demo', checks: [doc.checks[2], doc.checks[2]] }, 'demo').ok
    ).toBe(false);
  });

  it('reads baseline values with pending entries and rejects inconsistent tolerances', () => {
    const doc = {
      id: 'demo',
      values: [
        { key: 'a', value: 1, tolerance: { mode: 'exact' } },
        { key: 'b', value: null, tolerance: null },
        { key: 'c', value: 2, tolerance: { mode: 'range', min: 1, max: 3 } },
      ],
    };
    expect(unwrap(parseBaselineDocument(doc, 'demo'))).toEqual([
      { key: 'a', value: 1, tolerance: { mode: 'exact' } },
      { key: 'b', value: null, tolerance: null },
      { key: 'c', value: 2, tolerance: { mode: 'range', min: 1, max: 3 } },
    ]);
    const one = (item: Record<string, unknown>) =>
      parseBaselineDocument({ id: 'demo', values: [item] }, 'demo').ok;
    expect(one({ key: 'a', value: 1, tolerance: null })).toBe(false);
    expect(one({ key: 'a', value: null, tolerance: { mode: 'exact' } })).toBe(false);
    expect(one({ key: 'a', value: 1, tolerance: { mode: 'abs', value: -1 } })).toBe(false);
    expect(one({ key: 'a', value: 1, tolerance: { mode: 'range', min: 2, max: 1 } })).toBe(false);
    expect(one({ key: 'a', value: 1, tolerance: { mode: 'rel', value: 0.1 } })).toBe(false);
  });

  it('compares exact, abs and range values as baseline.json conventions describe', () => {
    const exact = (value: unknown): BaselineValue => ({
      key: 'k',
      value,
      tolerance: { mode: 'exact' },
    });
    expect(judgeBaselineValue(exact(200), 200).verdict).toBe('通过');
    expect(judgeBaselineValue(exact(200), 200.5).verdict).toBe('未通过');
    expect(judgeBaselineValue(exact(200), '200').verdict).toBe('未通过');
    expect(judgeBaselineValue(exact('S03'), 'S03').verdict).toBe('通过');
    expect(judgeBaselineValue(exact(['a', 'b']), ['b', 'a']).verdict).toBe('未通过');
    expect(judgeBaselineValue(exact({ S01: 13 }), { S01: 13 }).verdict).toBe('通过');
    expect(judgeBaselineValue(exact({ S01: 13 }), { S01: 13, S02: 1 }).verdict).toBe('未通过');

    const abs: BaselineValue = { key: 'r', value: 0.651, tolerance: { mode: 'abs', value: 0.01 } };
    expect(judgeBaselineValue(abs, 0.661).verdict).toBe('通过');
    expect(judgeBaselineValue(abs, 0.641).verdict).toBe('通过');
    expect(judgeBaselineValue(abs, 0.662).verdict).toBe('未通过');
    expect(judgeBaselineValue(abs, '0.651').verdict).toBe('未通过');

    const map: BaselineValue = {
      key: 'pearson',
      value: { temperature: -0.1096, humidity: 0.3491 },
      tolerance: { mode: 'abs', value: 0.01 },
    };
    expect(judgeBaselineValue(map, { temperature: -0.11, humidity: 0.35, extra: 9 }).verdict).toBe(
      '通过'
    );
    const off = judgeBaselineValue(map, { temperature: -0.2, humidity: 0.35 });
    expect(off.verdict).toBe('未通过');
    expect(off.reason).toContain('temperature');
    expect(judgeBaselineValue(map, { humidity: 0.35 }).verdict).toBe('未通过');

    const range: BaselineValue = {
      key: 'rmse',
      value: 7.03,
      tolerance: { mode: 'range', min: 5.5, max: 9 },
    };
    expect(judgeBaselineValue(range, 5.5).verdict).toBe('通过');
    expect(judgeBaselineValue(range, 9).verdict).toBe('通过');
    expect(judgeBaselineValue(range, 9.01).verdict).toBe('未通过');

    expect(judgeBaselineValue(abs, undefined)).toEqual({ verdict: '未通过', reason: '缺少 r' });
    expect(judgeBaselineValue(abs, null)).toEqual({ verdict: '未通过', reason: 'r 为 null' });
    const pending: BaselineValue = { key: 'p', value: null, tolerance: null };
    expect(judgeBaselineValue(pending, 1).verdict).toBe('待人工');
  });

  it('judges file, baseline and manual checks in order', () => {
    const checks: CheckDefinition[] = [
      { id: 'C01', question: '全题', method: 'file', path: 'code', criterion: 'c' },
      { id: 'C02', question: '全题', method: 'file', path: 'paper.pdf', criterion: 'c' },
      { id: 'C03', question: '问题一', method: 'baseline', keys: ['a', 'b'], criterion: 'c' },
      { id: 'C04', question: '问题一', method: 'manual', criterion: 'c' },
      { id: 'C05', question: '问题二', method: 'baseline', keys: ['p'], criterion: 'c' },
    ];
    const baseline: BaselineValue[] = [
      { key: 'a', value: 1, tolerance: { mode: 'exact' } },
      { key: 'b', value: 2, tolerance: { mode: 'abs', value: 0.5 } },
      { key: 'p', value: null, tolerance: null },
    ];
    const outcomes = judgeChecks(
      checks,
      baseline,
      facts({ a: 1, b: 2.4 }, { code: 'present', 'paper.pdf': 'empty' })
    );
    expect(outcomes.map((outcome) => outcome.verdict)).toEqual([
      '通过',
      '未通过',
      '通过',
      '待人工',
      '待人工',
    ]);
    expect(outcomes[1].reason).toBe('paper.pdf 为空');
    expect(countVerdicts(outcomes, '通过')).toBe(2);
    expect(countVerdicts(outcomes, '待人工')).toBe(2);

    const missing = judgeChecks(checks, baseline, facts(null));
    expect(missing.map((outcome) => outcome.verdict)).toEqual([
      '未通过',
      '未通过',
      '未通过',
      '待人工',
      '未通过',
    ]);
    expect(missing[0].reason).toBe('code 不存在');
    expect(missing[2].reason).toContain('results.json');
    expect(pathsToInspect(checks, 'paper.pdf')).toEqual(['code', 'paper.pdf']);
  });

  it('reads only a values object from results.json', () => {
    expect(extractReportedValues({ values: { a: 1 } })).toEqual({ a: 1 });
    expect(extractReportedValues({ a: 1 })).toBeNull();
    expect(extractReportedValues({ values: [1] })).toBeNull();
    expect(extractReportedValues(null)).toBeNull();
  });
});

describe('evalChecks properties', () => {
  const finite = fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true });
  const tolerance = fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true });

  it('passes every value within an abs tolerance and fails every value beyond it', () => {
    fc.assert(
      fc.property(
        finite,
        tolerance,
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.boolean(),
        (reference, tol, inside, beyond, above) => {
          const item: BaselineValue = {
            key: 'k',
            value: reference,
            tolerance: { mode: 'abs', value: tol },
          };
          expect(judgeBaselineValue(item, reference + tol * inside).verdict).toBe('通过');
          const offset = tol + 1e-6 + tol * beyond;
          const outside = above ? reference + offset : reference - offset;
          expect(Math.abs(outside - reference)).toBeGreaterThan(tol + NUMBER_SLACK);
          expect(judgeBaselineValue(item, outside).verdict).toBe('未通过');
        }
      ),
      pbtParams
    );
  });

  it('treats exact comparison as JSON equality', () => {
    const json = fc.jsonValue({ maxDepth: 2 });
    fc.assert(
      fc.property(json, json, (reference, actual) => {
        fc.pre(reference !== null && actual !== null);
        const item: BaselineValue = { key: 'k', value: reference, tolerance: { mode: 'exact' } };
        const expected = JSON.stringify(reference) === JSON.stringify(actual);
        if (expected) {
          expect(judgeBaselineValue(item, actual).verdict).toBe('通过');
        }
        expect(judgeBaselineValue(item, reference).verdict).toBe('通过');
        expect(jsonEqual(reference, actual)).toBe(jsonEqual(actual, reference));
      }),
      pbtParams
    );
  });
});

describe.each(taskIds)('evals/modeling/%s as read by the runner', (taskId) => {
  it('parses task.yaml, checks.yaml and baseline.json', () => {
    const { config, checks, baseline } = loadTask(taskId);
    expect(config.id).toBe(taskId);
    expect(checks.length).toBeGreaterThanOrEqual(5);
    expect(baseline.length).toBeGreaterThan(0);
    const exampleDir = path.join(repoRoot, ...config.example.split('/'));
    for (const input of config.inputs) {
      expect(fs.existsSync(path.join(exampleDir, ...input.split('/'))), input).toBe(true);
    }
  });

  it('passes every automatic check when the outputs match the reference values', () => {
    const { config, checks, baseline } = loadTask(taskId);
    const values = Object.fromEntries(
      baseline.filter((item) => item.value !== null).map((item) => [item.key, item.value])
    );
    const paths = Object.fromEntries(
      pathsToInspect(checks, config.outputs.paper).map((file) => [file, 'present' as const])
    );
    const outcomes = judgeChecks(checks, baseline, facts(values, paths));
    for (const outcome of outcomes) {
      expect(outcome.verdict, outcome.id).toBe(outcome.method === 'manual' ? '待人工' : '通过');
    }
  });

  it('fails the baseline checks whose values move outside their tolerance', () => {
    const { checks, baseline } = loadTask(taskId);
    for (const item of baseline) {
      if (item.tolerance === null || typeof item.value !== 'number') {
        continue;
      }
      const moved =
        item.tolerance.mode === 'range'
          ? item.tolerance.max + 1
          : item.value + (item.tolerance.mode === 'abs' ? item.tolerance.value : 0) + 1;
      const values = Object.fromEntries(
        baseline
          .filter((other) => other.value !== null)
          .map((other) => [other.key, other.key === item.key ? moved : other.value])
      );
      const outcomes = judgeChecks(checks, baseline, facts(values));
      for (const check of checks) {
        if (check.method === 'baseline' && check.keys.includes(item.key)) {
          const outcome = outcomes.find((candidate) => candidate.id === check.id);
          expect(outcome?.verdict, `${check.id} with ${item.key} = ${moved}`).toBe('未通过');
        }
      }
    }
  });
});
