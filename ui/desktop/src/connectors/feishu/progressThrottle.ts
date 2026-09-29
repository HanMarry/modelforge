/**
 * Progress-message throttling for Feishu (requirement 15.7).
 *
 * A progress message is emitted only after a task has been running for at least 60 seconds,
 * at most one every 5 minutes, and never after the task completes, fails or enters the
 * awaiting-approval state. The message carries the elapsed time and the most recently
 * completed step name.
 */

export const PROGRESS_MIN_ELAPSED_MS = 60 * 1000;
export const PROGRESS_MIN_INTERVAL_MS = 5 * 60 * 1000;

export type ProgressPhase = 'completed' | 'failed' | 'awaiting-approval';

export interface ProgressEvent {
  atMs: number;
  stepName: string;
}

export interface ProgressRun {
  startMs: number;
  /** Step-completion events, in chronological order. */
  events: ProgressEvent[];
  /** The moment the run stopped being "running"; null while it is still running. */
  end: { atMs: number; phase: ProgressPhase } | null;
}

export interface ProgressMessage {
  atMs: number;
  elapsedMs: number;
  stepName: string;
}

export function progressMessages(run: ProgressRun): ProgressMessage[] {
  const events = [...run.events].sort((a, b) => a.atMs - b.atMs);
  const messages: ProgressMessage[] = [];
  let lastSentMs: number | null = null;
  for (const event of events) {
    if (run.end && event.atMs >= run.end.atMs) {
      break;
    }
    const elapsedMs = event.atMs - run.startMs;
    if (elapsedMs < PROGRESS_MIN_ELAPSED_MS) {
      continue;
    }
    if (lastSentMs !== null && event.atMs - lastSentMs < PROGRESS_MIN_INTERVAL_MS) {
      continue;
    }
    lastSentMs = event.atMs;
    messages.push({ atMs: event.atMs, elapsedMs, stepName: event.stepName });
  }
  return messages;
}
