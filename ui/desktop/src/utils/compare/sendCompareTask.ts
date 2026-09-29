/**
 * Sends the comparison writing task to the chat session the workspace panel belongs to and waits
 * for the Kernel's turn to end (requirement 21.3, 21.6).
 *
 * The message takes the same path as one typed into the composer (`useChatSession`'s
 * `handleSubmit`): it is appended to the session store and submitted through the ACP chat
 * controller, so the chat shows the task, the streaming reply and the running state. The Kernel
 * check before sending is the one the dataset page uses (`getAgentKernelStatus`).
 */
import { isAcpRecovering } from '../../acp/acpConnection';
import { acpChatSessionController } from '../../acp/chatSessionController';
import { acpChatSessionActions, acpChatSessionStore } from '../../acp/chatSessionStore';
import { AppEvents } from '../../constants/events';
import { ChatState } from '../../types/chatState';
import { createUserMessage } from '../../types/message';
import { COMPARE_TASK_TIMEOUT_SECONDS } from './compareTask';

/**
 * Why the paragraph was not generated. The first three are the categories of requirement 21.6;
 * `busy` means the session was already running a turn, so nothing was sent.
 */
export type CompareTaskReason = 'kernelUnavailable' | 'timeout' | 'kernelError' | 'busy';

export type CompareTaskOutcome =
  | { ok: true }
  | { ok: false; reason: CompareTaskReason; detail: string };

function failure(reason: CompareTaskReason, detail: string): CompareTaskOutcome {
  return { ok: false, reason, detail };
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

/** A reason the Kernel cannot take the task, or `null` when it looks available. */
async function kernelProblem(): Promise<string | null> {
  if (isAcpRecovering()) {
    return 'reconnecting to the Kernel';
  }
  try {
    const status = await window.electron.getAgentKernelStatus?.();
    return status?.error ?? null;
  } catch {
    // Same as the dataset page: a failing status query does not prove the Kernel is down.
    return null;
  }
}

/** A credits notice the controller adds instead of rejecting counts as a Kernel error. */
function outcomeAfter(
  sessionId: string,
  messageId: string | null | undefined
): CompareTaskOutcome {
  const messages = acpChatSessionStore.getSnapshot(sessionId)?.messages ?? [];
  const start =
    messageId == null ? -1 : messages.findIndex((message) => message.id === messageId);
  if (start < 0) {
    return { ok: true };
  }
  for (const message of messages.slice(start + 1)) {
    for (const content of message.content) {
      if (
        content.type === 'systemNotification' &&
        content.notificationType === 'creditsExhausted'
      ) {
        return failure('kernelError', content.msg);
      }
    }
  }
  return { ok: true };
}

export async function sendCompareTask(
  sessionId: string,
  text: string,
  timeoutMs: number = COMPARE_TASK_TIMEOUT_SECONDS * 1000
): Promise<CompareTaskOutcome> {
  const unavailable = await kernelProblem();
  if (unavailable !== null) {
    return failure('kernelUnavailable', unavailable);
  }
  const snapshot = acpChatSessionStore.getSnapshot(sessionId);
  if (!snapshot?.session) {
    return failure('kernelUnavailable', snapshot?.sessionLoadError ?? 'the session is not loaded');
  }
  if (
    snapshot.chatState !== ChatState.Idle ||
    snapshot.activePromptAttemptId !== null ||
    snapshot.pendingCancelPromptAttemptId !== null
  ) {
    return failure('busy', `chat state is ${snapshot.chatState}`);
  }

  const message = createUserMessage(text);
  if (snapshot.messages.length === 0) {
    window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED));
  }
  acpChatSessionActions.setMessages(sessionId, [...snapshot.messages, message]);

  return new Promise<CompareTaskOutcome>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (outcome: CompareTaskOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    timer = setTimeout(() => {
      finish(failure('timeout', `no result within ${Math.round(timeoutMs / 1000)} seconds`));
      // Stop the turn so the chat is usable again and a retry does not queue behind it.
      acpChatSessionController.stop(sessionId);
    }, timeoutMs);

    const submitted = acpChatSessionController.submitMessage(sessionId, message, {
      getCurrentSnapshot: () => acpChatSessionStore.getSnapshot(sessionId),
      onFinish: (error) => {
        finish(error ? failure('kernelError', error) : outcomeAfter(sessionId, message.id));
      },
    });
    submitted.then(
      // Resolving without `onFinish` means the turn was cancelled, for example from the chat.
      () => finish(failure('kernelError', 'the turn ended without a result')),
      (error: unknown) => finish(failure('kernelError', errorText(error)))
    );
  });
}
