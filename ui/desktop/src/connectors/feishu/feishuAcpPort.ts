/**
 * The Feishu connector's own ACP connection to the desktop's `goose serve` (requirement 15,
 * tasks 19.5 and 19.6). Feishu-triggered sessions are created and driven on this connection
 * rather than the renderer's, so their `session/request_permission` requests come back here
 * and are answered from Feishu. A denial carries its reason in the response's
 * `_meta["modelforge/permission"]`, which the Kernel turns into the "已拒绝" or "已超时" tool
 * result (`crates/goose/src/acp/server/permission_reason.rs`).
 *
 * The connection opens on first use and opens again after it closes; the stream itself
 * (the primary window's lease, with its pinned certificate) comes from `openStream`.
 */
import {
  methods,
  PROTOCOL_VERSION,
  type PermissionOption,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type StopReason,
  type Stream,
} from '@agentclientprotocol/sdk';
import type {
  RunFinishedNotification_unstable,
  RunStartedNotification_unstable,
  SteerSessionRequest_unstable,
} from '@aaif/goose-acp-client';
import {
  connectGooseAcpClient,
  type GooseAcpCallbacks,
  type GooseAcpClient,
} from '../../acp/gooseAcpClient';
import type {
  FeishuAcpPort,
  FeishuApprovalDecision,
  FeishuApprovalRequest,
  FeishuSessionEvent,
  FeishuSessionRef,
  FeishuTurnOutcome,
} from './feishuConnector';
import { feishuSessionTitle, type FeishuFailureCategory } from './feishuReplies';

/** `_meta` key of the denial details in a permission response (read by the Kernel). */
export const FEISHU_PERMISSION_META_KEY = 'modelforge/permission';
/** `_meta.client` of the sessions this connection creates; any value makes a user session. */
export const FEISHU_ACP_CLIENT = 'modelforge-feishu';

const INITIALIZE_TIMEOUT_MS = 10_000;
const AUTH_REQUIRED_CODE = -32000;
const RESOURCE_NOT_FOUND_CODE = -32002;
const PROVIDER_ERROR_CODES = new Set([
  'SECRET_UNRESOLVED',
  'CREDENTIAL_WRITE_FAILED',
  'CONFIG_WRITE_FAILED',
  'INVALID_HEADER',
]);
/** How the Kernel words a provider failure that ends a turn (crates/goose/src/agents/agent.rs). */
const PROVIDER_FAILURE_REPLIES = [
  /^Ran into this error/,
  /Please resend your message to try again\.?$/,
  /^The provider refused this request\./,
];
const PROVIDER_FAILURE_TEXT =
  /provider|api[ _-]?key|rate[ _-]?limit|quota|credits?|unauthori[sz]ed|context length|\b(?:401|403|429)\b/i;
const TOOL_FAILURE_TEXT = /\btools?\b|extension|\bmcp\b/i;

export interface FeishuAcpPortOptions {
  /** Opens a stream to the `goose serve` of the desktop. */
  openStream: () => Promise<Stream>;
  /** Working directory of new sessions: the project open in the desktop. */
  workingDir: () => Promise<string>;
  clientInfo: { name: string; version: string };
  /** Run notifications of Feishu sessions, for the Artifact store of the main process. */
  onRunStarted?: (notification: RunStartedNotification_unstable) => void;
  onRunFinished?: (notification: RunFinishedNotification_unstable) => void;
  log?: (message: string) => void;
  /** Injectable for tests; defaults to `connectGooseAcpClient`. */
  connectClient?: (stream: Stream, callbacks: GooseAcpCallbacks) => GooseAcpClient;
  initializeTimeoutMs?: number;
}

export interface FeishuAcpPortHandle extends FeishuAcpPort {
  /** Closes the connection; the port cannot be used afterwards. */
  close: () => void;
}

/** What one running turn produced so far. */
interface TurnTracker {
  toolTitles: Map<string, string>;
  toolNames: Map<string, string>;
  completedTools: Set<string>;
  artifacts: string[];
  replyMessageId: string | null;
  /** Text of the latest assistant message; a tool call closes it. */
  reply: string;
  replyClosed: boolean;
}

