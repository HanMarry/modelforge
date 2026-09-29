/**
 * Reading and judging the modeling evaluation tasks in evals/modeling/ (spec
 * mathmodel-parity-and-beyond, requirement 23.1, 23.2): the `eval:` part of task.yaml, the checks
 * in checks.yaml and the reference values in baseline.json.
 *
 * The runner (evals/modeling/run.mts) parses the YAML and JSON files and passes the plain values
 * here. Pure functions; like evalSummary.ts this file runs under Node's type stripping, so it may
 * only use erasable TypeScript syntax and has no runtime imports.
 */
import type { CheckMethod, CheckVerdict, EvalCheckOutcome } from './evalSummary';

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The `eval:` part of a task.yaml. */
export interface TaskEvalConfig {
  /** Directory name under evals/modeling/. */
  id: string;
  title: string;
  category: string;
  /** Example directory, relative to the repository root. */
  example: string;
  /** Files copied from `example` into the empty working directory, relative to `example`. */
  inputs: string[];
  /** Requirement 23.7: a run longer than this is stopped and recorded as 失败 / 超时. */
  timeoutMinutes: number;
  outputs: {
    /** PDF whose presence decides `compiled`. */
    paper: string;
    /** JSON object `{ "values": { ... } }` keyed by the baseline keys. */
    values: string;
  };
  /** File names next to task.yaml. */
  checks: string;
  baseline: string;
}

interface CheckBase {
  id: string;
  question: string;
  criterion: string;
}

export type CheckDefinition =
  | (CheckBase & { method: 'file'; path: string })
  | (CheckBase & { method: 'baseline'; keys: string[] })
  | (CheckBase & { method: 'manual' });

export type Tolerance =
  | { mode: 'exact' }
  | { mode: 'abs'; value: number }
  | { mode: 'range'; min: number; max: number };

export interface BaselineValue {
  key: string;
  /** Reference value; `null` while it is pending. */
  value: unknown;
  /** `null` exactly when `value` is. */
  tolerance: Tolerance | null;
}

/** State of an output path after a run. */
export type PathState = 'present' | 'empty' | 'missing';

export interface TaskFacts {
  /** State of every `file` check path; paths not listed count as missing. */
  paths: Readonly<Record<string, PathState>>;
  /** The `values` object of the values file, or `null` when it is missing or malformed. */
  values: Readonly<Record<string, unknown>> | null;
  /** Name of the values file, for messages. */
  valuesFile: string;
}

/** Slack for comparisons of decimal numbers, so that 0.651 + 0.01 still counts as within 0.01. */
export const NUMBER_SLACK = 1e-9;

