import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Manual review records of the modeling evaluation (evals/modeling/README.md, requirement 23.2).
 * The runner judges the `file` and `baseline` checks and leaves the `manual` ones 待人工; a person
 * then writes results/<stamp>.manual-review.json with a verdict (通过 or 未通过) and evidence for
 * every 待人工 check of one model, next to a readable .md. The result file is never edited. This
 * test checks each review against its result file and recomputes the counts it declares:
 * automatic counts come from the result file, manual counts from the review, and a task that did
 * not complete passes none of its checks (requirement 23.7).
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const resultsDir = path.join(repoRoot, 'evals', 'modeling', 'results');
const REVIEW_SUFFIX = '.manual-review.json';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

type RunVerdict = '通过' | '未通过' | '待人工';

interface RunCheck {
  id: string;
  question: string;
  verdict: RunVerdict;
}

interface RunTask {
  id: string;
  total: number;
  model: string;
  status: string;
  checks: RunCheck[];
}

interface RunFile {
  commit: string | null;
  models: string[];
  tasks: RunTask[];
}

interface Counts {
  passed: number;
  failed: number;
}

interface ReviewSummary {
  automatic: Counts;
  manual: Counts;
  passed: number;
  failed: number;
  pending: number;
  total: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isNonEmptyStringList(value: unknown): value is string[] {
  return isStringList(value) && value.length > 0;
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** The counts a review must declare for `task`, given the verdicts it records. */
function expectedSummary(task: RunTask, judged: ReadonlyMap<string, string>): ReviewSummary {
  if (task.status !== '完成') {
    return {
      automatic: { passed: 0, failed: 0 },
      manual: { passed: 0, failed: 0 },
      passed: 0,
      failed: task.total,
      pending: 0,
      total: task.total,
    };
  }
  const automatic = { passed: 0, failed: 0 };
  const manual = { passed: 0, failed: 0 };
  let pending = 0;
  for (const check of task.checks) {
    if (check.verdict === '待人工') {
      const verdict = judged.get(check.id);
      if (verdict === '通过') {
        manual.passed += 1;
      } else if (verdict === '未通过') {
        manual.failed += 1;
      } else {
        pending += 1;
      }
    } else if (check.verdict === '通过') {
      automatic.passed += 1;
    } else {
      automatic.failed += 1;
    }
  }
  return {
    automatic,
    manual,
    passed: automatic.passed + manual.passed,
    failed: automatic.failed + manual.failed,
    pending,
    total: task.total,
  };
}

function addSummaries(summaries: readonly ReviewSummary[]): ReviewSummary {
  const total: ReviewSummary = {
    automatic: { passed: 0, failed: 0 },
    manual: { passed: 0, failed: 0 },
    passed: 0,
    failed: 0,
    pending: 0,
    total: 0,
  };
  for (const item of summaries) {
    total.automatic.passed += item.automatic.passed;
    total.automatic.failed += item.automatic.failed;
    total.manual.passed += item.manual.passed;
    total.manual.failed += item.manual.failed;
    total.passed += item.passed;
    total.failed += item.failed;
    total.pending += item.pending;
    total.total += item.total;
  }
  return total;
}

function sameCounts(declared: unknown, expected: Counts): boolean {
  return isRecord(declared) && declared.passed === expected.passed && declared.failed === expected.failed;
}

function sameSummary(declared: unknown, expected: ReviewSummary): boolean {
  return (
    isRecord(declared) &&
    sameCounts(declared.automatic, expected.automatic) &&
    sameCounts(declared.manual, expected.manual) &&
    declared.passed === expected.passed &&
    declared.failed === expected.failed &&
    declared.pending === expected.pending &&
    declared.total === expected.total
  );
}

/** Problems of one judged check, prefixed with `where`. */
function checkProblems(check: Record<string, unknown>, where: string): string[] {
  const problems: string[] = [];
  if (!isNonEmptyString(check.criterion)) problems.push(`${where}: criterion is missing`);
  if (check.verdict !== '通过' && check.verdict !== '未通过') {
    problems.push(`${where}: verdict must be 通过 or 未通过`);
  }
  if (!isNonEmptyStringList(check.evidence)) problems.push(`${where}: evidence is missing`);
  if (check.verdict === '未通过' && !isNonEmptyStringList(check.failures)) {
    problems.push(`${where}: a check judged 未通过 must list its failures`);
  }
  if (check.verdict === '通过' && check.failures !== undefined) {
    problems.push(`${where}: a check judged 通过 has no failures`);
  }
  for (const key of ['recomputed', 'defects']) {
    if (check[key] !== undefined && !isStringList(check[key])) {
      problems.push(`${where}: ${key} must be a list of strings`);
    }
  }
  if (check.borderline !== undefined && typeof check.borderline !== 'boolean') {
    problems.push(`${where}: borderline must be true or false`);
  }
  if (check.note !== undefined && !isNonEmptyString(check.note)) {
    problems.push(`${where}: note must be a non-empty string`);
  }
  return problems;
}

/** Problems of the task entries; returns the counts each task should declare. */
function taskProblems(
  entries: unknown[],
  runTasks: readonly RunTask[],
  problems: string[]
): ReviewSummary[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    const id = isRecord(entry) ? entry.id : undefined;
    if (!isRecord(entry) || !isNonEmptyString(id)) {
      problems.push('every task entry needs an id');
    } else if (byId.has(id)) {
      problems.push(`task ${id} is listed twice`);
    } else {
      byId.set(id, entry);
    }
  }
  for (const id of byId.keys()) {
    if (!runTasks.some((task) => task.id === id)) problems.push(`task ${id} is not in the run`);
  }

  return runTasks.map((task) => {
    const entry = byId.get(task.id);
    const judged = new Map<string, string>();
    if (entry === undefined) {
      problems.push(`task ${task.id} is missing`);
      return expectedSummary(task, judged);
    }
    const checks: unknown[] = Array.isArray(entry.checks) ? entry.checks : [];
    if (!Array.isArray(entry.checks)) problems.push(`${task.id}: checks must be a list`);
    const pending = task.status === '完成' ? task.checks.filter((c) => c.verdict === '待人工') : [];
    for (const check of checks) {
      const id = isRecord(check) ? check.id : undefined;
      if (!isRecord(check) || !isNonEmptyString(id)) {
        problems.push(`${task.id}: every check needs an id`);
        continue;
      }
      const where = `${task.id} ${id}`;
      const inRun = pending.find((candidate) => candidate.id === id);
      if (judged.has(id)) {
        problems.push(`${where}: judged twice`);
      } else if (inRun === undefined) {
        problems.push(`${where}: only 待人工 checks of a completed task can be judged`);
      } else {
        if (check.question !== inRun.question) {
          problems.push(`${where}: question differs from the run`);
        }
        problems.push(...checkProblems(check, where));
        judged.set(id, String(check.verdict));
      }
    }
    for (const check of pending) {
      if (!judged.has(check.id)) problems.push(`${task.id} ${check.id}: 待人工 check is not judged`);
    }
    const expected = expectedSummary(task, judged);
    if (!sameSummary(entry.summary, expected)) {
      problems.push(`${task.id}: summary should be ${JSON.stringify(expected)}`);
    }
    return expected;
  });
}

/** Every problem of a review record, one line each; empty when it matches its result file. */
function reviewProblems(review: unknown, run: RunFile, resultSha256: string): string[] {
  if (!isRecord(review)) {
    return ['the review is not a JSON object'];
  }
  const problems: string[] = [];
  if (review.schemaVersion !== 1) problems.push('schemaVersion must be 1');
  if (review.resultSha256 !== resultSha256) problems.push('resultSha256 differs from the result file');
  if (run.commit === null || review.commit !== run.commit) {
    problems.push('commit must be the traceable commit of the result file');
  }
  if (typeof review.model !== 'string' || !run.models.includes(review.model)) {
    problems.push('model must be one of the models of the run');
  }
  if (!isNonEmptyString(review.reviewer)) problems.push('reviewer is missing');
  if (typeof review.reviewedAt !== 'string' || !ISO_WITH_ZONE.test(review.reviewedAt)) {
    problems.push('reviewedAt must be an ISO 8601 date-time with a time zone');
  }
  if (typeof review.signedOff !== 'boolean') problems.push('signedOff must be true or false');
  if (review.signedOff === true) {
    if (!isNonEmptyString(review.signedOffBy)) problems.push('signedOffBy is missing');
    if (typeof review.signedOffAt !== 'string' || !ISO_WITH_ZONE.test(review.signedOffAt)) {
      problems.push('signedOffAt must be an ISO 8601 date-time with a time zone');
    }
  }
  const artifact = review.artifact;
  const isFile = (file: unknown) =>
    isRecord(file) && isNonEmptyString(file.path) && SHA256_PATTERN.test(String(file.sha256));
  if (
    !isRecord(artifact) ||
    (artifact.digest !== undefined && !DIGEST_PATTERN.test(String(artifact.digest))) ||
    !Array.isArray(artifact.files) ||
    artifact.files.length === 0 ||
    !artifact.files.every(isFile)
  ) {
    problems.push('artifact must list the reviewed files with their sha256');
  }
  if (!isNonEmptyStringList(review.method)) problems.push('method must say how the review was done');
  if (!isNonEmptyString(review.standard)) problems.push('standard is missing');
  if (!isNonEmptyString(review.conclusion)) problems.push('conclusion is missing');

  const model = review.model;
  const runTasks = run.tasks.filter((task) => task.model === model);
  const entries: unknown[] = Array.isArray(review.tasks) ? review.tasks : [];
  if (!Array.isArray(review.tasks)) problems.push('tasks must be a list');
  const summaries = taskProblems(entries, runTasks, problems);
  const expected = addSummaries(summaries);
  if (!sameSummary(review.summary, expected)) {
    problems.push(`summary should be ${JSON.stringify(expected)}`);
  }
  return problems;
}

const reviewFiles = fs
  .readdirSync(resultsDir)
  .filter((name) => name.endsWith(REVIEW_SUFFIX))
  .sort();

describe('manual review records (evals/modeling/results)', () => {
  it('records the review of the first evaluation run', () => {
    expect(reviewFiles).toContain(`20260930T173512Z${REVIEW_SUFFIX}`);
  });

  describe.each(reviewFiles)('%s', (name) => {
    const review = JSON.parse(fs.readFileSync(path.join(resultsDir, name), 'utf8')) as Record<
      string,
      unknown
    >;
    const resultFile = String(review.resultFile);

    it('names a result file next to it', () => {
      expect(resultFile).toBe(`evals/modeling/results/${name.slice(0, -REVIEW_SUFFIX.length)}.json`);
      expect(fs.existsSync(path.join(repoRoot, ...resultFile.split('/')))).toBe(true);
    });

    it('judges every 待人工 check with evidence and declares the counts that follow', () => {
      const content = fs.readFileSync(path.join(repoRoot, ...resultFile.split('/')));
      const run = JSON.parse(content.toString('utf8')) as RunFile;
      expect(reviewProblems(review, run, sha256(content))).toEqual([]);
      const summary = review.summary as ReviewSummary;
      expect(summary.pending).toBe(0);
      expect(summary.passed + summary.failed).toBe(summary.total);
    });

    it('has a readable copy with the same result file and totals', () => {
      const readable = path.join(resultsDir, `${name.slice(0, -'.json'.length)}.md`);
      expect(fs.existsSync(readable)).toBe(true);
      const text = fs.readFileSync(readable, 'utf8');
      const summary = review.summary as ReviewSummary;
      expect(text).toContain(String(review.resultSha256));
      expect(text).toContain(`${summary.passed}/${summary.total}`);
    });
  });
});

describe('manual review validation', () => {
  const run: RunFile = {
    commit: 'c'.repeat(40),
    models: ['p/m'],
    tasks: [
      {
        id: 'a',
        total: 3,
        model: 'p/m',
        status: '完成',
        checks: [
          { id: 'C01', question: '全题', verdict: '通过' },
          { id: 'C02', question: '问题一', verdict: '待人工' },
          { id: 'C03', question: '问题二', verdict: '待人工' },
        ],
      },
      { id: 'b', total: 2, model: 'p/m', status: '失败', checks: [] },
    ],
  };
  const sha = 'f'.repeat(64);

  function valid(): Record<string, unknown> {
    return {
      schemaVersion: 1,
      resultFile: 'evals/modeling/results/x.json',
      resultSha256: sha,
      commit: 'c'.repeat(40),
      model: 'p/m',
      artifact: { digest: `sha256:${'a'.repeat(64)}`, files: [{ path: 'a/paper.tex', sha256: 'b'.repeat(64) }] },
      reviewer: '复核人',
      signedOff: false,
      reviewedAt: '2026-10-01T15:00:00+08:00',
      method: ['逐项阅读论文'],
      standard: '要素齐全才判通过',
      tasks: [
        {
          id: 'a',
          checks: [
            { id: 'C02', question: '问题一', criterion: '要素', verdict: '通过', evidence: ['tex:1'] },
            {
              id: 'C03',
              question: '问题二',
              criterion: '要素',
              verdict: '未通过',
              evidence: ['tex:2'],
              failures: ['缺少约束'],
            },
          ],
          summary: {
            automatic: { passed: 1, failed: 0 },
            manual: { passed: 1, failed: 1 },
            passed: 2,
            failed: 1,
            pending: 0,
            total: 3,
          },
        },
        {
          id: 'b',
          checks: [],
          summary: {
            automatic: { passed: 0, failed: 0 },
            manual: { passed: 0, failed: 0 },
            passed: 0,
            failed: 2,
            pending: 0,
            total: 2,
          },
        },
      ],
      summary: {
        automatic: { passed: 1, failed: 0 },
        manual: { passed: 1, failed: 1 },
        passed: 2,
        failed: 3,
        pending: 0,
        total: 5,
      },
      conclusion: '全部检查项都有结论',
    };
  }

  /** A copy of the valid review with the first check of task `a` replaced. */
  function withCheck(patch: Record<string, unknown> | null): Record<string, unknown> {
    const review = valid();
    const [first, second] = review.tasks as Record<string, unknown>[];
    const checks = first.checks as Record<string, unknown>[];
    const replaced = patch === null ? checks.slice(1) : [{ ...checks[0], ...patch }, checks[1]];
    review.tasks = [{ ...first, checks: replaced }, second];
    return review;
  }

  it('accepts a review that judges every 待人工 check', () => {
    expect(reviewProblems(valid(), run, sha)).toEqual([]);
  });

  it('rejects a review of another result file or commit', () => {
    expect(reviewProblems(valid(), run, '0'.repeat(64))).toContain(
      'resultSha256 differs from the result file'
    );
    expect(reviewProblems({ ...valid(), commit: 'd'.repeat(40) }, run, sha)).toContain(
      'commit must be the traceable commit of the result file'
    );
    expect(reviewProblems(valid(), { ...run, commit: null }, sha)).toContain(
      'commit must be the traceable commit of the result file'
    );
  });

  it('requires a verdict for every 待人工 check and none for automatic checks', () => {
    expect(reviewProblems(withCheck(null), run, sha)).toContain('a C02: 待人工 check is not judged');
    expect(reviewProblems(withCheck({ id: 'C01', question: '全题' }), run, sha)).toContain(
      'a C01: only 待人工 checks of a completed task can be judged'
    );
    expect(reviewProblems(withCheck({ verdict: '待人工' }), run, sha)).toContain(
      'a C02: verdict must be 通过 or 未通过'
    );
    expect(reviewProblems(withCheck({ question: '问题三' }), run, sha)).toContain(
      'a C02: question differs from the run'
    );
  });

  it('requires evidence, and failures exactly for checks judged 未通过', () => {
    expect(reviewProblems(withCheck({ evidence: [] }), run, sha)).toContain(
      'a C02: evidence is missing'
    );
    expect(reviewProblems(withCheck({ failures: ['x'] }), run, sha)).toContain(
      'a C02: a check judged 通过 has no failures'
    );
    const problems = reviewProblems(withCheck({ verdict: '未通过' }), run, sha);
    expect(problems).toContain('a C02: a check judged 未通过 must list its failures');
    // The declared counts no longer match either.
    expect(problems.some((line) => line.startsWith('a: summary should be'))).toBe(true);
    expect(problems.some((line) => line.startsWith('summary should be'))).toBe(true);
  });

  it('counts a task that did not complete as passing none of its checks', () => {
    const review = valid();
    const [first, second] = review.tasks as Record<string, unknown>[];
    review.tasks = [first, { ...second, summary: { ...(second.summary as object), failed: 0 } }];
    expect(reviewProblems(review, run, sha)).toContain(
      `b: summary should be ${JSON.stringify({
        automatic: { passed: 0, failed: 0 },
        manual: { passed: 0, failed: 0 },
        passed: 0,
        failed: 2,
        pending: 0,
        total: 2,
      })}`
    );
  });

  it('requires the reviewer, a zoned review time and the sign-off fields once signed off', () => {
    const problems = reviewProblems(
      { ...valid(), reviewer: ' ', reviewedAt: '2026-10-01 15:00', signedOff: true },
      run,
      sha
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        'reviewer is missing',
        'reviewedAt must be an ISO 8601 date-time with a time zone',
        'signedOffBy is missing',
        'signedOffAt must be an ISO 8601 date-time with a time zone',
      ])
    );
  });
});
