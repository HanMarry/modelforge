import type {
  RunFinishedNotification_unstable,
  RunStartedNotification_unstable,
} from '@aaif/goose-acp-client';
import type { RunsApi } from '../types/runsApi';
import { runRecordPath } from '../utils/artifactStatus';

/**
 * Run notifications from the Kernel: `_goose/unstable/runs/started` and
 * `_goose/unstable/runs/finished` (spec mathmodel-parity-and-beyond, tasks 21.6, 21.8 and 22.8).
 * The Kernel only sends them because `acpConnection.ts` declares `runNotifications`. Contract:
 * `.kiro/specs/mathmodel-parity-and-beyond/layer-c-contract-acp.md`.
 *
 * Every notification is first passed on to the main process, which keeps the Artifact_Status of
 * the Project (`utils/runs/artifactStore.ts`): `runs/started` marks the declared outputs with
 * `applyRunStarted`, and `runs/finished` reads the record at `recordPath` (relative to
 * `workingDir`) and applies it with `applyRunFinished`. The main process then pushes the new
 * index through `artifacts-changed`. Neither notification is guaranteed (a run started from code
 * mode or from a separate `goose mcp modeling` process sends none), which is why the main process
 * also rescans `.modelforge/runs` when files change.
 *
 * A run that started but left no Run_Record sends no `runs/finished`. So the end of the tool call
 * that started it counts too (`handleRunToolCallEnded`): when no `runs/finished` follows within
 * `RUN_END_GRACE_MS`, the main process is told the run is over and ends what it marked `执行中`.
 *
 * Other renderer code can listen as well, with `subscribeToRunStarted` and
 * `subscribeToRunFinished`.
 */

/**
 * How long `runs/finished` may follow the end of its tool call. goose sends it right after the
 * tool result, so waiting only matters for a run that left no record.
 */
export const RUN_END_GRACE_MS = 3000;
/** Started runs remembered at once; the oldest is forgotten first. */
const MAX_STARTED_RUNS = 256;

interface StartedRun {
  workingDir: string;
  runId: string;
}

/** Runs whose start was heard and whose end was not, by session and tool call. */
const startedRuns = new Map<string, StartedRun>();
const pendingEnds = new Map<string, ReturnType<typeof setTimeout>>();

function runKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}\n${toolCallId}`;
}

function forgetRun(key: string): void {
  startedRuns.delete(key);
  const timer = pendingEnds.get(key);
  if (timer !== undefined) {
    clearTimeout(timer);
    pendingEnds.delete(key);
  }
}

function rememberRun(key: string, run: StartedRun): void {
  forgetRun(key);
  startedRuns.set(key, run);
  for (const oldest of startedRuns.keys()) {
    if (startedRuns.size <= MAX_STARTED_RUNS) {
      break;
    }
    forgetRun(oldest);
  }
}

export type RunStartedListener = (notification: RunStartedNotification_unstable) => void;
export type RunFinishedListener = (notification: RunFinishedNotification_unstable) => void;

const runStartedListeners = new Set<RunStartedListener>();
const runFinishedListeners = new Set<RunFinishedListener>();

/** Calls `listener` for every `runs/started`; returns the function that unsubscribes it. */
export function subscribeToRunStarted(listener: RunStartedListener): () => void {
  runStartedListeners.add(listener);
  return () => {
    runStartedListeners.delete(listener);
  };
}

/** Calls `listener` for every `runs/finished`; returns the function that unsubscribes it. */
export function subscribeToRunFinished(listener: RunFinishedListener): () => void {
  runFinishedListeners.add(listener);
  return () => {
    runFinishedListeners.delete(listener);
  };
}

/** A failing listener is logged and does not keep the others from running. */
function dispatch<T>(listeners: ReadonlySet<(value: T) => void>, value: T, method: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(value);
    } catch (error) {
      console.error(`A ${method} listener failed:`, error);
    }
  }
}

type RunEventChannels = Pick<RunsApi, 'artifactsRunStarted' | 'artifactsRunFinished'>;

/** The main process API, when this renderer runs inside the desktop app. */
function mainProcess(): Partial<RunEventChannels> | undefined {
  return typeof window === 'undefined'
    ? undefined
    : (window.electron as Partial<RunEventChannels> | undefined);
}

/**
 * Passes a notification on to the main process. Best effort: a failure is logged, and the main
 * process catches up when it rescans the Project.
 */
async function forwardToMainProcess(
  send: () => Promise<{ ok: boolean }>,
  method: string
): Promise<void> {
  try {
    const outcome = await send();
    if (!outcome.ok) {
      console.warn(`The main process did not apply ${method}:`, outcome);
    }
  } catch (error) {
    console.warn(`Could not pass ${method} on to the main process:`, error);
  }
}

export async function handleAcpRunStartedNotification(
  notification: RunStartedNotification_unstable
): Promise<void> {
  rememberRun(runKey(notification.sessionId, notification.toolCallId), {
    workingDir: notification.workingDir,
    runId: notification.runId,
  });
  const forward = mainProcess()?.artifactsRunStarted;
  const forwarded =
    typeof forward === 'function'
      ? forwardToMainProcess(
          () =>
            forward({
              workingDir: notification.workingDir,
              runId: notification.runId,
              declaredOutputs: notification.declaredOutputs ?? [],
              toolCallId: notification.toolCallId,
            }),
          'runs/started'
        )
      : Promise.resolve();
  dispatch(runStartedListeners, notification, 'runs/started');
  await forwarded;
}

export async function handleAcpRunFinishedNotification(
  notification: RunFinishedNotification_unstable
): Promise<void> {
  forgetRun(runKey(notification.sessionId, notification.toolCallId));
  const forward = mainProcess()?.artifactsRunFinished;
  const forwarded =
    typeof forward === 'function'
      ? forwardToMainProcess(
          () =>
            forward({
              workingDir: notification.workingDir,
              runId: notification.runId,
              recordPath: notification.recordPath,
              toolCallId: notification.toolCallId,
            }),
          'runs/finished'
        )
      : Promise.resolve();
  dispatch(runFinishedListeners, notification, 'runs/finished');
  await forwarded;
}

/**
 * The tool call `toolCallId` of the session ended (`tool_call_update` completed or failed). When
 * it started a run and no `runs/finished` follows within `RUN_END_GRACE_MS`, the main process
 * hears that the run is over, so the Artifacts it marked `执行中` do not wait for a record that
 * never comes (requirement 16.5: a run without a usable record backs nothing).
 */
export function handleRunToolCallEnded(sessionId: string, toolCallId: string): void {
  const key = runKey(sessionId, toolCallId);
  const run = startedRuns.get(key);
  if (!run || pendingEnds.has(key)) {
    return;
  }
  const timer = setTimeout(() => {
    pendingEnds.delete(key);
    if (startedRuns.get(key) !== run) {
      return;
    }
    startedRuns.delete(key);
    const forward = mainProcess()?.artifactsRunFinished;
    if (typeof forward === 'function') {
      void forwardToMainProcess(
        () =>
          forward({
            workingDir: run.workingDir,
            runId: run.runId,
            recordPath: runRecordPath(run.runId),
            toolCallId,
          }),
        'the end of a run'
      );
    }
  }, RUN_END_GRACE_MS);
  pendingEnds.set(key, timer);
}
