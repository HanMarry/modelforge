/**
 * Runs one mock review through the Kernel (requirement 19.1, 19.2, 19.6, task 26.5).
 *
 * The review gets its own ACP session in the project directory, so the reply can be read back
 * whole and the user's chat is left alone. The prompt asks for the `mathmodel-mock-review`
 * skill; the JSON object in the reply goes through `validateReview`. Every way the run can end
 * without a valid review is reported as a failure kind, and nothing is saved for it: saving is
 * the caller's next step, and only after `ok: true`.
 */
import type { ReviewPaperFormat } from '../../types/reviewApi';
import { describeError } from '../ipcResult';
import { validateReview, type ReviewOutput, type ReviewProblem } from './reviewModel';
import { buildReviewPrompt, extractReviewJson, replyExcerpt } from './reviewReply';

/** What the runner needs from the Kernel; `reviewAcp.ts` implements it over ACP. */
export interface ReviewKernel {
  /** Why the Kernel cannot take a review right now, or null when it can. */
  unavailableReason(): Promise<string | null>;
  /** Opens a new session with `workingDir` as its project; resolves to the session id. */
  openSession(workingDir: string, title: string): Promise<string>;
  /** Sends the prompt; resolves to the ACP stop reason once the turn ends. */
  prompt(sessionId: string, text: string): Promise<string>;
  /** Cancels the running turn and any pending approval request. */
  cancel(sessionId: string): Promise<void>;
  /** The turn is blocked on a tool approval or another question to the user. */
  isWaitingForUser(sessionId: string): boolean;
  /** Text of each assistant message in the session, oldest first. */
  replyTexts(sessionId: string): string[];
  /** Ends the session's agent and drops its cached messages. */
  closeSession(sessionId: string): Promise<void>;
}

export interface ReviewRunRequest {
  workingDir: string;
  /** Canonical project-relative path from `review-paper-check`. */
  paperPath: string;
  format: ReviewPaperFormat;
  competitionId: string;
  competitionName: string;
  /** Name of the review session in the session list. */
  sessionTitle: string;
}

/**
 * Why a review did not complete (requirement 19.6):
 * - `kernel-unavailable`: the Kernel is not configured or not running.
 * - `session-failed`: the Kernel could not open a session for the review.
 * - `model-call-failed`: the prompt request failed (provider error, lost connection).
 * - `timeout`: no answer within the time limit.
 * - `cancelled`: the user stopped the review, or the Kernel reported the turn as cancelled.
 * - `approval-required`: the Kernel asked for a tool approval the panel cannot grant.
 * - `output-truncated`: the model hit its token or turn limit before finishing.
 * - `refused`: the model declined to answer.
 * - `no-json`: the reply had no JSON object (for example the skill refused a missing file).
 * - `invalid-output`: the JSON object failed `validateReview`.
 */
export type ReviewFailureKind =
  | 'kernel-unavailable'
  | 'session-failed'
  | 'model-call-failed'
  | 'timeout'
  | 'cancelled'
  | 'approval-required'
  | 'output-truncated'
  | 'refused'
  | 'no-json'
  | 'invalid-output';

export interface ReviewFailure {
  kind: ReviewFailureKind;
  /** Error text, or the end of the model's reply for `no-json`, `refused`, `output-truncated`. */
  detail?: string;
  /** For `invalid-output`. */
  problems?: ReviewProblem[];
}

export type ReviewRunOutcome =
  | { ok: true; output: ReviewOutput }
  | { ok: false; failure: ReviewFailure };

export interface ReviewRun {
  result: Promise<ReviewRunOutcome>;
  /** Stops the review; the result becomes a `cancelled` failure unless it already settled. */
  cancel: () => void;
}

export interface ReviewRunOptions {
  timeoutMs?: number;
  /** How often to look for a pending approval request. */
  pollMs?: number;
}

/** A review reads the whole paper, so it gets well beyond a chat turn, but not forever. */
export const REVIEW_TIMEOUT_MS = 10 * 60 * 1000;
const APPROVAL_POLL_MS = 1000;

type Interrupt = 'timeout' | 'cancelled' | 'approval-required';

