/**
 * Modeling evaluation suite (spec mathmodel-parity-and-beyond, requirement 23.2, 23.5–23.8):
 * per-task results, the run summary, the token budget gate that decides whether another task
 * may start, and the result file the runner writes.
 *
 * Pure functions without imports. The evaluation runner (evals/modeling/run.mts) runs this file
 * directly under Node's type stripping, so it may only use erasable TypeScript syntax: no enums,
 * namespaces, parameter properties or runtime imports of other local modules.
 */

export type EvalTaskStatus = '完成' | '失败' | '已中止';

/** Why a task failed (requirement 23.7). */
export type EvalFailure = '模型调用失败' | '超时';

export interface EvalTaskResult {
  /** Task directory name under `evals/modeling/`. */
  id: string;
  /** Checks judged 通过. Only counts for tasks with status 完成. */
  passed: number;
  /** Checks listed in the task's `checks.yaml`. */
  total: number;
  /** Whether the paper compiled to a PDF. */
  compiled: boolean;
  /** Wall-clock duration in seconds. */
  seconds: number;
  tokensIn: number;
  tokensOut: number;
  /** Model identifier the task ran with. */
  model: string;
  status: EvalTaskStatus;
  /** Only present when status is 失败. */
  failure?: EvalFailure;
}

export interface EvalSummary {
  /** Checks judged 通过 across all tasks; tasks that did not complete contribute 0. */
  passed: number;
  seconds: number;
  /** Input plus output tokens. */
  tokens: number;
}

/** The result file `evals/modeling/results/<timestamp>.json` (requirement 23.5, 23.6). */
export interface EvalResult {
  /** ISO 8601 date-time the run started. */
  startedAt: string;
  /** Source commit from the kernel's Build_Manifest; `null` when it could not be read. */
  commit: string | null;
  dirty: boolean | null;
  /** `false` when the Build_Manifest could not be read (不可追溯). */
  traceable: boolean;
  tasks: EvalTaskResult[];
  summary: EvalSummary;
}

/** A task the runner intends to run, in run order. */
export interface EvalTaskSpec {
  id: string;
  /** Number of checks in the task's `checks.yaml`. */
  total: number;
  model: string;
}

export type BudgetDecision = 'continue' | 'stop';

/**
 * Whether another model call may start once `used` tokens are spent against the confirmed
 * budget `limit` (requirement 23.8). Reaching the limit stops; so does an unknown (NaN) usage or
 * limit, because every comparison with NaN is false.
 */
export function budgetGate(used: number, limit: number): BudgetDecision {
  return used < limit ? 'continue' : 'stop';
}

export function taskTokens(task: Pick<EvalTaskResult, 'tokensIn' | 'tokensOut'>): number {
  return task.tokensIn + task.tokensOut;
}

/** Input plus output tokens of every task so far. */
export function tokensUsed(tasks: readonly EvalTaskResult[]): number {
  let total = 0;
  for (const task of tasks) {
    total += taskTokens(task);
  }
  return total;
}

/**
 * The result as it is written to the result file: a task that failed or was aborted passes no
 * checks (requirement 23.7), and only a failed task keeps its failure reason.
 */
export function normalizeTask(task: EvalTaskResult): EvalTaskResult {
  const { failure, ...rest } = task;
  if (task.status === '完成') {
    return { ...rest };
  }
  if (task.status === '失败' && failure !== undefined) {
    return { ...rest, passed: 0, failure };
  }
  return { ...rest, passed: 0 };
}

/**
 * Sums the per-task values (requirement 23.2). Tasks that did not complete count 0 passed checks
 * whatever their record says; their time and tokens were still spent and are counted.
 */
export function aggregate(tasks: readonly EvalTaskResult[]): EvalSummary {
  let passed = 0;
  let seconds = 0;
  let tokens = 0;
  for (const task of tasks) {
    passed += task.status === '完成' ? task.passed : 0;
    seconds += task.seconds;
    tokens += taskTokens(task);
  }
  return { passed, seconds, tokens };
}

