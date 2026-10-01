/**
 * Feishu (Lark) connector core (requirement 15). Whitelisted private-chat text drives a desktop
 * session over a dedicated ACP connection; the acknowledgement, progress, approval requests and
 * the result summary go back to the same chat. Transport-agnostic: the Feishu long connection,
 * the message sender, the ACP session surface and the settings store are injected as ports, so
 * the whole message and approval lifecycle runs in tests without a backend.
 *
 * - Inbound messages pass `routeInbound` first; everything else gets no reply at all (15.1, 15.3).
 * - A chat maps to one desktop session, persisted through the store; later messages of the chat
 *   go to the same session: a new turn when it is idle, a steer of the running turn otherwise,
 *   or the next turn when steering is not possible (15.1).
 * - The turn is handed to the Kernel before the acknowledgement is sent (15.1). Its end is
 *   reported right away: `formatSummary` on completion (15.2), the failure category otherwise
 *   (15.6). A reply is retried every 30 seconds, at most 3 times; a result that still cannot be
 *   delivered marks the session as undelivered (15.2).
 * - Progress follows `progressMessages`: after 60 seconds, at most one every 5 minutes, never
 *   while an approval is pending (15.7).
 * - Tool approvals become one-time codes; only `批准 <code>` / `拒绝 <code>` from the same chat
 *   answers them, and 10 minutes without an answer is a timeout (15.4, 15.5).
 */
import { randomInt, randomUUID } from 'node:crypto';
import { normalizeWhitelist, routeInbound, type FeishuInboundMessage } from './routing';
import { formatSummary } from './replyFormat';
import { progressMessages, type ProgressEvent } from './progressThrottle';
import {
  FEISHU_NO_STEP_YET,
  acceptedText,
  approvalApprovedText,
  approvalRejectedText,
  approvalTimedOutText,
  approvalUnknownCodeText,
  buildApprovalMessage,
  failureText,
  generateApprovalCode,
  parseApprovalReply,
  progressText,
  queuedText,
  sessionUnavailableText,
  steeredText,
  type FeishuApprovalReply,
  type FeishuFailureCategory,
} from './feishuReplies';

export type { FeishuFailureCategory } from './feishuReplies';

export const FEISHU_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
export const FEISHU_RETRY_INTERVAL_MS = 30 * 1000;
export const FEISHU_RETRY_MAX = 3;
/** How often a running task checks whether a progress message is due. */
export const FEISHU_PROGRESS_TICK_MS = 30 * 1000;
/** Feishu may deliver an event more than once; this many recent message ids are remembered. */
const SEEN_MESSAGE_LIMIT = 500;

export interface FeishuInboundEvent {
  /** Feishu `message_id`; empty when unknown, which disables duplicate detection. */
  messageId: string;
  chatId: string;
  message: FeishuInboundMessage;
}

export interface FeishuApprovalRequest {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  /** Text form of the tool arguments; the approval message keeps at most 500 code points. */
  arguments: string;
}

export type FeishuApprovalDecision =
  | { outcome: 'allow' }
  | { outcome: 'deny'; reason: 'rejected' | 'timeout' }
  /** The turn ended or the connector stopped before anyone answered. */
  | { outcome: 'cancelled' };

export type FeishuTurnOutcome =
  | {
      status: 'completed';
      /** Status line of the summary, e.g. `完成`. */
      statusText: string;
      artifactFileNames: string[];
      /** Final assistant reply of the turn. */
      reply: string;
    }
  | { status: 'failed'; failure: FeishuFailureCategory };

export type FeishuSessionEvent =
  | { type: 'step-completed'; sessionId: string; stepName: string }
  /** The ACP connection closed; pending approvals can no longer be answered. */
  | { type: 'disconnected' };

export interface FeishuMessenger {
  /**
   * Sends a text message to a chat and rejects when Feishu did not accept it. Retries of one
   * reply reuse `idempotencyKey`, so a retry after a lost response cannot post it twice.
   */
  sendText: (chatId: string, text: string, idempotencyKey: string) => Promise<void>;
}

