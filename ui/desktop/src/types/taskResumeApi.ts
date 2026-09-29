/**
 * Renderer API for resuming interrupted tasks (requirement 22, tasks 25.4, 25.5). Implemented by
 * `bridges/taskResumeBridge.ts`, served by `utils/resume/taskResumeIpc.ts`; owned by
 * `mp/s2-c1-resume`.
 */
import type { IpcResult } from '../utils/ipcResult';
import type { ResumePlan, TaskPlan } from './taskPlan';

/** An unfinished task found in `.modelforge/tasks/` of an open Project (22.1). */
export interface ResumableTask {
  projectDir: string;
  plan: TaskPlan;
  /** What `planResume` computes now; shown as completed steps and the failure point. */
  resume: ResumePlan;
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

export interface TaskResumeApi {
  taskResumeList: (request: TaskResumeListRequest) => Promise<IpcResult<ResumableTask[]>>;
  /** Recomputes the plan right before resuming; the renderer sends it with the resume request. */
  taskResumeContinue: (target: TaskResumeTarget) => Promise<IpcResult<ResumePlan>>;
  /** "放弃恢复": writes `dismissed: true` into the task plan. */
  taskResumeDismiss: (target: TaskResumeTarget) => Promise<IpcResult<null>>;
}
