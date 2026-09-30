/**
 * Sends a task to a chat session and waits for the Kernel's turn to end. Shared by the run
 * comparison tab ("生成对比段落", requirement 21.3, 21.6) and the dataset page ("生成数据说明",
 * requirement 10.3, 10.6).
 *
 * The message takes the same path as one typed into the composer (`useChatSession`'s
 * `handleSubmit`): it is appended to the session store and submitted through the ACP chat
 * controller, so the chat shows the task, the streaming reply and the running state. Before
 * sending, the Kernel is checked with `getAgentKernelStatus`.
 */
import { isAcpRecovering } from '../acp/acpConnection';
import { acpChatSessionController } from '../acp/chatSessionController';
import { acpChatSessionActions, acpChatSessionStore } from '../acp/chatSessionStore';
import { AppEvents } from '../constants/events';
import { ChatState } from '../types/chatState';
import { createUserMessage } from '../types/message';

/**
 * Why the task produced no result. The first three are the failure categories of requirement
 * 21.6, which also cover requirement 10.6; `busy` means the session was already running a
 * turn, so nothing was sent.
 */
export type SessionTaskReason = 'kernelUnavailable' | 'timeout' | 'kernelError' | 'busy';

export type SessionTaskOutcome =
  | { ok: true }
  | { ok: false; reason: SessionTaskReason; detail: string };

function failure(reason: SessionTaskReason, detail: string): SessionTaskOutcome {
  return { ok: false, reason, detail };
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

/** A reason the Kernel cannot take a task, or `null` when it looks available. */
export async function kernelUnavailableReason(): Promise<string | null> {
  if (isAcpRecovering()) {
    return 'reconnecting to the Kernel';
  }
  try {
    const status = await window.electron.getAgentKernelStatus?.();
    return status?.error ?? null;
  } catch {
    // A failing status query does not prove the Kernel is down.
    return null;
  }
}

function normalizeDirectory(dir: string): string {
  const unified = dir.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  const trimmed = unified.length > 1 ? unified.replace(/\/+$/, '') : unified;
  // Windows drive paths are case-insensitive.
  return /^[a-z]:(\/|$)/i.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

/** Whether two paths name the same directory, ignoring separators and trailing slashes. */
export function isSameDirectory(a: string, b: string): boolean {
  return normalizeDirectory(a) === normalizeDirectory(b);
}

/**
 * The chat session a task about files under `workingDir` can be sent to: `sessionId` when the
 * session store holds it and, once its metadata is loaded, it works in that directory, so paths
 * relative to `workingDir` mean the same to the Kernel. `null` means there is no such session
 * and the caller should fall back, for example to the home composer.
 */
export function sessionTaskTarget(
  sessionId: string | null | undefined,
  workingDir: string
): string | null {
  if (!sessionId) {
    return null;
  }
  const snapshot = acpChatSessionStore.getSnapshot(sessionId);
  if (!snapshot) {
    return null;
  }
  const sessionDir = snapshot.session?.working_dir;
  if (sessionDir && !isSameDirectory(sessionDir, workingDir)) {
    return null;
  }
  return sessionId;
}

/** A credits notice the controller adds instead of rejecting counts as a Kernel error. */
function outcomeAfter(
  sessionId: string,
  messageId: string | null | undefined
): SessionTaskOutcome {
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

/**
 * Appends `text` to the session as a user message and resolves when the turn ends. After
 * `timeoutMs` without a result the turn is stopped, so the chat is usable again and a retry
 * does not queue behind it.
 */
export async function sendSessionTask(
  sessionId: string,
  text: string,
  timeoutMs: number
): Promise<SessionTaskOutcome> {
  const unavailable = await kernelUnavailableReason();
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

  return new Promise<SessionTaskOutcome>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (outcome: SessionTaskOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    timer = setTimeout(() => {
      finish(failure('timeout', `no result within ${Math.round(timeoutMs / 1000)} seconds`));
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
