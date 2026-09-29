import type { ResumeTaskResponse_unstable } from '@aaif/goose-acp-client';
import type { ResumePlan } from '../types/taskPlan';
import { getAcpClient } from './acpConnection';

export type ResumeTaskOutcome = ResumeTaskResponse_unstable['outcome'];

/**
 * `error.data.code` values the Kernel attaches when it refuses a resume request
 * (`crates/goose/src/acp/server/task_resume.rs`), plus the capability error of layer C.
 */
export type ResumeTaskErrorCode =
  | 'INVALID_TASK_ID'
  | 'TASK_NOT_FOUND'
  | 'INVALID_TASK_PLAN'
  | 'STALE_RESUME_PLAN'
  | 'SESSION_BUSY'
  | 'TASK_PLAN_WRITE_FAILED'
  | 'CAPABILITY_NOT_DECLARED';

const RESUME_TASK_ERROR_CODES: readonly ResumeTaskErrorCode[] = [
  'INVALID_TASK_ID',
  'TASK_NOT_FOUND',
  'INVALID_TASK_PLAN',
  'STALE_RESUME_PLAN',
  'SESSION_BUSY',
  'TASK_PLAN_WRITE_FAILED',
  'CAPABILITY_NOT_DECLARED',
];

/**
 * Asks the Kernel to continue the interrupted task `taskId` of session `sessionId`
 * (`_goose/unstable/tasks/resume`, spec mathmodel-parity-and-beyond, task 25.4). `plan` is the
 * `planResume` result, sent as is: the skip rule exists only on the desktop, and the Kernel runs
 * the task from `plan.resumeFrom`. It answers once it has decided: `resumed` (a turn runs in the
 * session and reports through `session/update`), `paused` (an overwrite was not confirmed, no file
 * changed) or `completed` (nothing was left to run). Errors are thrown as the client reports them;
 * `resumeTaskErrorCode` reads their `data.code`. Contract:
 * `.kiro/specs/mathmodel-parity-and-beyond/layer-c-contract-acp.md`.
 */
export async function resumeTask(
  sessionId: string,
  taskId: string,
  plan: ResumePlan
): Promise<ResumeTaskOutcome> {
  const client = await getAcpClient();
  const response = await client.goose.tasksResume_unstable({
    sessionId,
    taskId,
    skip: plan.skip,
    resumeFrom: plan.resumeFrom,
    staleReasons: plan.staleReasons,
  });
  return response.outcome;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The Kernel's `data.code` of a failed resume request, when it is one of the known ones. */
export function resumeTaskErrorCode(error: unknown): ResumeTaskErrorCode | null {
  if (!isRecord(error)) {
    return null;
  }
  const candidate = isRecord(error.error) ? error.error : error;
  const data = candidate.data;
  const code = isRecord(data) ? data.code : undefined;
  return RESUME_TASK_ERROR_CODES.find((known) => known === code) ?? null;
}
