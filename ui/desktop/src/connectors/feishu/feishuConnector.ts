/**
 * Feishu (Lark) connector (requirement 15). Inbound private-chat text messages from whitelisted
 * accounts drive a dedicated ACP session; results, progress and approval requests flow back to
 * the same chat. The SDK long connection and the ACP session are injected as ports so the
 * message/approval lifecycle can be tested without a live backend.
 */
import { randomInt } from 'node:crypto';
import { normalizeWhitelist, routeInbound, type FeishuInboundMessage } from './routing';
import { formatSummary } from './replyFormat';
import { progressMessages, type ProgressEvent, type ProgressPhase } from './progressThrottle';
import { truncateText } from '../../utils/textTruncate';

export const FEISHU_APPROVAL_TEXT_LIMIT = 500;
export const FEISHU_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
export const FEISHU_ACCEPT_WINDOW_MS = 5 * 1000;
export const FEISHU_RETRY_INTERVAL_MS = 30 * 1000;
export const FEISHU_RETRY_MAX = 3;

export const FEISHU_APPROVAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type FeishuFailureCategory =
  | '模型供应商错误'
  | '工具执行错误'
  | '用户中断'
  | '内核异常';

export interface FeishuInboundEvent {
  chatId: string;
  message: FeishuInboundMessage;
}

export interface FeishuApprovalRequest {
  sessionId: string;
  chatId: string;
  toolName: string;
  arguments: string;
}

export type FeishuApprovalOutcome = 'approve' | 'reject' | null;

export interface FeishuRunUpdate {
  sessionId: string;
  status: 'running' | 'completed' | 'failed' | 'awaiting-approval';
  /** Only present when status is 'running': the most recently completed step. */
  stepName?: string;
  artifactFileNames?: string[];
  failure?: FeishuFailureCategory;
  startedAt: number;
  finishedAt?: number;
}

export interface FeishuSendPort {
  sendText: (receiveId: string, text: string) => Promise<void>;
}

export interface FeishuAcpPort {
  /** Creates a desktop session for a new private chat; returns its id and display name. */
  createSession: () => Promise<{ sessionId: string; name: string }>;
  prompt: (sessionId: string, text: string) => Promise<void>;
  respondPermission: (
    request: FeishuApprovalRequest,
    outcome: 'allow' | 'deny',
    reason?: string
  ) => Promise<void>;
  markUndelivered: (sessionId: string) => Promise<void>;
  onPermissionRequest: (
    handler: (request: FeishuApprovalRequest) => void
  ) => () => void;
  onRunUpdate: (handler: (update: FeishuRunUpdate) => void) => () => void;
}

export interface FeishuConnectorOptions {
  whitelist: readonly string[];
  send: FeishuSendPort;
  acp: FeishuAcpPort;
  /** Persists the chat → session mapping and reads it back. */
  store: FeishuSessionStore;
  onMessage: (handler: (event: FeishuInboundEvent) => void) => () => void;
  now?: () => number;
  randomInt?: (max: number) => number;
  log?: (message: string) => void;
  redact?: (text: string) => string;
  /** Injectable timing so the reply retry and approval timeout are fast in tests. */
  retryIntervalMs?: number;
  retryMax?: number;
  approvalTimeoutMs?: number;
}

export interface FeishuSessionStore {
  load: () => Promise<Record<string, string>>;
  save: (mapping: Record<string, string>) => Promise<void>;
}

/** Builds the approval prompt: tool name and an argument summary capped at 500 code points. */
export function buildApprovalMessage(toolName: string, args: string, code: string): string {
  const summary = truncateText(args, FEISHU_APPROVAL_TEXT_LIMIT, { ellipsis: '…' });
  return `工具审批：${toolName}\n参数：${summary}\n回复「批准 ${code}」执行，或「拒绝 ${code}」拒绝（10 分钟内有效）。`;
}

/** Recognizes an approval reply. Only an exact `批准 <code>` / `拒绝 <code>` matches. */
export function parseApprovalReply(text: string, code: string): FeishuApprovalOutcome {
  const normalized = text.trim();
  if (normalized === `批准 ${code}`) {
    return 'approve';
  }
  if (normalized === `拒绝 ${code}`) {
    return 'reject';
  }
  return null;
}

export function generateApprovalCode(nextInt: (max: number) => number = (max) => randomInt(max)): string {
  return Array.from({ length: 6 }, () => FEISHU_APPROVAL_ALPHABET[nextInt(FEISHU_APPROVAL_ALPHABET.length)]).join(
    ''
  );
}

interface PendingApproval {
  code: string;
  request: FeishuApprovalRequest;
}

export interface FeishuConnector {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  status: () => { started: boolean };
}

