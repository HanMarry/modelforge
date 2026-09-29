/**
 * Renderer API for resuming interrupted tasks (requirement 22, tasks 25.4, 25.5). Implemented by
 * `bridges/taskResumeBridge.ts`, served by `utils/resume/taskResumeIpc.ts`; owned by
 * `mp/s2-c1-resume`.
 */
import type { IpcResult } from '../utils/ipcResult';
import type { RunFailure } from './runRecord';
import type { ResumePlan, StepId, TaskPlan } from './taskPlan';

/** One Run_Record of a step, as the resume prompt lists it (22.1). */
export interface TaskRunSummary {
  runId: string;
  /** False when `.modelforge/runs/<runId>.json` is missing or cannot be parsed. */
  recorded: boolean;
  /** ISO 8601 with milliseconds and offset; null without a record. */
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  failure: RunFailure | null;
}

export interface TaskStepSummary {
  id: StepId;
  title: string;
  /** The runs of the step's latest attempt, in execution order. */
  runs: TaskRunSummary[];
  /** Every run has a record with exit code 0 (22.1); false for a step without runs. */
  completed: boolean;
}

/** An unfinished task found in `.modelforge/tasks/` of an open Project (22.1). */
export interface ResumableTask {
  projectDir: string;
  plan: TaskPlan;
  /** The plan's steps with their Run_Records, in execution order. */
  steps: TaskStepSummary[];
  /**
   * The failure point of 22.1: the first step that is not completed; null when every step is.
   * Which steps are skipped on resume also depends on file hashes (22.2), so it is computed by
   * `taskResumeContinue` right before resuming.
   */
  failedStep: StepId | null;
}

export interface TaskResumeListRequest {
  /** Projects to scan; the startup prompt passes the Projects that are open (22.1). */
  projectDirs: string[];
  /** Also return tasks with `dismissed: true`, for the task detail's "继续" entry (22.6). */
  includeDismissed: boolean;
}

export interface TaskResumeTarget {
  projectDir: string;
  taskId: string;
}

/** Stable `error.code` values of the `task-resume-*` channels. */
export type TaskResumeIpcErrorCode =
  'INVALID_REQUEST' | 'TASK_NOT_FOUND' | 'INVALID_TASK_PLAN' | 'READ_FAILED' | 'WRITE_FAILED';

export interface TaskResumeApi {
  taskResumeList: (request: TaskResumeListRequest) => Promise<IpcResult<ResumableTask[]>>;
  /** Recomputes the plan right before resuming; the renderer sends it with the resume request. */
  taskResumeContinue: (target: TaskResumeTarget) => Promise<IpcResult<ResumePlan>>;
  /** "放弃恢复": writes `dismissed: true` into the task plan. */
  taskResumeDismiss: (target: TaskResumeTarget) => Promise<IpcResult<null>>;
  /**
   * For a plan whose every step checks out: recomputes it and, if `resumeFrom` is still null,
   * marks the task 已完成 without starting a session. Returns the plan it checked.
   */
  taskResumeComplete: (target: TaskResumeTarget) => Promise<IpcResult<ResumePlan>>;
}