function failed(kind: ReviewFailureKind, detail?: string): ReviewRunOutcome {
  return { ok: false, failure: detail ? { kind, detail } : { kind } };
}

/** Maps a finished turn to the review it produced (requirement 19.1, 19.6). */
export function outcomeOfTurn(stopReason: string, replies: readonly string[]): ReviewRunOutcome {
  const excerpt = replyExcerpt(replies);
  switch (stopReason) {
    case 'cancelled':
      return failed('cancelled');
    case 'refusal':
      return failed('refused', excerpt);
    case 'max_tokens':
    case 'max_turn_requests':
      return failed('output-truncated', excerpt);
    default:
      break;
  }
  const extracted = extractReviewJson(replies);
  if (!extracted.found) return failed('no-json', excerpt);
  const validation = validateReview(extracted.value);
  if (!validation.valid) {
    return { ok: false, failure: { kind: 'invalid-output', problems: validation.problems } };
  }
  return { ok: true, output: validation.review };
}

/** Starts a review; `cancel` may be called at any time. */
export function startReview(
  request: ReviewRunRequest,
  kernel: ReviewKernel,
  options: ReviewRunOptions = {}
): ReviewRun {
  let cancelRequested = false;
  let signalCancel: () => void = () => undefined;
  const cancelled = new Promise<Interrupt>((resolve) => {
    signalCancel = () => resolve('cancelled');
  });
  const cancel = () => {
    cancelRequested = true;
    signalCancel();
  };
  const result = runReview(request, kernel, options, cancelled, () => cancelRequested);
  return { result, cancel };
}

async function runReview(
  request: ReviewRunRequest,
  kernel: ReviewKernel,
  options: ReviewRunOptions,
  cancelled: Promise<Interrupt>,
  isCancelled: () => boolean
): Promise<ReviewRunOutcome> {
  let unavailable: string | null;
  try {
    unavailable = await kernel.unavailableReason();
  } catch (error) {
    unavailable = describeError(error);
  }
  if (unavailable !== null) return failed('kernel-unavailable', unavailable);
  if (isCancelled()) return failed('cancelled');

  let timer: ReturnType<typeof setTimeout> | undefined;
  let poller: ReturnType<typeof setInterval> | undefined;
  const deadline = new Promise<Interrupt>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), options.timeoutMs ?? REVIEW_TIMEOUT_MS);
  });
  const interrupted = Promise.race([deadline, cancelled]);

  try {
    const opening = kernel.openSession(request.workingDir, request.sessionTitle).then(
      (sessionId) => ({ sessionId }),
      (error: unknown) => ({ error })
    );
    const opened = await Promise.race([opening, interrupted]);
    if (typeof opened === 'string') {
      // The session may still open after the deadline; close it once it does.
      void opening.then((late) => {
        if ('sessionId' in late) void kernel.closeSession(late.sessionId).catch(() => undefined);
      });
      return failed(opened);
    }
    if (!('sessionId' in opened)) return failed('session-failed', describeError(opened.error));

    const { sessionId } = opened;
    try {
      const approval = new Promise<Interrupt>((resolve) => {
        poller = setInterval(() => {
          if (kernel.isWaitingForUser(sessionId)) resolve('approval-required');
        }, options.pollMs ?? APPROVAL_POLL_MS);
      });
      const turn = kernel.prompt(sessionId, buildReviewPrompt(request)).then(
        (stopReason) => ({ stopReason }),
        (error: unknown) => ({ error })
      );
      const ended = await Promise.race([turn, interrupted, approval]);
      if (typeof ended === 'string') {
        await kernel.cancel(sessionId).catch(() => undefined);
        return failed(ended);
      }
      if (!('stopReason' in ended)) {
        return failed('model-call-failed', describeError(ended.error));
      }
      // A cancel that arrived while the reply was being read still wins: the user asked to stop.
      if (isCancelled()) return failed('cancelled');
      return outcomeOfTurn(ended.stopReason, kernel.replyTexts(sessionId));
    } finally {
      void kernel.closeSession(sessionId).catch(() => undefined);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (poller !== undefined) clearInterval(poller);
  }
}