export interface FeishuSessionRef {
  sessionId: string;
  name: string;
}

export interface FeishuAcpPort {
  /** Creates the desktop session of a new private chat. */
  createSession: (firstMessage: string) => Promise<FeishuSessionRef>;
  /** Current name of a session; null when the session no longer exists. */
  sessionInfo: (sessionId: string) => Promise<{ name: string } | null>;
  /** Runs one turn; resolves when the turn ends. */
  prompt: (sessionId: string, text: string) => Promise<FeishuTurnOutcome>;
  /** Adds text to the running turn; false when the session has no turn to steer. */
  steer: (sessionId: string, text: string) => Promise<boolean>;
  onPermissionRequest: (
    handler: (request: FeishuApprovalRequest) => Promise<FeishuApprovalDecision>
  ) => () => void;
  onSessionEvent: (handler: (event: FeishuSessionEvent) => void) => () => void;
}

export interface FeishuStateStore {
  /** Chat id → session of that private chat. */
  loadChats: () => Promise<Record<string, FeishuSessionRef>>;
  saveChats: (chats: Record<string, FeishuSessionRef>) => Promise<void>;
  /** Records "飞书回复未送达" on the desktop session; its result stays in the session. */
  markUndelivered: (sessionId: string) => Promise<void>;
}

export interface FeishuConnectorOptions {
  whitelist: readonly string[];
  messenger: FeishuMessenger;
  acp: FeishuAcpPort;
  store: FeishuStateStore;
  /** Registers the inbound message handler; returns the function that removes it. */
  subscribe: (handler: (event: FeishuInboundEvent) => void) => () => void;
  now?: () => number;
  randomInt?: (max: number) => number;
  newId?: () => string;
  log?: (message: string) => void;
  /** Masks key values; applied to logs and to every outgoing message. */
  redact?: (text: string) => string;
  retryIntervalMs?: number;
  retryMax?: number;
  approvalTimeoutMs?: number;
  progressTickMs?: number;
}

export interface FeishuConnector {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  status: () => { started: boolean };
}

interface Task {
  sessionId: string;
  chatId: string;
  startedAt: number;
  events: ProgressEvent[];
  progressSent: number;
  lastStep: string | null;
  /** Approval requests of this turn still waiting for an answer. */
  pendingApprovals: number;
  /** Messages that arrived while the turn ran and could not be steered into it. */
  queued: string[];
  ticker: ReturnType<typeof setInterval> | null;
}

interface PendingApproval {
  code: string;
  chatId: string;
  sessionId: string;
  toolName: string;
  settle: (decision: FeishuApprovalDecision, reply: string | null) => void;
}

