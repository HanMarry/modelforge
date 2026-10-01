/**
 * Main-process IPC for resuming interrupted tasks (requirement 22, tasks 25.4, 25.5).
 *
 * - `task-resume-list`: the unfinished task plans (`.modelforge/tasks/*.json`) of the given
 *   Projects with each step's Run_Records, for the startup prompt (22.1). Only exit codes are
 *   read, no file is hashed, so the prompt appears within its 5 seconds.
 * - `task-resume-continue`: reads the plan, its Run_Records and the current hashes of every file
 *   they name, and returns `planResume` (22.2, 22.5). The renderer sends that plan with the ACP
 *   resume request as is; the skip rule exists only in `utils/resumePlanner.ts`. The Artifacts
 *   of the step it resumes from become 已过期 with the step's reasons (22.5).
 * - `task-resume-dismiss`: "放弃恢复" writes `dismissed: true` (22.6).
 * - `task-resume-complete`: when every step still checks out there is nothing to run; the task is
 *   marked 已完成 here instead of starting a Kernel session for it.
 *
 * Paths come from validated ids (`isTaskId`, `isRunId`) and Run_Record paths
 * (`isProjectRelativePath`); files are hashed only when their real path stays in the Project.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { IpcMain } from 'electron';
import type { FileHashSnapshot, RunRecordMap } from '../../types/runRecord';
import type {
  ResumePlan,
  ResumeStep,
  StepStaleReason,
  TaskPlan,
  TaskPlanProblem,
} from '../../types/taskPlan';
import type {
  ResumableTask,
  TaskResumeIpcErrorCode,
  TaskResumeListRequest,
  TaskResumeTarget,
} from '../../types/taskResumeApi';
import { writeFileAtomic } from '../atomicWrite';
import type { FeatureIpcDeps } from '../featureIpc';
import { describeError, toIpcError, type IpcResult } from '../ipcResult';
import {
  isTaskId,
  loadTaskPlans,
  planResume,
  serializeTaskPlan,
  taskPlanFileName,
} from '../resumePlanner';
import { FILE_HASH_MISSING, FILE_HASH_UNREADABLE, isRunId, loadRunRecords } from '../runRecord';
import {
  compareByCreatedAtDesc,
  isResumableTask,
  planFilePaths,
  planRunIds,
  summarizeTaskSteps,
} from './taskSummary';

export const TASK_RESUME_CHANNELS = [
  'task-resume-list',
  'task-resume-continue',
  'task-resume-dismiss',
  'task-resume-complete',
] as const;

const TASKS_DIR = ['.modelforge', 'tasks'] as const;
const RUNS_DIR = ['.modelforge', 'runs'] as const;

class TaskResumeError extends Error {
  readonly code: TaskResumeIpcErrorCode;

  constructor(code: TaskResumeIpcErrorCode, message: string) {
    super(message);
    this.name = 'TaskResumeError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function readListRequest(value: unknown): TaskResumeListRequest {
  const projectDirs = isRecord(value) ? value.projectDirs : undefined;
  const includeDismissed = isRecord(value) ? value.includeDismissed : undefined;
  if (!isStringArray(projectDirs) || typeof includeDismissed !== 'boolean') {
    throw new TaskResumeError(
      'INVALID_REQUEST',
      'expected { projectDirs: string[], includeDismissed: boolean }'
    );
  }
  return { projectDirs, includeDismissed };
}

function readTarget(value: unknown): TaskResumeTarget {
  const projectDir = isRecord(value) ? value.projectDir : undefined;
  const taskId = isRecord(value) ? value.taskId : undefined;
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir) || !isTaskId(taskId)) {
    throw new TaskResumeError(
      'INVALID_REQUEST',
      'expected { projectDir: absolute path, taskId: task id }'
    );
  }
  return { projectDir, taskId };
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** The file's text, or null when it does not exist. */
async function readOptionalText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw new TaskResumeError('READ_FAILED', describeError(error));
  }
}

function describeProblem(problem: TaskPlanProblem | undefined): string {
  if (!problem) {
    return 'the task plan cannot be used';
  }
  if (problem.parseErrorAt) {
    const { line, column } = problem.parseErrorAt;
    return `${problem.path}: JSON syntax error at line ${line}, column ${column}`;
  }
  const fields = [
    ...problem.missing.map((field) => `missing ${field}`),
    ...problem.invalid.map((field) => `invalid ${field}`),
  ];
  return `${problem.path}: ${fields.join(', ')}`;
}