/** Placeholder for a task that never started because the budget ran out (requirement 23.8). */
export function abortedTask(spec: EvalTaskSpec): EvalTaskResult {
  return {
    id: spec.id,
    passed: 0,
    total: spec.total,
    compiled: false,
    seconds: 0,
    tokensIn: 0,
    tokensOut: 0,
    model: spec.model,
    status: '已中止',
  };
}

/**
 * The task to start next, or `null` when every task has run or the budget is spent. `results`
 * holds the results of the tasks already run, in `specs` order. The runner loops until `null`:
 *
 *   for (let spec = nextTask(specs, results, limit); spec; spec = nextTask(specs, results, limit))
 *     results.push(await run(spec));
 */
export function nextTask(
  specs: readonly EvalTaskSpec[],
  results: readonly EvalTaskResult[],
  limit: number
): EvalTaskSpec | null {
  if (results.length >= specs.length) {
    return null;
  }
  return budgetGate(tokensUsed(results), limit) === 'continue' ? specs[results.length] : null;
}

/**
 * Every task of the run, in `specs` order: the results of the tasks that ran, normalized, then
 * 已中止 for the tasks that never started. Results beyond `specs` are ignored.
 */
export function finalizeTasks(
  specs: readonly EvalTaskSpec[],
  results: readonly EvalTaskResult[]
): EvalTaskResult[] {
  const ran = results.slice(0, specs.length).map(normalizeTask);
  const aborted = specs.slice(ran.length).map(abortedTask);
  return [...ran, ...aborted];
}

// ---------------------------------------------------------------------------------------------
// The result file written by evals/modeling/run.mts (task 28.4, 28.5). It is an EvalResult with
// per-check verdicts, the budget and the learning-mode samples added.
// ---------------------------------------------------------------------------------------------

/**
 * Where the token counts of a run came from:
 * - `output`: the metadata goose prints with `--output-format json`, which includes subagents;
 * - `session`: the session record (`goose session list --format json`), used when goose was
 *   stopped before it printed its output or the output could not be parsed;
 * - `unknown`: neither could be read. The counts are NaN (null in the file), so the budget gate
 *   stops every later call;
 * - `none`: the run never started.
 */
export type TokenSource = 'output' | 'session' | 'unknown' | 'none';

export type CheckMethod = 'file' | 'baseline' | 'manual';

/** 待人工: judged by a person reading the paper; counts as not passed until then. */
export type CheckVerdict = '通过' | '未通过' | '待人工';

export interface EvalCheckOutcome {
  id: string;
  question: string;
  method: CheckMethod;
  verdict: CheckVerdict;
  /** Why the check did not pass, or why it cannot be judged automatically. */
  reason?: string;
}

/** What the runner recorded about a task it started, besides its EvalTaskResult. */
export interface EvalTaskDetail {
  /** Verdicts of every check; only kept for tasks that completed. */
  checks: EvalCheckOutcome[];
  tokenSource: TokenSource;
  /** Short description of why the task failed or was stopped. */
  detail?: string;
}

export interface EvalTaskReport extends EvalTaskResult {
  checks: EvalCheckOutcome[];
  /** Checks waiting for a person (待人工). `passed` does not include them. */
  pendingReview: number;
  tokenSource: TokenSource;
  detail?: string;
}

/**
 * One learning-mode sample (requirement 20.3, task 28.5). Reported for manual review only: the
 * flags never change `passed` or the summary.
 */
export interface LearningSampleReport {
  id: string;
  exerciseId: string;
  /** What the simulated student asks for. */
  scenario: string;
  model: string;
  status: EvalTaskStatus;
  failure?: EvalFailure;
  seconds: number;
  tokensIn: number;
  tokensOut: number;
  tokenSource: TokenSource;
  /** The reply looks like it contains complete solution code. */
  suspectedFullSolution: boolean;
  /** The reply gives neither a hint nor a follow-up question. */
  missingHintOrQuestion: boolean;
  /** Why the reply was or was not flagged. */
  reasons: string[];
  /** Text of the assistant's reply, cut to a fixed length. */
  reply: string;
  replyTruncated: boolean;
  detail?: string;
}

