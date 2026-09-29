/**
 * Modeling evaluation suite (spec mathmodel-parity-and-beyond, requirement 23.2, 23.7, 23.8):
 * per-task results, the run summary, and the token budget gate that decides whether another task
 * may start.
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