export function createFeishuConnector(options: FeishuConnectorOptions): FeishuConnector {
  const now = options.now ?? (() => Date.now());
  const nextInt = options.randomInt ?? ((max: number) => randomInt(max));
  const newId = options.newId ?? (() => randomUUID());
  const log = options.log ?? (() => {});
  const redact = options.redact ?? ((text: string) => text);
  const retryIntervalMs = options.retryIntervalMs ?? FEISHU_RETRY_INTERVAL_MS;
  const retryMax = options.retryMax ?? FEISHU_RETRY_MAX;
  const approvalTimeoutMs = options.approvalTimeoutMs ?? FEISHU_APPROVAL_TIMEOUT_MS;
  const progressTickMs = options.progressTickMs ?? FEISHU_PROGRESS_TICK_MS;
  const whitelist = normalizeWhitelist(options.whitelist);

  let started = false;
  let unsubscribers: Array<() => void> = [];

  const chats = new Map<string, FeishuSessionRef>(); // chatId -> session
  const sessionChats = new Map<string, string>(); // sessionId -> chatId
  const tasks = new Map<string, Task>(); // sessionId -> running turn
  const approvals = new Map<string, PendingApproval>(); // code -> pending approval
  const chatQueues = new Map<string, Promise<void>>(); // chatId -> serialized work
  const seenMessages = new Set<string>();
  const seenOrder: string[] = [];

  const describe = (error: unknown): string =>
    redact(error instanceof Error ? error.message || error.name : String(error));

  /** Sends one reply, retrying every `retryIntervalMs` up to `retryMax` times. */
  const deliver = async (chatId: string, text: string): Promise<boolean> => {
    const key = newId();
    const body = redact(text);
    for (let attempt = 0; attempt <= retryMax; attempt += 1) {
      if (!started) {
        return false;
      }
      try {
        await options.messenger.sendText(chatId, body, key);
        return true;
      } catch (error) {
        log(`reply failed (attempt ${attempt + 1} of ${retryMax + 1}): ${describe(error)}`);
        if (attempt < retryMax) {
          await delay(retryIntervalMs);
        }
      }
    }
    return false;
  };

  /** A task result that cannot be delivered is marked on the desktop session (15.2). */
  const deliverResult = async (task: Task, text: string): Promise<void> => {
    if (await deliver(task.chatId, text)) {
      return;
    }
    if (!started) {
      return;
    }
    try {
      await options.store.markUndelivered(task.sessionId);
    } catch (error) {
      log(`marking ${task.sessionId} as undelivered failed: ${describe(error)}`);
    }
  };

  /** Work for one chat runs in order, so its session is created once and state stays coherent. */
  const enqueue = (chatId: string, work: () => Promise<void>): void => {
    const previous = chatQueues.get(chatId) ?? Promise.resolve();
    const next = previous.then(work).catch((error: unknown) => {
      log(`handling a message failed: ${describe(error)}`);
    });
    chatQueues.set(chatId, next);
    void next.then(() => {
      if (chatQueues.get(chatId) === next) {
        chatQueues.delete(chatId);
      }
    });
  };

  const isDuplicate = (messageId: string): boolean => {
    if (!messageId) {
      return false;
    }
    if (seenMessages.has(messageId)) {
      return true;
    }
    seenMessages.add(messageId);
    seenOrder.push(messageId);
    while (seenOrder.length > SEEN_MESSAGE_LIMIT) {
      const oldest = seenOrder.shift();
      if (oldest !== undefined) {
        seenMessages.delete(oldest);
      }
    }
    return false;
  };

  const persistChats = async (): Promise<void> => {
    try {
      await options.store.saveChats(Object.fromEntries(chats));
    } catch (error) {
      log(`saving the chat sessions failed: ${describe(error)}`);
    }
  };

  const bindChat = (chatId: string, session: FeishuSessionRef): void => {
    const previous = chats.get(chatId);
    if (previous) {
      sessionChats.delete(previous.sessionId);
    }
    chats.set(chatId, session);
    sessionChats.set(session.sessionId, chatId);
  };

  /** The session of a chat: the mapped one while it exists, otherwise a new one. */
  const sessionForChat = async (chatId: string, text: string): Promise<FeishuSessionRef> => {
    const known = chats.get(chatId);
    if (known) {
      let info: { name: string } | null | undefined;
      try {
        info = await options.acp.sessionInfo(known.sessionId);
      } catch (error) {
        // Not knowing the current name is no reason to drop the session.
        log(`reading session ${known.sessionId} failed: ${describe(error)}`);
        info = undefined;
      }
      if (info !== null) {
        const name = info?.name || known.name;
        if (name !== known.name) {
          bindChat(chatId, { sessionId: known.sessionId, name });
          await persistChats();
        }
        return { sessionId: known.sessionId, name };
      }
      log(`session ${known.sessionId} no longer exists; starting a new one for the chat`);
    }
    const created = await options.acp.createSession(text);
    bindChat(chatId, created);
    await persistChats();
    return created;
  };

  const sendProgress = (task: Task): void => {
    const messages = progressMessages({ startMs: task.startedAt, events: task.events, end: null });
    while (task.progressSent < messages.length) {
      const message = messages[task.progressSent];
      task.progressSent += 1;
      void deliver(task.chatId, progressText(message.elapsedMs, message.stepName));
    }
  };

  const recordProgress = (task: Task, stepName: string): void => {
    // Progress stops while an approval is pending (15.7) and resumes after it is answered.
    if (task.pendingApprovals > 0) {
      return;
    }
    task.events.push({ atMs: now(), stepName });
    sendProgress(task);
  };

  const settleApprovals = (sessionId: string | null): void => {
    for (const pending of [...approvals.values()]) {
      if (sessionId === null || pending.sessionId === sessionId) {
        pending.settle({ outcome: 'cancelled' }, null);
      }
    }
  };

  const startTurn = (session: FeishuSessionRef, chatId: string, text: string): Task => {
    const task: Task = {
      sessionId: session.sessionId,
      chatId,
      startedAt: now(),
      events: [],
      progressSent: 0,
      lastStep: null,
      pendingApprovals: 0,
      queued: [],
      ticker: null,
    };
    tasks.set(session.sessionId, task);
    const ticker = setInterval(() => {
      recordProgress(task, task.lastStep ?? FEISHU_NO_STEP_YET);
    }, progressTickMs);
    ticker.unref?.();
    task.ticker = ticker;

    // The turn goes to the Kernel first; its end is handled in this chat's order.
    let turn: Promise<FeishuTurnOutcome>;
    try {
      turn = options.acp.prompt(session.sessionId, text);
    } catch (error) {
      turn = Promise.reject(error);
    }
    turn.then(
      (outcome) => enqueue(chatId, () => finishTurn(task, outcome)),
      (error: unknown) => {
        log(`turn of ${session.sessionId} failed: ${describe(error)}`);
        enqueue(chatId, () => finishTurn(task, { status: 'failed', failure: '内核异常' }));
      }
    );
    return task;
  };

  const finishTurn = async (task: Task, outcome: FeishuTurnOutcome): Promise<void> => {
    if (task.ticker) {
      clearInterval(task.ticker);
      task.ticker = null;
    }
    if (tasks.get(task.sessionId) === task) {
      tasks.delete(task.sessionId);
    }
    settleApprovals(task.sessionId);
    if (!started) {
      return;
    }

    const name = chats.get(task.chatId)?.name ?? task.sessionId;
    const text =
      outcome.status === 'completed'
        ? formatSummary({
            status: outcome.statusText,
            artifactFileNames: outcome.artifactFileNames,
            reply: outcome.reply,
          })
        : failureText(outcome.failure, name);
    void deliverResult(task, text);

    if (task.queued.length > 0) {
      const session = chats.get(task.chatId);
      if (session) {
        startTurn(session, task.chatId, task.queued.join('\n\n'));
      }
    }
  };

  const answerApproval = (chatId: string, reply: FeishuApprovalReply): void => {
    const pending = approvals.get(reply.code);
    if (!pending || pending.chatId !== chatId) {
      void deliver(chatId, approvalUnknownCodeText(reply.code));
      return;
    }
    if (reply.action === 'approve') {
      pending.settle({ outcome: 'allow' }, approvalApprovedText(pending.toolName));
    } else {
      pending.settle(
        { outcome: 'deny', reason: 'rejected' },
        approvalRejectedText(pending.toolName)
      );
    }
  };

  const handleMessage = async (event: FeishuInboundEvent): Promise<void> => {
    const text = event.message.text;
    // Approval replies are never forwarded as tasks (15.4).
    const approval = parseApprovalReply(text);
    if (approval) {
      answerApproval(event.chatId, approval);
      return;
    }

    let session: FeishuSessionRef;
    try {
      session = await sessionForChat(event.chatId, text);
    } catch (error) {
      log(`creating a session for a chat failed: ${describe(error)}`);
      void deliver(event.chatId, sessionUnavailableText());
      return;
    }
    if (!started) {
      return;
    }

    const running = tasks.get(session.sessionId);
    if (running) {
      let steered = false;
      try {
        steered = await options.acp.steer(session.sessionId, text);
      } catch (error) {
        log(`steering ${session.sessionId} failed: ${describe(error)}`);
      }
      if (steered) {
        void deliver(event.chatId, steeredText(session.name));
      } else {
        running.queued.push(text);
        void deliver(event.chatId, queuedText(session.name));
      }
      return;
    }

    startTurn(session, event.chatId, text);
    void deliver(event.chatId, acceptedText(session.name));
  };

  const onInbound = (event: FeishuInboundEvent): void => {
    if (!started || isDuplicate(event.messageId)) {
      return;
    }
    // Group chats, non-text messages and accounts outside the whitelist get no reply (15.3).
    if (routeInbound(event.message, whitelist) !== 'forward') {
      return;
    }
    enqueue(event.chatId, () => handleMessage(event));
  };

  const uniqueCode = (): string => {
    for (;;) {
      const code = generateApprovalCode(nextInt);
      if (!approvals.has(code)) {
        return code;
      }
    }
  };

  const onPermissionRequest = (request: FeishuApprovalRequest): Promise<FeishuApprovalDecision> =>
    new Promise<FeishuApprovalDecision>((resolve) => {
      const chatId = sessionChats.get(request.sessionId);
      if (!started || !chatId) {
        resolve({ outcome: 'cancelled' });
        return;
      }
      const code = uniqueCode();
      const task = tasks.get(request.sessionId);
      if (task) {
        task.pendingApprovals += 1;
      }
      const settle = (decision: FeishuApprovalDecision, reply: string | null): void => {
        if (!approvals.delete(code)) {
          return;
        }
        clearTimeout(timer);
        if (task) {
          task.pendingApprovals = Math.max(0, task.pendingApprovals - 1);
        }
        resolve(decision);
        if (reply) {
          void deliver(chatId, reply);
        }
      };
      const timer = setTimeout(
        () =>
          settle({ outcome: 'deny', reason: 'timeout' }, approvalTimedOutText(request.toolName)),
        approvalTimeoutMs
      );
      timer.unref?.();
      approvals.set(code, {
        code,
        chatId,
        sessionId: request.sessionId,
        toolName: request.toolName,
        settle,
      });
      void deliver(chatId, buildApprovalMessage(request.toolName, request.arguments, code));
    });

  const onSessionEvent = (event: FeishuSessionEvent): void => {
    if (event.type === 'disconnected') {
      settleApprovals(null);
      return;
    }
    const task = tasks.get(event.sessionId);
    if (!task) {
      return;
    }
    task.lastStep = event.stepName;
    recordProgress(task, event.stepName);
  };

  return {
    start: async () => {
      if (started) {
        return;
      }
      const stored = await options.store.loadChats();
      for (const [chatId, session] of Object.entries(stored)) {
        if (session && typeof session.sessionId === 'string' && session.sessionId) {
          bindChat(chatId, {
            sessionId: session.sessionId,
            name:
              typeof session.name === 'string' && session.name ? session.name : session.sessionId,
          });
        }
      }
      started = true;
      unsubscribers = [
        options.subscribe(onInbound),
        options.acp.onPermissionRequest(onPermissionRequest),
        options.acp.onSessionEvent(onSessionEvent),
      ];
    },
    stop: async () => {
      if (!started) {
        return;
      }
      started = false;
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
      unsubscribers = [];
      settleApprovals(null);
      for (const task of tasks.values()) {
        if (task.ticker) {
          clearInterval(task.ticker);
          task.ticker = null;
        }
      }
      tasks.clear();
    },
    status: () => ({ started }),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