export interface EvalProvenance {
  commit: string | null;
  dirty: boolean | null;
  traceable: boolean;
  /** Why the result is 不可追溯; only present when `traceable` is false. */
  reason?: string;
}

export interface EvalBudget {
  /** Token budget the maintainer confirmed. */
  limit: number;
  /** Input plus output tokens of every task and learning sample; NaN (null) when unknown. */
  used: number;
  /** The budget stopped the run, or the usage became unknown. */
  exhausted: boolean;
}

export interface EvalRunFile extends EvalResult {
  schemaVersion: 1;
  finishedAt: string;
  /** A rehearsal that called neither goose nor any model. */
  dryRun: boolean;
  /** Model identifiers shown in the confirmation, in run order. */
  models: string[];
  budget: EvalBudget;
  /** The maintainer interrupted the run (Ctrl+C). */
  interrupted: boolean;
  untraceableReason?: string;
  tasks: EvalTaskReport[];
  learningSamples: LearningSampleReport[];
}

export interface EvalRunInput {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  models: readonly string[];
  limit: number;
  interrupted: boolean;
  provenance: EvalProvenance;
  specs: readonly EvalTaskSpec[];
  /** Results of the tasks that started, in `specs` order. */
  results: readonly EvalTaskResult[];
  /** `details[i]` belongs to `results[i]`. */
  details: readonly EvalTaskDetail[];
  learningSamples: readonly LearningSampleReport[];
}

export function learningTokens(samples: readonly LearningSampleReport[]): number {
  let total = 0;
  for (const sample of samples) {
    total += sample.tokensIn + sample.tokensOut;
  }
  return total;
}

/**
 * The tasks as written to the result file: `finalizeTasks` plus the check verdicts and token
 * source of every task that started. Check verdicts are dropped for tasks that did not complete,
 * because they pass no checks (requirement 23.7).
 */
export function buildTaskReports(
  specs: readonly EvalTaskSpec[],
  results: readonly EvalTaskResult[],
  details: readonly EvalTaskDetail[]
): EvalTaskReport[] {
  const started = Math.min(results.length, specs.length);
  return finalizeTasks(specs, results).map((task, index) => {
    const extra = index < started ? details[index] : undefined;
    if (extra === undefined) {
      const tokenSource: TokenSource = index < started ? 'unknown' : 'none';
      return { ...task, checks: [], pendingReview: 0, tokenSource };
    }
    const checks = task.status === '完成' ? extra.checks.map((check) => ({ ...check })) : [];
    const report: EvalTaskReport = {
      ...task,
      checks,
      pendingReview: checks.filter((check) => check.verdict === '待人工').length,
      tokenSource: extra.tokenSource,
    };
    return extra.detail === undefined ? report : { ...report, detail: extra.detail };
  });
}

/** Assembles the result file (requirement 23.2, 23.5, 23.6, 23.8). */
export function buildRunFile(input: EvalRunInput): EvalRunFile {
  const tasks = buildTaskReports(input.specs, input.results, input.details);
  const used =
    tokensUsed(input.results.slice(0, input.specs.length)) + learningTokens(input.learningSamples);
  const file: EvalRunFile = {
    schemaVersion: 1,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    dryRun: input.dryRun,
    commit: input.provenance.traceable ? input.provenance.commit : null,
    dirty: input.provenance.traceable ? input.provenance.dirty : null,
    traceable: input.provenance.traceable,
    models: [...input.models],
    budget: { limit: input.limit, used, exhausted: budgetGate(used, input.limit) === 'stop' },
    interrupted: input.interrupted,
    tasks,
    summary: aggregate(tasks),
    learningSamples: input.learningSamples.map((sample) => ({
      ...sample,
      reasons: [...sample.reasons],
    })),
  };
  if (!input.provenance.traceable) {
    file.untraceableReason = input.provenance.reason ?? '无法读取 Build_Manifest';
  }
  return file;
}
