import type {
  RunFinishedNotification_unstable,
  RunStartedNotification_unstable,
} from '@aaif/goose-acp-client';
import type { RunsApi } from '../types/runsApi';

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
 * Other renderer code can listen as well, with `subscribeToRunStarted` and
 * `subscribeToRunFinished`.
 */

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
  const forward = mainProcess()?.artifactsRunStarted;
  const forwarded =
    typeof forward === 'function'
      ? forwardToMainProcess(
          () =>
            forward({
              workingDir: notification.workingDir,
              runId: notification.runId,
              declaredOutputs: notification.declaredOutputs ?? [],
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
  const forward = mainProcess()?.artifactsRunFinished;
  const forwarded =
    typeof forward === 'function'
      ? forwardToMainProcess(
          () =>
            forward({
              workingDir: notification.workingDir,
              runId: notification.runId,
              recordPath: notification.recordPath,
            }),
          'runs/finished'
        )
      : Promise.resolve();
  dispatch(runFinishedListeners, notification, 'runs/finished');
  await forwarded;
}