/** Every valid plan of a Project; unusable files are logged and left out. */
async function readPlans(projectDir: string): Promise<TaskPlan[]> {
  let names: string[];
  try {
    names = await fs.readdir(path.join(projectDir, ...TASKS_DIR));
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw new TaskResumeError('READ_FAILED', describeError(error));
  }
  const files: Array<{ path: string; text: string }> = [];
  // Temporary files of an atomic write start with a dot.
  for (const name of [...names].sort()) {
    if (name.startsWith('.') || !name.endsWith('.json')) {
      continue;
    }
    const text = await readOptionalText(path.join(projectDir, ...TASKS_DIR, name));
    if (text !== null) {
      files.push({ path: `.modelforge/tasks/${name}`, text });
    }
  }
  const loaded = loadTaskPlans(files);
  for (const problem of loaded.problems) {
    console.warn(`[task-resume] skipped ${describeProblem(problem)} in ${projectDir}`);
  }
  return loaded.plans.map(({ plan }) => plan);
}

async function readPlan(target: TaskResumeTarget): Promise<TaskPlan> {
  const name = taskPlanFileName(target.taskId);
  const relative = `.modelforge/tasks/${name}`;
  const text = await readOptionalText(path.join(target.projectDir, ...TASKS_DIR, name));
  if (text === null) {
    throw new TaskResumeError('TASK_NOT_FOUND', `no ${relative} in ${target.projectDir}`);
  }
  const loaded = loadTaskPlans([{ path: relative, text }]);
  const found = loaded.plans[0];
  if (!found) {
    throw new TaskResumeError('INVALID_TASK_PLAN', describeProblem(loaded.problems[0]));
  }
  return found.plan;
}

/** The valid Run_Records among `runIds`; a missing or unreadable record is simply absent. */
async function readRuns(projectDir: string, runIds: ReadonlyArray<string>): Promise<RunRecordMap> {
  const files: Array<{ path: string; text: string }> = [];
  for (const runId of runIds) {
    if (!isRunId(runId)) {
      continue;
    }
    try {
      const text = await fs.readFile(path.join(projectDir, ...RUNS_DIR, `${runId}.json`), 'utf8');
      files.push({ path: `.modelforge/runs/${runId}.json`, text });
    } catch {
      // Counts as a missing record, which planResume reports as such.
    }
  }
  const loaded = loadRunRecords(files);
  return new Map(loaded.records.map(({ record }) => [record.runId, record]));
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function sha256OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function hashProjectFile(
  projectDir: string,
  realRoot: string,
  relative: string
): Promise<string> {
  try {
    const real = await fs.realpath(path.join(projectDir, relative));
    if (!isInside(realRoot, real)) {
      return FILE_HASH_UNREADABLE;
    }
    return await sha256OfFile(real);
  } catch (error) {
    return isMissing(error) ? FILE_HASH_MISSING : FILE_HASH_UNREADABLE;
  }
}

/** Current hashes of `paths` (Project-relative), with the markers `planResume` understands. */
export async function hashProjectFiles(
  projectDir: string,
  paths: ReadonlyArray<string>
): Promise<FileHashSnapshot> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(projectDir);
  } catch (error) {
    throw new TaskResumeError('READ_FAILED', describeError(error));
  }
  const snapshot = new Map<string, string>();
  for (const relative of paths) {
    snapshot.set(relative, await hashProjectFile(projectDir, realRoot, relative));
  }
  return snapshot;
}

async function writePlan(projectDir: string, plan: TaskPlan): Promise<void> {
  const file = path.join(projectDir, ...TASKS_DIR, taskPlanFileName(plan.taskId));
  try {
    await writeFileAtomic(file, serializeTaskPlan(plan));
  } catch (error) {
    throw new TaskResumeError('WRITE_FAILED', describeError(error));
  }
}

