/**
 * What the resume prompt shows about an unfinished task (requirement 22.1, task 25.5): each
 * step's Run_Records with their times and exit codes, the completed steps and the failure point.
 * The skip rule of 22.2 is `planResume` in `utils/resumePlanner.ts`; this module only reads exit
 * codes, so the prompt can appear without hashing any file.
 *
 * Pure functions with erasable TypeScript syntax only.
 */

import type { RunRecordMap } from '../../types/runRecord';
import type { StepId, TaskPlan } from '../../types/taskPlan';
import type { TaskRunSummary, TaskStepSummary } from '../../types/taskResumeApi';

/** A task the prompt offers: not 已完成, and not dismissed unless asked for (22.6). */
export function isResumableTask(plan: TaskPlan, includeDismissed: boolean): boolean {
  return plan.status !== '已完成' && (includeDismissed || !plan.dismissed);
}

export function summarizeRun(runId: string, runs: RunRecordMap): TaskRunSummary {
  const record = runs.get(runId);
  if (!record || record.runId !== runId) {
    return {
      runId,
      recorded: false,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      failure: null,
    };
  }
  return {
    runId,
    recorded: true,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    exitCode: record.exitCode,
    failure: record.failure,
  };
}

/**
 * The steps of `plan` with their runs. A step is completed when it has runs and every one of them
 * has a record with exit code 0; the failure point is the first step that is not (22.1).
 */
export function summarizeTaskSteps(
  plan: TaskPlan,
  runs: RunRecordMap
): { steps: TaskStepSummary[]; failedStep: StepId | null } {
  const steps = plan.steps.map((step): TaskStepSummary => {
    const stepRuns = step.runIds.map((runId) => summarizeRun(runId, runs));
    const completed =
      stepRuns.length > 0 && stepRuns.every((run) => run.recorded && run.exitCode === 0);
    return { id: step.id, title: step.title, runs: stepRuns, completed };
  });
  const failed = steps.find((step) => !step.completed);
  return { steps, failedStep: failed ? failed.id : null };
}

/** The run ids of every step, each once, in plan order. */
export function planRunIds(plan: TaskPlan): string[] {
  const seen = new Set<string>();
  for (const step of plan.steps) {
    for (const runId of step.runIds) {
      seen.add(runId);
    }
  }
  return [...seen];
}

/**
 * The Project files `planResume` compares for `plan`: inputs, code and outputs of every recorded
 * run, each once, in plan and record order.
 */
export function planFilePaths(plan: TaskPlan, runs: RunRecordMap): string[] {
  const seen = new Set<string>();
  for (const runId of planRunIds(plan)) {
    const record = runs.get(runId);
    if (!record) {
      continue;
    }
    for (const file of [...record.inputs, record.code, ...record.outputs]) {
      seen.add(file.path);
    }
  }
  return [...seen];
}

/** Newest first; plans with the same start keep their order. */
export function compareByCreatedAtDesc(a: TaskPlan, b: TaskPlan): number {
  const at = (plan: TaskPlan) => {
    const time = Date.parse(plan.createdAt);
    return Number.isNaN(time) ? 0 : time;
  };
  return at(b) - at(a);
}