const CHECK_METHODS: readonly CheckMethod[] = ['file', 'baseline', 'manual'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function fail<T>(reason: string): Parsed<T> {
  return { ok: false, reason };
}

/**
 * A relative path with forward slashes that stays inside its base directory: no absolute paths,
 * drive letters, backslashes, empty, `.` or `..` segments.
 */
export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  if (value.includes('\\') || value.includes(':') || value.includes('\0')) {
    return false;
  }
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Reads the `eval:` part of a parsed task.yaml; `dirName` is the task's directory name. */
export function parseTaskDocument(doc: unknown, dirName: string): Parsed<TaskEvalConfig> {
  if (!isRecord(doc)) {
    return fail('task.yaml is not a mapping');
  }
  if (!isRecord(doc.recipe)) {
    return fail('task.yaml has no recipe mapping');
  }
  const ev = doc.eval;
  if (!isRecord(ev)) {
    return fail('task.yaml has no eval mapping');
  }
  if (ev.id !== dirName) {
    return fail(`eval.id must be ${dirName}`);
  }
  if (!isNonEmptyString(ev.title) || !isNonEmptyString(ev.category)) {
    return fail('eval.title and eval.category must be non-empty strings');
  }
  if (!isSafeRelativePath(ev.example)) {
    return fail('eval.example must be a relative path inside the repository');
  }
  const inputs = ev.inputs;
  if (!Array.isArray(inputs) || inputs.length === 0 || !inputs.every(isSafeRelativePath)) {
    return fail('eval.inputs must list relative paths inside the example directory');
  }
  if (new Set(inputs).size !== inputs.length) {
    return fail('eval.inputs lists a path more than once');
  }
  const timeout = ev.timeoutMinutes;
  if (!isFiniteNumber(timeout) || timeout <= 0 || timeout > 60) {
    return fail('eval.timeoutMinutes must be a number in (0, 60]');
  }
  const outputs = ev.outputs;
  if (!isRecord(outputs) || !isSafeRelativePath(outputs.paper)) {
    return fail('eval.outputs.paper must be a relative path');
  }
  if (!isSafeRelativePath(outputs.values)) {
    return fail('eval.outputs.values must be a relative path');
  }
  if (!isSafeRelativePath(ev.checks) || !isSafeRelativePath(ev.baseline)) {
    return fail('eval.checks and eval.baseline must be relative paths');
  }
  return {
    ok: true,
    value: {
      id: dirName,
      title: ev.title,
      category: ev.category,
      example: ev.example,
      inputs: [...inputs],
      timeoutMinutes: timeout,
      outputs: { paper: outputs.paper, values: outputs.values },
      checks: ev.checks,
      baseline: ev.baseline,
    },
  };
}

function parseCheck(value: unknown, index: number): Parsed<CheckDefinition> {
  const where = `checks[${index}]`;
  if (!isRecord(value)) {
    return fail(`${where} is not a mapping`);
  }
  const { id, question, method, criterion } = value;
  if (!isNonEmptyString(id) || !isNonEmptyString(question) || !isNonEmptyString(criterion)) {
    return fail(`${where} needs id, question and criterion`);
  }
  if (typeof method !== 'string' || !CHECK_METHODS.includes(method as CheckMethod)) {
    return fail(`${where} (${id}): method must be one of ${CHECK_METHODS.join(', ')}`);
  }
  const base = { id, question, criterion };
  if (method === 'file') {
    if (!isSafeRelativePath(value.path)) {
      return fail(`${where} (${id}): a file check needs a relative path`);
    }
    return { ok: true, value: { ...base, method, path: value.path } };
  }
  if (method === 'baseline') {
    const keys = value.keys;
    if (!Array.isArray(keys) || keys.length === 0 || !keys.every(isNonEmptyString)) {
      return fail(`${where} (${id}): a baseline check needs a non-empty keys list`);
    }
    return { ok: true, value: { ...base, method, keys: [...keys] } };
  }
  return { ok: true, value: { ...base, method: 'manual' } };
}

/** Reads a parsed checks.yaml of task `taskId`. */
export function parseChecksDocument(doc: unknown, taskId: string): Parsed<CheckDefinition[]> {
  if (!isRecord(doc)) {
    return fail('checks.yaml is not a mapping');
  }
  if (doc.id !== taskId) {
    return fail(`checks.yaml id must be ${taskId}`);
  }
  if (!Array.isArray(doc.checks) || doc.checks.length === 0) {
    return fail('checks.yaml must list at least one check');
  }
  const checks: CheckDefinition[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of doc.checks.entries()) {
    const parsed = parseCheck(entry, index);
    if (!parsed.ok) {
      return parsed;
    }
    if (seen.has(parsed.value.id)) {
      return fail(`check ${parsed.value.id} is listed more than once`);
    }
    seen.add(parsed.value.id);
    checks.push(parsed.value);
  }
  return { ok: true, value: checks };
}

function parseTolerance(value: unknown): Tolerance | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  switch (value.mode) {
    case 'exact':
      return { mode: 'exact' };
    case 'abs':
      return isFiniteNumber(value.value) && value.value >= 0
        ? { mode: 'abs', value: value.value }
        : undefined;
    case 'range':
      return isFiniteNumber(value.min) && isFiniteNumber(value.max) && value.min <= value.max
        ? { mode: 'range', min: value.min, max: value.max }
        : undefined;
    default:
      return undefined;
  }
}

/** Reads a parsed baseline.json of task `taskId`. */
export function parseBaselineDocument(doc: unknown, taskId: string): Parsed<BaselineValue[]> {
  if (!isRecord(doc)) {
    return fail('baseline.json is not an object');
  }
  if (doc.id !== taskId) {
    return fail(`baseline.json id must be ${taskId}`);
  }
  if (!Array.isArray(doc.values)) {
    return fail('baseline.json values must be an array');
  }
  const values: BaselineValue[] = [];
  const seen = new Set<string>();
  for (const [index, item] of doc.values.entries()) {
    if (!isRecord(item) || !isNonEmptyString(item.key)) {
      return fail(`values[${index}] needs a key`);
    }
    const key = item.key;
    if (seen.has(key)) {
      return fail(`values: ${key} is listed more than once`);
    }
    seen.add(key);
    const tolerance = parseTolerance(item.tolerance);
    if (tolerance === undefined) {
      return fail(`values: ${key} has an invalid tolerance`);
    }
    const value = item.value === undefined ? null : item.value;
    if ((value === null) !== (tolerance === null)) {
      return fail(`values: ${key} must have both a value and a tolerance, or neither`);
    }
    values.push({ key, value, tolerance });
  }
  return { ok: true, value: values };
}

/** The `values` object of a parsed results.json, or `null` when it has none. */
export function extractReportedValues(parsed: unknown): Record<string, unknown> | null {
  return isRecord(parsed) && isRecord(parsed.values) ? parsed.values : null;
}

