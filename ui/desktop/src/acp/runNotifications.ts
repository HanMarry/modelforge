import type {
  RunFinishedNotification_unstable,
  RunStartedNotification_unstable,
} from '@aaif/goose-acp-client';

/**
 * Run notifications from the Kernel: `_goose/unstable/runs/started` and
 * `_goose/unstable/runs/finished` (spec mathmodel-parity-and-beyond, tasks 21.6, 21.8 and 22.8).
 * The Kernel only sends them because `acpConnection.ts` declares `runNotifications`. Contract:
 * `.kiro/specs/mathmodel-parity-and-beyond/layer-c-contract-acp.md`.
 *
 * `runs/finished` arrives once the Run_Record is on disk; read the record at `recordPath`
 * (relative to `workingDir`) and apply it with `applyRunFinished`. `runs/started` carries the id
 * the finished record usually has, for `applyRunStarted`. Neither notification is guaranteed
 * (a run started from code mode or from a separate `goose mcp modeling` process sends none), so
 * listeners must not replace the rescan of `.modelforge/runs`.
 *
 * Branch `mp/s2-c1-runs` subscribes here, for example to forward the events to the main process.
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

export function handleAcpRunStartedNotification(
  notification: RunStartedNotification_unstable
): Promise<void> {
  dispatch(runStartedListeners, notification, 'runs/started');
  return Promise.resolve();
}

export function handleAcpRunFinishedNotification(
  notification: RunFinishedNotification_unstable
): Promise<void> {
  dispatch(runFinishedListeners, notification, 'runs/finished');
  return Promise.resolve();
}
