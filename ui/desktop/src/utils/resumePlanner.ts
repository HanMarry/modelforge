/**
 * Task plans and resume planning (spec mathmodel-parity-and-beyond, requirement 22.2, 22.5):
 * reads and writes `.modelforge/tasks/<taskId>.json`, and decides which steps of an interrupted
 * task can be skipped. This is the only implementation of the skip rule; the kernel starts from
 * the `resumeFrom` computed here (task 25.4).
 *
 * Pure functions with erasable TypeScript syntax only.
 */

import type { FileHashSnapshot, RunFileHash, RunRecordMap } from '../types/runRecord';
import type {
  ParseTaskPlanResult,
  ResumeFileRole,
  ResumePlan,
  ResumeStep,
  StepId,
  StepStaleReason,
  TaskPlan,
  TaskPlanProblem,
  TaskStatus,
  TaskStep,
} from '../types/taskPlan';
import {
  FILE_HASH_MISSING,
  FILE_HASH_UNREADABLE,
  isRunId,
  isRunTimestamp,
  lineColumnAt,
  locateJsonSyntaxError,
} from './runRecord';

export const TASK_PLAN_SCHEMA_VERSION = 1;
export const TASK_STATUSES: readonly TaskStatus[] = ['执行中', '已暂停', '已完成'];

/** Top-level fields in the order `serializeTaskPlan` writes them. */
export const TASK_PLAN_FIELDS = [
  'schemaVersion',
  'taskId',
  'title',
  'status',
  'dismissed',
  'createdAt',
  'steps',
] as const;

/** `dismissed` may be absent and then reads as false; the kernel need not write it. */
export const TASK_PLAN_REQUIRED_FIELDS: readonly string[] = TASK_PLAN_FIELDS.filter(
  (field) => field !== 'dismissed'
);

/** Safe as a file name on every platform: no dot, separator or reserved character. */
const TASK_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/;

type JsonObject = Record<string, unknown>;

interface Issues {
  missing: string[];
  invalid: string[];
}

export type TaskPlanValidation =
  | { ok: true; plan: TaskPlan }
  | { ok: false; missing: string[]; invalid: string[] };

export interface TaskPlanFile {
  /** Path reported back in problems, normally `.modelforge/tasks/<taskId>.json`. */
  path: string;
  text: string;
}