/** The unfinished tasks of `request.projectDirs`, per Project newest first (22.1). */
export async function listResumableTasks(request: TaskResumeListRequest): Promise<ResumableTask[]> {
  const tasks: ResumableTask[] = [];
  const seen = new Set<string>();
  for (const projectDir of request.projectDirs) {
    if (!path.isAbsolute(projectDir) || seen.has(projectDir)) {
      continue;
    }
    seen.add(projectDir);
    if (!(await isDirectory(projectDir))) {
      continue;
    }
    let plans: TaskPlan[];
    try {
      plans = await readPlans(projectDir);
    } catch (error) {
      console.warn(`[task-resume] cannot read the task plans of ${projectDir}:`, error);
      continue;
    }
    const unfinished = plans
      .filter((plan) => isResumableTask(plan, request.includeDismissed))
      .sort(compareByCreatedAtDesc);
    for (const plan of unfinished) {
      const runs = await readRuns(projectDir, planRunIds(plan));
      tasks.push({ projectDir, plan, ...summarizeTaskSteps(plan, runs) });
    }
  }
  return tasks;
}

/**
 * Where the Artifacts of a step that fails the resume check are marked 已过期 (requirement 22.5,
 * task 25.4): the Artifact store of the main process (`utils/runs/artifactStore.ts`).
 */
export interface ResumeArtifacts {
  markResumeStale: (
    projectDir: string,
    step: ResumeStep,
    reasons: readonly StepStaleReason[]
  ) => Promise<unknown>;
}

async function planFor(
  projectDir: string,
  plan: TaskPlan,
  artifacts: ResumeArtifacts | null
): Promise<ResumePlan> {
  const runs = await readRuns(projectDir, planRunIds(plan));
  const hashes = await hashProjectFiles(projectDir, planFilePaths(plan, runs));
  const resume = planResume(plan.steps, runs, hashes);
  const step = plan.steps.find((candidate) => candidate.id === resume.resumeFrom);
  if (artifacts && step) {
    // 22.5: the step runs again, so its Artifacts are out of date; the plan stands either way.
    try {
      await artifacts.markResumeStale(projectDir, step, resume.staleReasons);
    } catch (error) {
      console.warn(`[task-resume] could not mark the Artifacts of ${step.id} 已过期:`, error);
    }
  }
  return resume;
}

/** `planResume` on the files as they are now (22.2, 22.5). */
export async function planTaskResume(
  target: TaskResumeTarget,
  artifacts: ResumeArtifacts | null = null
): Promise<ResumePlan> {
  return planFor(target.projectDir, await readPlan(target), artifacts);
}

/** "放弃恢复" (22.6): only the flag changes; outputs and Run_Records are not touched. */
export async function dismissTask(target: TaskResumeTarget): Promise<null> {
  const plan = await readPlan(target);
  if (!plan.dismissed) {
    await writePlan(target.projectDir, { ...plan, dismissed: true });
  }
  return null;
}

/** Marks the task 已完成 when, checked again now, no step is left to run. */
export async function completeTask(
  target: TaskResumeTarget,
  artifacts: ResumeArtifacts | null = null
): Promise<ResumePlan> {
  const plan = await readPlan(target);
  const resume = await planFor(target.projectDir, plan, artifacts);
  if (resume.resumeFrom === null && plan.status !== '已完成') {
    await writePlan(target.projectDir, { ...plan, status: '已完成' });
  }
  return resume;
}

async function respond<T>(deps: FeatureIpcDeps, work: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    const code: TaskResumeIpcErrorCode =
      error instanceof TaskResumeError ? error.code : 'READ_FAILED';
    return { ok: false, error: toIpcError(code, error, deps.sensitiveValues()) };
  }
}

/**
 * `artifacts` marks the Artifacts of the step a task resumes from 已过期; `main.ts` passes the
 * shared Artifact store. Without one only the plan is computed.
 */
export function registerTaskResumeIpc(
  ipc: Pick<IpcMain, 'handle'>,
  deps: FeatureIpcDeps,
  artifacts: ResumeArtifacts | null = null
): void {
  ipc.handle('task-resume-list', (_event, request: unknown) =>
    respond(deps, () => listResumableTasks(readListRequest(request)))
  );
  ipc.handle('task-resume-continue', (_event, target: unknown) =>
    respond(deps, () => planTaskResume(readTarget(target), artifacts))
  );
  ipc.handle('task-resume-dismiss', (_event, target: unknown) =>
    respond(deps, () => dismissTask(readTarget(target)))
  );
  ipc.handle('task-resume-complete', (_event, target: unknown) =>
    respond(deps, () => completeTask(readTarget(target), artifacts))
  );
}