/** Equality of JSON values: arrays element by element, objects with the same keys. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => jsonEqual(item, b[index]))
    );
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
    );
  }
  return false;
}

function show(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) {
    return String(value);
  }
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function withinAbs(actual: unknown, reference: number, tolerance: number): boolean {
  return isFiniteNumber(actual) && Math.abs(actual - reference) <= tolerance + NUMBER_SLACK;
}

export interface ValueJudgement {
  verdict: CheckVerdict;
  reason?: string;
}

/** Compares one reported value with its reference value (baseline.json `conventions`). */
export function judgeBaselineValue(reference: BaselineValue, actual: unknown): ValueJudgement {
  const { key, value, tolerance } = reference;
  if (value === null || tolerance === null) {
    return { verdict: '待人工', reason: `${key} 的基线值待定` };
  }
  if (actual === undefined) {
    return { verdict: '未通过', reason: `缺少 ${key}` };
  }
  if (actual === null) {
    return { verdict: '未通过', reason: `${key} 为 null` };
  }
  switch (tolerance.mode) {
    case 'exact':
      return jsonEqual(value, actual)
        ? { verdict: '通过' }
        : { verdict: '未通过', reason: `${key} 为 ${show(actual)}，参考值为 ${show(value)}` };
    case 'abs': {
      const limit = tolerance.value;
      if (isFiniteNumber(value)) {
        return withinAbs(actual, value, limit)
          ? { verdict: '通过' }
          : {
              verdict: '未通过',
              reason: `${key} 为 ${show(actual)}，与参考值 ${value} 相差超过 ${limit}`,
            };
      }
      if (!isRecord(value)) {
        return { verdict: '待人工', reason: `${key} 的参考值不是数值或数值表` };
      }
      if (!isRecord(actual)) {
        return { verdict: '未通过', reason: `${key} 应为对象，实际为 ${show(actual)}` };
      }
      const off = Object.keys(value).filter((field) => {
        const expected = value[field];
        return !isFiniteNumber(expected) || !withinAbs(actual[field], expected, limit);
      });
      return off.length === 0
        ? { verdict: '通过' }
        : {
            verdict: '未通过',
            reason: `${key} 中 ${off.join('、')} 缺失或与参考值相差超过 ${limit}`,
          };
    }
    case 'range':
      return isFiniteNumber(actual) &&
        actual >= tolerance.min - NUMBER_SLACK &&
        actual <= tolerance.max + NUMBER_SLACK
        ? { verdict: '通过' }
        : {
            verdict: '未通过',
            reason: `${key} 为 ${show(actual)}，不在 [${tolerance.min}, ${tolerance.max}] 内`,
          };
  }
}

function judgeBaselineCheck(
  keys: readonly string[],
  baseline: readonly BaselineValue[],
  facts: TaskFacts
): ValueJudgement {
  if (facts.values === null) {
    return {
      verdict: '未通过',
      reason: `${facts.valuesFile} 缺失，或不是 {"values": {...}} 格式的 JSON`,
    };
  }
  const values = facts.values;
  const failed: string[] = [];
  const pending: string[] = [];
  for (const key of keys) {
    const reference = baseline.find((item) => item.key === key);
    const judgement =
      reference === undefined
        ? { verdict: '待人工' as const, reason: `基线中没有 ${key}` }
        : judgeBaselineValue(reference, Object.hasOwn(values, key) ? values[key] : undefined);
    if (judgement.verdict === '未通过') {
      failed.push(judgement.reason ?? key);
    } else if (judgement.verdict === '待人工') {
      pending.push(judgement.reason ?? key);
    }
  }
  if (failed.length > 0) {
    return { verdict: '未通过', reason: failed.join('；') };
  }
  if (pending.length > 0) {
    return { verdict: '待人工', reason: pending.join('；') };
  }
  return { verdict: '通过' };
}

function judgeCheck(
  check: CheckDefinition,
  baseline: readonly BaselineValue[],
  facts: TaskFacts
): ValueJudgement {
  switch (check.method) {
    case 'file': {
      const state = Object.hasOwn(facts.paths, check.path) ? facts.paths[check.path] : 'missing';
      if (state === 'present') {
        return { verdict: '通过' };
      }
      return { verdict: '未通过', reason: `${check.path} ${state === 'empty' ? '为空' : '不存在'}` };
    }
    case 'baseline':
      return judgeBaselineCheck(check.keys, baseline, facts);
    case 'manual':
      return { verdict: '待人工' };
  }
}

/**
 * Verdicts of a completed task's checks, in checks.yaml order. `file` and `baseline` checks are
 * judged here; `manual` checks are left 待人工 for a person reading the paper.
 */
export function judgeChecks(
  checks: readonly CheckDefinition[],
  baseline: readonly BaselineValue[],
  facts: TaskFacts
): EvalCheckOutcome[] {
  return checks.map((check) => {
    const head = { id: check.id, question: check.question, method: check.method };
    const judgement = judgeCheck(check, baseline, facts);
    return judgement.reason === undefined
      ? { ...head, verdict: judgement.verdict }
      : { ...head, verdict: judgement.verdict, reason: judgement.reason };
  });
}

export function countVerdicts(outcomes: readonly EvalCheckOutcome[], verdict: CheckVerdict): number {
  return outcomes.filter((outcome) => outcome.verdict === verdict).length;
}

/** Paths the runner has to inspect after a run: the `file` checks and the paper. */
export function pathsToInspect(checks: readonly CheckDefinition[], paper: string): string[] {
  const paths = checks.flatMap((check) => (check.method === 'file' ? [check.path] : []));
  return [...new Set([...paths, paper])];
}
