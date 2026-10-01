/**
 * Task plan and resume planning (spec mathmodel-parity-and-beyond, requirement 22).
 *
 * The kernel writes the plan of a long task to `<project>/.modelforge/tasks/<taskId>.json` when
 * the task starts and adds the Run_Records of each step as it finishes (task 25.4), for example
 *
 *   {
 *     "schemaVersion": 1,
 *     "taskId": "20260920T101530123-a1b2c3",
 *     "title": "问题一求解",
 *     "status": "执行中",
 *     "dismissed": false,
 *     "createdAt": "2026-09-20T10:15:30.123+08:00",
 *     "steps": [
 *       { "id": "clean", "title": "数据清洗", "runIds": ["20260920T101531000-x1y2z3"] },
 *       { "id": "fit", "title": "模型求解", "runIds": [] }
 *     ]
 *   }
 *
 * The desktop reads it with `utils/resumePlanner.ts`, sets `dismissed` when the user declines to
 * resume (task 25.5), and sends the `ResumePlan` of `planResume` with the resume request. The
 * skip rule exists only there; the kernel runs from `resumeFrom` and does not re-check.
 */

import type { RunFailure } from './runRecord';

/**
 * `执行中` is also what a task shows after the process ended in the middle of it; `已暂停` is a
 * task stopped at its failure point, for example after the user cancelled an overwrite (22.6).
 */
export type TaskStatus = '执行中' | '已暂停' | '已完成';

/** Identifies a step inside its plan. */
export type StepId = string;

export interface TaskStep {
  /** Non-empty and unique inside the plan. */
  id: StepId;
  title: string;
  /**
   * Run_Records of the step's latest attempt, in execution order. A retry replaces the list, so
   * an earlier failed attempt does not keep the step from being skipped. Empty until the step
   * has finished a run.
   */
  runIds: string[];
}

export interface TaskPlan {
  schemaVersion: 1;
  /** `[0-9A-Za-z][0-9A-Za-z_-]{0,127}`, the file name without `.json`; run ids qualify. */
  taskId: string;
  title: string;
  status: TaskStatus;
  /** True after "放弃恢复": no automatic prompt any more, the task detail still offers it. */
  dismissed: boolean;
  /** ISO 8601 with milliseconds and offset, like Run_Record timestamps. */
  createdAt: string;
  /** In execution order. */
  steps: TaskStep[];
}

/** Why a task plan file cannot be used. */
export interface TaskPlanProblem {
  path: string;
  /** Required fields that are absent, as dotted paths (`steps[2].runIds`). */
  missing: string[];
  /** Fields that are present but have the wrong type or value. */
  invalid: string[];
  /** 1-based position of the first JSON syntax error; `column` counts UTF-16 code units. */
  parseErrorAt?: { line: number; column: number };
}

export type ParseTaskPlanResult = { ok: true; plan: TaskPlan } | ({ ok: false } & TaskPlanProblem);

/** What `planResume` needs of a step; every `TaskStep` is one. */
export interface ResumeStep {
  id: StepId;
  runIds: ReadonlyArray<string>;
}

export type ResumeFileRole = 'input' | 'code' | 'output';

/**
 * One condition of requirement 22.2 that a step fails. Requirement 22.5 shows them as 记录缺失
 * (`record-missing`, `record-truncated`), 哈希不一致 (`hash-mismatch`) and 文件缺失
 * (`file-missing`). `record-missing`, `hash-mismatch` and `file-missing` mark the step's
 * Artifacts 已过期 (`applyResumeStaleness`); a truncated record still backs its Artifacts, whose
 * listed files the staleness check compares. `run-failed` is the non-zero exit code of 22.2 and
 * leaves them at 执行失败.
 */
export type StepStaleReason =
  /** The step has no run (`runId` null), or the record is absent or cannot be parsed. */
  | { kind: 'record-missing'; runId: string | null }
  /** The record lists only the first 1000 files, so not all of them can be checked. */
  | { kind: 'record-truncated'; runId: string; role: 'input' | 'output' }
  | { kind: 'run-failed'; runId: string; exitCode: number | null; failure: RunFailure | null }
  /**
   * The current hash differs from the recorded one. `actual` is `unreadable` for a file that
   * cannot be read or that the snapshot does not cover.
   */
  | {
      kind: 'hash-mismatch';
      runId: string;
      role: ResumeFileRole;
      path: string;
      expected: string;
      actual: string;
    }
  | { kind: 'file-missing'; runId: string; role: ResumeFileRole; path: string };

/** Result of `planResume`; plain JSON, so it can travel with the resume request as is. */
export interface ResumePlan {
  /** The longest prefix of steps that meet requirement 22.2, in order. */
  skip: StepId[];
  /** The first step that does not; `null` when every step does and nothing is left to run. */
  resumeFrom: StepId | null;
  /** Every condition `resumeFrom` fails, in check order; empty when `resumeFrom` is null. */
  staleReasons: StepStaleReason[];
}