export interface LoadedTaskPlans {
  /** Valid plans in input order. */
  plans: Array<{ path: string; plan: TaskPlan }>;
  /** Files that cannot be used, in input order. */
  problems: TaskPlanProblem[];
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function has(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function isTaskId(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID_PATTERN.test(value);
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

function isStepId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** File name of the plan of `taskId`, inside `.modelforge/tasks/`. */
export function taskPlanFileName(taskId: string): string {
  return `${taskId}.json`;
}

function readRunIds(value: unknown, where: string, issues: Issues): string[] | undefined {
  if (!Array.isArray(value)) {
    issues.invalid.push(where);
    return undefined;
  }
  const runIds: string[] = [];
  let complete = true;
  value.forEach((item, index) => {
    // Run ids become file names under `.modelforge/runs/`, so nothing else is accepted.
    if (isRunId(item)) {
      runIds.push(item);
    } else {
      issues.invalid.push(`${where}[${index}]`);
      complete = false;
    }
  });
  return complete ? runIds : undefined;
}

function readStep(value: unknown, where: string, issues: Issues): TaskStep | undefined {
  if (!isJsonObject(value)) {
    issues.invalid.push(where);
    return undefined;
  }
  let id: string | undefined;
  if (!has(value, 'id')) {
    issues.missing.push(`${where}.id`);
  } else if (isStepId(value.id)) {
    id = value.id;
  } else {
    issues.invalid.push(`${where}.id`);
  }
  let title: string | undefined;
  if (!has(value, 'title')) {
    issues.missing.push(`${where}.title`);
  } else if (typeof value.title === 'string') {
    title = value.title;
  } else {
    issues.invalid.push(`${where}.title`);
  }
  let runIds: string[] | undefined;
  if (!has(value, 'runIds')) {
    issues.missing.push(`${where}.runIds`);
  } else {
    runIds = readRunIds(value.runIds, `${where}.runIds`, issues);
  }
  return id !== undefined && title !== undefined && runIds !== undefined
    ? { id, title, runIds }
    : undefined;
}

function readSteps(value: unknown, issues: Issues): TaskStep[] | undefined {
  if (!Array.isArray(value)) {
    issues.invalid.push('steps');
    return undefined;
  }
  const steps: TaskStep[] = [];
  const seen = new Set<string>();
  let complete = true;
  value.forEach((item, index) => {
    const where = `steps[${index}]`;
    const step = readStep(item, where, issues);
    if (step) {
      steps.push(step);
    } else {
      complete = false;
    }
    // A repeated id is reported even when the earlier step is invalid for another reason.
    const id = isJsonObject(item) ? item.id : undefined;
    if (isStepId(id)) {
      if (seen.has(id)) {
        issues.invalid.push(`${where}.id`);
        complete = false;
      }
      seen.add(id);
    }
  });
  return complete ? steps : undefined;
}

/**
 * Checks a parsed value against the task plan contract. Reports every absent required field in
 * `missing` and every present field with a wrong type or value in `invalid`; on success returns a
 * copy that holds exactly the known fields, with a missing `dismissed` read as false.
 */
export function validateTaskPlan(value: unknown): TaskPlanValidation {
  if (!isJsonObject(value)) {
    return { ok: false, missing: [], invalid: ['$'] };
  }
  const object: JsonObject = value;
  const issues: Issues = { missing: [], invalid: [] };
  for (const field of TASK_PLAN_REQUIRED_FIELDS) {
    if (!has(object, field)) {
      issues.missing.push(field);
    }
  }
  const present = (field: string) => has(object, field);
  const reject = (field: string) => {
    issues.invalid.push(field);
  };

  if (present('schemaVersion') && object.schemaVersion !== TASK_PLAN_SCHEMA_VERSION) {
    reject('schemaVersion');
  }
  if (present('taskId') && !isTaskId(object.taskId)) {
    reject('taskId');
  }
  if (present('title') && typeof object.title !== 'string') {
    reject('title');
  }
  if (present('status') && !isTaskStatus(object.status)) {
    reject('status');
  }
  const dismissed = present('dismissed') ? object.dismissed : false;
  if (typeof dismissed !== 'boolean') {
    reject('dismissed');
  }
  if (present('createdAt') && !isRunTimestamp(object.createdAt)) {
    reject('createdAt');
  }
  const steps = present('steps') ? readSteps(object.steps, issues) : undefined;

  if (issues.missing.length > 0 || issues.invalid.length > 0 || !steps) {
    return { ok: false, missing: issues.missing, invalid: issues.invalid };
  }
  return {
    ok: true,
    plan: {
      schemaVersion: TASK_PLAN_SCHEMA_VERSION,
      taskId: object.taskId as string,
      title: object.title as string,
      status: object.status as TaskStatus,
      dismissed: dismissed as boolean,
      createdAt: object.createdAt as string,
      steps,
    },
  };
}

/** Pretty-printed JSON with a trailing newline and the fields in contract order. */
export function serializeTaskPlan(plan: TaskPlan): string {
  const ordered = {
    schemaVersion: plan.schemaVersion,
    taskId: plan.taskId,
    title: plan.title,
    status: plan.status,
    dismissed: plan.dismissed,
    createdAt: plan.createdAt,
    steps: plan.steps.map(({ id, title, runIds }) => ({ id, title, runIds: [...runIds] })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Parses one task plan file. Invalid JSON reports the position of the first syntax error; valid
 * JSON that breaks the contract reports every missing and invalid field. Never throws.
 */
export function parseTaskPlan(text: string, path = ''): ParseTaskPlanResult {
  const errorAt = locateJsonSyntaxError(text);
  if (errorAt !== null) {
    return { ok: false, path, missing: [], invalid: [], parseErrorAt: lineColumnAt(text, errorAt) };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Unreachable when the scanner above is correct; still report a position.
    return { ok: false, path, missing: [], invalid: [], parseErrorAt: { line: 1, column: 1 } };
  }
  const result = validateTaskPlan(value);
  if (result.ok) {
    return result;
  }
  return { ok: false, path, missing: result.missing, invalid: result.invalid };
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/**
 * Parses every task plan of a Project. A bad file becomes a problem and the rest still load. A
 * plan whose file name is not `<taskId>.json` is reported as an invalid `taskId`.
 */
export function loadTaskPlans(files: ReadonlyArray<TaskPlanFile>): LoadedTaskPlans {
  const loaded: LoadedTaskPlans = { plans: [], problems: [] };
  for (const file of files) {
    const result = parseTaskPlan(file.text, file.path);
    if (!result.ok) {
      const problem: TaskPlanProblem = {
        path: result.path,
        missing: result.missing,
        invalid: result.invalid,
      };
      if (result.parseErrorAt) {
        problem.parseErrorAt = result.parseErrorAt;
      }
      loaded.problems.push(problem);
    } else if (baseName(file.path) !== taskPlanFileName(result.plan.taskId)) {
      loaded.problems.push({ path: file.path, missing: [], invalid: ['taskId'] });
    } else {
      loaded.plans.push({ path: file.path, plan: result.plan });
    }
  }
  return loaded;
}

// --- resume planning -------------------------------------------------------------------------

function checkFile(
  runId: string,
  role: ResumeFileRole,
  file: RunFileHash,
  hashes: FileHashSnapshot,
  reasons: StepStaleReason[]
): void {
  const current = hashes.get(file.path);
  if (current === FILE_HASH_MISSING) {
    reasons.push({ kind: 'file-missing', runId, role, path: file.path });
  } else if (current !== file.sha256) {
    // A path the snapshot lacks cannot be confirmed, so it counts as unreadable.
    reasons.push({
      kind: 'hash-mismatch',
      runId,
      role,
      path: file.path,
      expected: file.sha256,
      actual: current ?? FILE_HASH_UNREADABLE,
    });
  }
}

function checkRun(
  runId: string,
  runs: RunRecordMap,
  hashes: FileHashSnapshot,
  reasons: StepStaleReason[]
): void {
  const record = runs.get(runId);
  if (!record || record.runId !== runId) {
    reasons.push({ kind: 'record-missing', runId });
    return;
  }
  if (record.exitCode !== 0) {
    reasons.push({
      kind: 'run-failed',
      runId,
      exitCode: record.exitCode,
      failure: record.failure,
    });
  }
  // Requirement 22.2 asks for all inputs and all outputs to match; a truncated list hides some.
  if (record.inputsTruncated) {
    reasons.push({ kind: 'record-truncated', runId, role: 'input' });
  }
  if (record.outputsTruncated) {
    reasons.push({ kind: 'record-truncated', runId, role: 'output' });
  }
  for (const input of record.inputs) {
    checkFile(runId, 'input', input, hashes, reasons);
  }
  checkFile(runId, 'code', record.code, hashes, reasons);
  for (const output of record.outputs) {
    checkFile(runId, 'output', output, hashes, reasons);
  }
}

/**
 * Every condition of requirement 22.2 that `step` fails, in check order: per run in `runIds`
 * order, a missing record alone, otherwise the exit code, truncated lists, then each input, the
 * code file and each output. Empty exactly when the step may be skipped.
 */
export function stepStaleReasons(
  step: ResumeStep,
  runs: RunRecordMap,
  hashes: FileHashSnapshot
): StepStaleReason[] {
  if (step.runIds.length === 0) {
    return [{ kind: 'record-missing', runId: null }];
  }
  const reasons: StepStaleReason[] = [];
  for (const runId of step.runIds) {
    checkRun(runId, runs, hashes, reasons);
  }
  return reasons;
}

/**
 * Which steps of an interrupted task to skip (requirement 22.2, 22.5). Walks the steps in order
 * and skips each one whose every run has a valid record (`runs` holds only those, as
 * `loadRunRecords` returns them) with exit code 0 and whose recorded input, code and output
 * hashes all equal `hashes`. Stops at the first step that fails and reports why; later steps are
 * not examined, since they run again anyway.
 */
export function planResume(
  steps: ReadonlyArray<ResumeStep>,
  runs: RunRecordMap,
  hashes: FileHashSnapshot
): ResumePlan {
  const skip: StepId[] = [];
  for (const step of steps) {
    const staleReasons = stepStaleReasons(step, runs, hashes);
    if (staleReasons.length > 0) {
      return { skip, resumeFrom: step.id, staleReasons };
    }
    skip.push(step.id);
  }
  return { skip, resumeFrom: null, staleReasons: [] };
}