function newTurnTracker(): TurnTracker {
  return {
    toolTitles: new Map(),
    toolNames: new Map(),
    completedTools: new Set(),
    artifacts: [],
    replyMessageId: null,
    reply: '',
    replyClosed: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return typeof error === 'string' ? error : String(error);
}

function errorCode(error: unknown): number | null {
  return isRecord(error) && typeof error.code === 'number' ? error.code : null;
}

/** Text form of tool arguments for the approval message. */
export function describeArguments(rawInput: unknown): string {
  if (rawInput === undefined || rawInput === null) {
    return '';
  }
  if (typeof rawInput === 'string') {
    return rawInput;
  }
  try {
    return JSON.stringify(rawInput) ?? '';
  } catch {
    return String(rawInput);
  }
}

/** The ACP answer to a permission request; a denial says why in `_meta`. */
export function permissionResponse(
  options: readonly PermissionOption[],
  decision: FeishuApprovalDecision
): RequestPermissionResponse {
  if (decision.outcome === 'cancelled') {
    return { outcome: { outcome: 'cancelled' } };
  }
  if (decision.outcome === 'allow') {
    const allow = options.find((option) => option.kind === 'allow_once');
    return allow
      ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  }
  const meta = { [FEISHU_PERMISSION_META_KEY]: { reason: decision.reason } };
  const reject = options.find((option) => option.kind === 'reject_once');
  return reject
    ? { outcome: { outcome: 'selected', optionId: reject.optionId }, _meta: meta }
    : { outcome: { outcome: 'cancelled' }, _meta: meta };
}

/** Whether a turn's last reply is the Kernel reporting a provider failure. */
export function isProviderFailureReply(reply: string): boolean {
  const text = reply.trim();
  return PROVIDER_FAILURE_REPLIES.some((pattern) => pattern.test(text));
}

/** Failure category of a turn that ended with an error (requirement 15.6). */
export function failureFromError(error: unknown): FeishuFailureCategory {
  const data = isRecord(error) ? error.data : undefined;
  if (errorCode(error) === AUTH_REQUIRED_CODE) {
    return '模型供应商错误';
  }
  if (
    isRecord(data) &&
    (data.reason === 'credits_exhausted' ||
      (typeof data.code === 'string' && PROVIDER_ERROR_CODES.has(data.code)))
  ) {
    return '模型供应商错误';
  }
  const text = `${errorText(error)} ${typeof data === 'string' ? data : ''}`;
  if (PROVIDER_FAILURE_TEXT.test(text)) {
    return '模型供应商错误';
  }
  if (TOOL_FAILURE_TEXT.test(text)) {
    return '工具执行错误';
  }
  return '内核异常';
}

/** How a turn that ended without an error is reported (requirements 15.2, 15.6). */
export function turnOutcome(
  stopReason: StopReason,
  turn: { artifacts: readonly string[]; reply: string }
): FeishuTurnOutcome {
  const reply = turn.reply.trim();
  if (stopReason === 'cancelled') {
    return { status: 'failed', failure: '用户中断' };
  }
  if (stopReason === 'refusal' || isProviderFailureReply(reply)) {
    return { status: 'failed', failure: '模型供应商错误' };
  }
  const statusText =
    stopReason === 'max_tokens'
      ? '已停止：模型输出达到长度上限'
      : stopReason === 'max_turn_requests'
        ? '已停止：达到单次任务的轮次上限'
        : '完成';
  return { status: 'completed', statusText, artifactFileNames: [...turn.artifacts], reply };
}

function activeRunIdOf(meta: unknown): string | null | undefined {
  if (!isRecord(meta) || !isRecord(meta.goose) || !('activeRunId' in meta.goose)) {
    return undefined;
  }
  const runId = meta.goose.activeRunId;
  return typeof runId === 'string' || runId === null ? runId : undefined;
}

function toolNameOf(meta: unknown): string | undefined {
  if (!isRecord(meta) || !isRecord(meta.goose) || !isRecord(meta.goose.toolCall)) {
    return undefined;
  }
  const name = meta.goose.toolCall.toolName;
  return typeof name === 'string' && name ? name : undefined;
}

function textPrompt(text: string) {
  return [{ type: 'text' as const, text }];
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function createFeishuAcpPort(options: FeishuAcpPortOptions): FeishuAcpPortHandle {
  const log = options.log ?? (() => {});
  const connectClient = options.connectClient ?? connectGooseAcpClient;
  const initializeTimeoutMs = options.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS;

  let current: GooseAcpClient | null = null;
  let connecting: Promise<GooseAcpClient> | null = null;
  let closed = false;
  let permissionHandler:
    ((request: FeishuApprovalRequest) => Promise<FeishuApprovalDecision>) | null = null;
  let eventHandler: ((event: FeishuSessionEvent) => void) | null = null;

  const turns = new Map<string, TurnTracker>(); // sessionId -> running turn
  const activeRuns = new Map<string, string>(); // sessionId -> Kernel run id, for steering

  const emit = (event: FeishuSessionEvent): void => {
    try {
      eventHandler?.(event);
    } catch (error) {
      log(`a session event handler failed: ${errorText(error)}`);
    }
  };

  const completeStep = (sessionId: string, turn: TurnTracker, toolCallId: string): void => {
    if (turn.completedTools.has(toolCallId)) {
      return;
    }
    turn.completedTools.add(toolCallId);
    const stepName =
      turn.toolTitles.get(toolCallId) ?? turn.toolNames.get(toolCallId) ?? toolCallId;
    emit({ type: 'step-completed', sessionId, stepName });
  };

  const handleSessionUpdate = (notification: SessionNotification): void => {
    const { sessionId, update } = notification;
    if (update.sessionUpdate === 'session_info_update') {
      const runId = activeRunIdOf(update._meta);
      if (runId === null) {
        activeRuns.delete(sessionId);
      } else if (typeof runId === 'string') {
        activeRuns.set(sessionId, runId);
      }
      return;
    }
    const turn = turns.get(sessionId);
    if (!turn) {
      return;
    }
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        if (update.content.type !== 'text') {
          return;
        }
        const messageId = update.messageId ?? null;
        if (turn.replyClosed || messageId !== turn.replyMessageId) {
          turn.reply = '';
          turn.replyClosed = false;
          turn.replyMessageId = messageId;
        }
        turn.reply += update.content.text;
        return;
      }
      case 'tool_call': {
        turn.replyClosed = true;
        turn.toolTitles.set(update.toolCallId, update.title);
        const toolName = toolNameOf(update._meta);
        if (toolName) {
          turn.toolNames.set(update.toolCallId, toolName);
        }
        if (update.status === 'completed') {
          completeStep(sessionId, turn, update.toolCallId);
        }
        return;
      }
      case 'tool_call_update': {
        if (update.title) {
          turn.toolTitles.set(update.toolCallId, update.title);
        }
        if (update.status === 'completed') {
          completeStep(sessionId, turn, update.toolCallId);
        }
        return;
      }
      default:
        return;
    }
  };

  const respondToPermission = async (
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> => {
    const handler = permissionHandler;
    if (!handler) {
      return { outcome: { outcome: 'cancelled' } };
    }
    const { toolCallId } = params.toolCall;
    const turn = turns.get(params.sessionId);
    const toolName =
      turn?.toolNames.get(toolCallId) ??
      params.toolCall.title ??
      turn?.toolTitles.get(toolCallId) ??
      toolCallId;
    let decision: FeishuApprovalDecision;
    try {
      decision = await handler({
        sessionId: params.sessionId,
        toolCallId,
        toolName,
        arguments: describeArguments(params.toolCall.rawInput),
      });
    } catch (error) {
      log(`answering a permission request failed: ${errorText(error)}`);
      decision = { outcome: 'cancelled' };
    }
    return permissionResponse(params.options, decision);
  };

  const unsupported = (method: string) => async (): Promise<never> => {
    throw new Error(`${method} is not supported on the Feishu connection`);
  };

  const callbacks: GooseAcpCallbacks = {
    requestPermission: respondToPermission,
    sessionUpdate: async (notification) => {
      handleSessionUpdate(notification);
    },
    unstable_createElicitation: async () => ({ action: 'decline' }),
    unstable_sessionRecipeRequestParams: unsupported('recipe parameter requests'),
    unstable_sessionCheckpointEnsure: unsupported('checkpoint requests'),
    unstable_tasksConfirmOverwrite: unsupported('overwrite confirmations'),
    unstable_sessionUpdate: async () => {},
    unstable_providerDeviceCode: async () => {},
    unstable_runsStarted: async (notification) => {
      options.onRunStarted?.(notification);
    },
    unstable_runsFinished: async (notification) => {
      const turn = turns.get(notification.sessionId);
      if (turn) {
        for (const output of notification.outputs ?? []) {
          const name = output.replace(/\\/g, '/');
          if (name && !turn.artifacts.includes(name)) {
            turn.artifacts.push(name);
          }
        }
      }
      options.onRunFinished?.(notification);
    },
  };

  const open = async (): Promise<GooseAcpClient> => {
    const stream = await options.openStream();
    const client = connectClient(stream, callbacks);
    try {
      await withTimeout(
        client.connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          _meta: { 'goose/useLoginShellPath': true },
          clientCapabilities: {
            // Only what this connection handles: run notifications for the summary's file
            // list. Checkpoints, overwrite confirmations and elicitation stay undeclared.
            _meta: { goose: { runNotifications: true } },
          },
          clientInfo: options.clientInfo,
        }),
        initializeTimeoutMs,
        `ACP initialize timed out after ${initializeTimeoutMs}ms`
      );
    } catch (error) {
      client.connection.close(error);
      throw error;
    }
    if (closed) {
      client.connection.close();
      throw new Error('The Feishu ACP connection was closed');
    }
    current = client;
    const onClosed = () => {
      if (current !== client) {
        return;
      }
      current = null;
      activeRuns.clear();
      log('ACP connection closed');
      emit({ type: 'disconnected' });
    };
    client.connection.closed.then(onClosed, onClosed);
    return client;
  };

  const ensureClient = async (): Promise<GooseAcpClient> => {
    if (closed) {
      throw new Error('The Feishu ACP connection was closed');
    }
    if (current) {
      return current;
    }
    if (connecting) {
      return connecting;
    }
    const attempt = open().finally(() => {
      connecting = null;
    });
    connecting = attempt;
    return attempt;
  };

  return {
    createSession: async (firstMessage: string): Promise<FeishuSessionRef> => {
      const client = await ensureClient();
      const cwd = await options.workingDir();
      const response = await client.connection.agent.request(methods.agent.session.new, {
        cwd,
        mcpServers: [],
        _meta: { client: FEISHU_ACP_CLIENT },
      });
      const sessionId = String(response.sessionId);
      const title = feishuSessionTitle(firstMessage);
      try {
        await client.goose.sessionRename_unstable({ sessionId, title });
        return { sessionId, name: title };
      } catch (error) {
        log(`naming session ${sessionId} failed: ${errorText(error)}`);
        return { sessionId, name: sessionId };
      }
    },
    sessionInfo: async (sessionId: string) => {
      const client = await ensureClient();
      try {
        const response = await client.goose.sessionInfo_unstable({ sessionId });
        const title = response.session.title?.trim();
        return { name: title || sessionId };
      } catch (error) {
        if (errorCode(error) === RESOURCE_NOT_FOUND_CODE) {
          return null;
        }
        throw error;
      }
    },
    prompt: async (sessionId: string, text: string): Promise<FeishuTurnOutcome> => {
      const client = await ensureClient();
      const turn = newTurnTracker();
      turns.set(sessionId, turn);
      try {
        const response: PromptResponse = await client.connection.agent.request(
          methods.agent.session.prompt,
          { sessionId, prompt: textPrompt(text) }
        );
        return turnOutcome(response.stopReason, turn);
      } catch (error) {
        log(`turn of ${sessionId} ended with an error: ${errorText(error)}`);
        return { status: 'failed', failure: failureFromError(error) };
      } finally {
        if (turns.get(sessionId) === turn) {
          turns.delete(sessionId);
        }
        activeRuns.delete(sessionId);
      }
    },
    steer: async (sessionId: string, text: string): Promise<boolean> => {
      const runId = activeRuns.get(sessionId);
      if (!runId) {
        return false;
      }
      const client = await ensureClient();
      await client.goose.sessionSteer_unstable({
        sessionId,
        expectedRunId: runId,
        // The generated goose types name content blocks differently from the ACP SDK.
        prompt: textPrompt(text) as unknown as SteerSessionRequest_unstable['prompt'],
      });
      return true;
    },
    onPermissionRequest: (handler) => {
      permissionHandler = handler;
      return () => {
        if (permissionHandler === handler) {
          permissionHandler = null;
        }
      };
    },
    onSessionEvent: (handler) => {
      eventHandler = handler;
      return () => {
        if (eventHandler === handler) {
          eventHandler = null;
        }
      };
    },
    close: () => {
      closed = true;
      const client = current;
      current = null;
      client?.connection.close();
    },
  };
}
