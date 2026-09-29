import type { ResumeTaskResponse_unstable } from '@aaif/goose-acp-client';
import type { ResumePlan } from '../types/taskPlan';
import { getAcpClient } from './acpConnection';

export type ResumeTaskOutcome = ResumeTaskResponse_unstable['outcome'];

/**
 * Asks the Kernel to continue the interrupted task `taskId` of session `sessionId`
 * (`_goose/unstable/tasks/resume`, spec mathmodel-parity-and-beyond, task 25.4). `plan` is the
 * `planResume` result, sent as is: the skip rule exists only on the desktop, and the Kernel runs
 * the task from `plan.resumeFrom`. Contract:
 * `.kiro/specs/mathmodel-parity-and-beyond/layer-c-contract-acp.md`.
 *
 * Until branch `mp/s2-c1-resume` implements the Kernel side, the request fails with an error whose
 * `data.code` is `NOT_IMPLEMENTED`.
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