export function createFeishuConnector(options: FeishuConnectorOptions): FeishuConnector {
  const now = options.now ?? (() => Date.now());
  const nextInt = options.randomInt ?? ((max) => randomInt(max));
  const log = options.log ?? (() => {});
  const redact = options.redact ?? ((text) => text);
  const retryIntervalMs = options.retryIntervalMs ?? FEISHU_RETRY_INTERVAL_MS;
  const retryMax = options.retryMax ?? FEISHU_RETRY_MAX;
  const approvalTimeoutMs = options.approvalTimeoutMs ?? FEISHU_APPROVAL_TIMEOUT_MS;

  let started = false;
  let stopMessage: (() => void) | null = null;
  let stopPermission: (() => void) | null = null;
  let stopRun: (() => void) | null = null;

  const chatSessions = new Map<string, string>(); // chatId -> sessionId
  const sessionChats = new Map<string, string>(); // sessionId -> chatId
  const pendingApprovals = new Map<string, PendingApproval>(); // code -> pending
  const runs = new Map<string, { startedAt: number; events: ProgressEvent[]; sentCount: number; ended: boolean }>();

  const whitelist = normalizeWhitelist(options.whitelist);

  const reply = async (chatId: string, text: string): Promise<boolean> => {
    for (let attempt = 0; attempt <= retryMax; attempt += 1) {
      try {
        await options.send.sendText(chatId, text);
        return true;
      } catch (error) {
        log(`feishu reply failed (attempt ${attempt + 1}): ${redact(String(error))}`);
        if (attempt < retryMax) {
          await delay(retryIntervalMs);
        }
      }
    }
    return false;
  };

  const sessionForChat = async (chatId: string): Promise<{ sessionId: string; name: string }> => {
    const existing = chatSessions.get(chatId);
    if (existing) {
      return { sessionId: existing, name: existing };
    }
    const created = await options.acp.createSession();
    chatSessions.set(chatId, created.sessionId);
    sessionChats.set(created.sessionId, chatId);
    await options.store.save(Object.fromEntries(chatSessions));
    return created;
  };

  const handleMessage = async (event: FeishuInboundEvent): Promise<void> => {
    // Only whitelisted private-chat text is considered at all, approval replies included:
    // an account outside the whitelist can neither start a task nor approve a tool call.
    if (routeInbound(event.message, whitelist) !== 'forward') {
      return;
    }

    // Approval replies are never forwarded as new tasks.
    for (const [code, pending] of pendingApprovals) {
      if (pending.request.chatId !== event.chatId) {
        continue;
      }
      const outcome = parseApprovalReply(event.message.text, code);
      if (outcome === 'approve') {
        pendingApprovals.delete(code);
        await options.acp.respondPermission(pending.request, 'allow');
        return;
      }
      if (outcome === 'reject') {
        pendingApprovals.delete(code);
        await options.acp.respondPermission(pending.request, 'deny', '用户拒绝');
        await reply(event.chatId, '已拒绝，工具调用未执行。');
        return;
      }
    }

    const { sessionId, name } = await sessionForChat(event.chatId);
    // `session/prompt` resolves only when the whole turn ends, so the task is handed to the
    // Kernel without waiting and the acknowledgement goes out right away (requirement 15.1).
    // The rejection handler is attached immediately so a failed prompt is never unhandled.
    const running = options.acp.prompt(sessionId, event.message.text).catch(async (error) => {
      log(`feishu prompt failed for ${sessionId}: ${redact(String(error))}`);
      const sent = await reply(event.chatId, '任务失败：内核异常。已产生的记录保留在 ModelForge 对应会话中。');
      if (!sent) {
        await options.acp.markUndelivered(sessionId);
      }
    });
    await reply(event.chatId, `已受理，会话「${name}」开始处理。`);
    void running;
  };

  const onPermission = (request: FeishuApprovalRequest): void => {
    const code = generateApprovalCode(nextInt);
    const pending: PendingApproval = {
      code,
      request,
    };
    pendingApprovals.set(code, pending);
    void reply(request.chatId, buildApprovalMessage(request.toolName, request.arguments, code));
    setTimeout(() => {
      if (!pendingApprovals.has(code)) {
        return;
      }
      pendingApprovals.delete(code);
      void options.acp.respondPermission(request, 'deny', '已超时');
      void reply(request.chatId, '审批已超时，工具调用未执行。');
    }, approvalTimeoutMs).unref?.();
  };

  const onRunUpdate = async (update: FeishuRunUpdate): Promise<void> => {
    const chatId = sessionChats.get(update.sessionId);
    if (!chatId) {
      return;
    }
    if (update.status === 'completed') {
      const run = runs.get(update.sessionId);
      if (run) {
        run.ended = true;
      }
      const sent = await reply(
        chatId,
        formatSummary({ status: '完成', artifactFileNames: update.artifactFileNames ?? [] })
      );
      if (!sent) {
        await options.acp.markUndelivered(update.sessionId);
      }
      return;
    }
    if (update.status === 'failed') {
      const sent = await reply(chatId, `任务失败：${update.failure ?? '内核异常'}。`);
      if (!sent) {
        await options.acp.markUndelivered(update.sessionId);
      }
      return;
    }
    if (update.status === 'awaiting-approval') {
      const run = runs.get(update.sessionId);
      if (run) {
        run.ended = true;
      }
      return;
    }
    if (update.status === 'running' && update.stepName) {
      const run = runs.get(update.sessionId) ?? {
        startedAt: update.startedAt,
        events: [],
        sentCount: 0,
        ended: false,
      };
      run.events.push({ atMs: now(), stepName: update.stepName });
      const phase: ProgressPhase | null = run.ended ? 'completed' : null;
      const messages = progressMessages({
        startMs: run.startedAt,
        events: run.events,
        end: phase ? { atMs: now(), phase } : null,
      });
      while (run.sentCount < messages.length) {
        const message = messages[run.sentCount];
        run.sentCount += 1;
        const seconds = Math.floor(message.elapsedMs / 1000);
        void reply(chatId, `运行中（${seconds} 秒）：最近完成「${message.stepName}」。`);
      }
      runs.set(update.sessionId, run);
    }
  };

  return {
    start: async () => {
      if (started) {
        return;
      }
      const stored = await options.store.load();
      for (const [chatId, sessionId] of Object.entries(stored)) {
        chatSessions.set(chatId, sessionId);
        sessionChats.set(sessionId, chatId);
      }
      stopMessage = options.onMessage((event) => void handleMessage(event));
      stopPermission = options.acp.onPermissionRequest(onPermission);
      stopRun = options.acp.onRunUpdate(onRunUpdate);
      started = true;
    },
    stop: async () => {
      if (!started) {
        return;
      }
      stopMessage?.();
      stopPermission?.();
      stopRun?.();
      started = false;
    },
    status: () => ({ started }),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
