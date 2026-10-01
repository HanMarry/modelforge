/**
 * Feishu side of the connector (requirement 15, task 19.5): the official Node SDK
 * `@larksuiteoapi/node-sdk` receives `im.message.receive_v1` over its long connection
 * (`WSClient`) and sends replies with the IM message API. Both are outbound connections, so no
 * public callback address is needed. The SDK sits behind the small `LarkSdk` interface so tests
 * can replace it.
 */
import {
  AppType,
  Client,
  Domain,
  EventDispatcher,
  LoggerLevel,
  WSClient,
} from '@larksuiteoapi/node-sdk';
import type { FeishuInboundEvent, FeishuMessenger } from './feishuConnector';

const HANDSHAKE_TIMEOUT_MS = 15_000;

export type FeishuLinkState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface LarkLogger {
  error: (...parts: unknown[]) => void;
  warn: (...parts: unknown[]) => void;
  info: (...parts: unknown[]) => void;
  debug: (...parts: unknown[]) => void;
  trace: (...parts: unknown[]) => void;
}

/** The parts of an `im.message.receive_v1` event the connector reads. */
export interface LarkReceiveMessageEvent {
  sender?: {
    sender_id?: { open_id?: string };
    sender_type?: string;
  };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
  };
}

export interface LarkCreateMessageRequest {
  params: { receive_id_type: 'chat_id' };
  data: { receive_id: string; msg_type: 'text'; content: string; uuid?: string };
}

/** The IM API surface the connector uses (`client.im.message.create`). */
export interface LarkImClient {
  im: {
    message: {
      create: (
        payload: LarkCreateMessageRequest
      ) => Promise<{ code?: number; msg?: string } | undefined>;
    };
  };
}

export interface LarkConnectOptions {
  appId: string;
  appSecret: string;
  logger: LarkLogger;
  /** Called for every `im.message.receive_v1`; must return quickly. */
  onMessage: (event: LarkReceiveMessageEvent) => void;
  onStateChange: (state: FeishuLinkState, error?: unknown) => void;
}

export interface LarkLink {
  close: () => void;
}

export interface LarkSdk {
  createImClient: (options: {
    appId: string;
    appSecret: string;
    logger: LarkLogger;
  }) => LarkImClient;
  connect: (options: LarkConnectOptions) => LarkLink;
}

/** The real SDK: a self-built app on the Feishu (not Lark) domain. */
export const larkSdk: LarkSdk = {
  createImClient: ({ appId, appSecret, logger }) =>
    new Client({
      appId,
      appSecret,
      appType: AppType.SelfBuild,
      domain: Domain.Feishu,
      logger,
      loggerLevel: LoggerLevel.warn,
      source: 'modelforge',
    }),
  connect: ({ appId, appSecret, logger, onMessage, onStateChange }) => {
    const wsClient = new WSClient({
      appId,
      appSecret,
      domain: Domain.Feishu,
      logger,
      loggerLevel: LoggerLevel.info,
      autoReconnect: true,
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      source: 'modelforge',
      onReady: () => onStateChange('connected'),
      onError: (error) => onStateChange('failed', error),
      onReconnecting: () => onStateChange('reconnecting'),
      onReconnected: () => onStateChange('connected'),
    });
    const eventDispatcher = new EventDispatcher({ logger, loggerLevel: LoggerLevel.info }).register(
      {
        // The SDK acknowledges the event when this returns; the work happens afterwards.
        'im.message.receive_v1': (data: LarkReceiveMessageEvent) => {
          onMessage(data);
        },
      }
    );
    onStateChange('connecting');
    wsClient.start({ eventDispatcher }).catch((error: unknown) => onStateChange('failed', error));
    return { close: () => wsClient.close({ force: true }) };
  },
};

function textContent(content: unknown): string {
  if (typeof content !== 'string') {
    return '';
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null && 'text' in parsed) {
      const { text } = parsed as { text: unknown };
      return typeof text === 'string' ? text : '';
    }
  } catch {
    // Not JSON: not a text message body.
  }
  return '';
}

/** Turns an `im.message.receive_v1` payload into the connector's event; null when unusable. */
export function normalizeLarkMessage(event: LarkReceiveMessageEvent): FeishuInboundEvent | null {
  const message = event.message;
  if (!message || typeof message.chat_id !== 'string' || !message.chat_id) {
    return null;
  }
  const messageType = typeof message.message_type === 'string' ? message.message_type : '';
  // Only people can start tasks; a bot or app sender has no open_id to whitelist.
  const fromUser = (event.sender?.sender_type ?? 'user') === 'user';
  return {
    messageId: typeof message.message_id === 'string' ? message.message_id : '',
    chatId: message.chat_id,
    message: {
      chatType: typeof message.chat_type === 'string' ? message.chat_type : '',
      messageType,
      text: messageType === 'text' ? textContent(message.content) : '',
      senderOpenId: fromUser ? (event.sender?.sender_id?.open_id ?? '') : '',
    },
  };
}

/** Sends plain-text replies to a chat; a non-zero Feishu `code` is a failure, retried upstream. */
export function createLarkMessenger(client: LarkImClient): FeishuMessenger {
  return {
    sendText: async (chatId, text, idempotencyKey) => {
      const response = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
          uuid: idempotencyKey,
        },
      });
      if (response && typeof response.code === 'number' && response.code !== 0) {
        throw new Error(
          `Feishu did not accept the message (code ${response.code}${response.msg ? `: ${response.msg}` : ''})`
        );
      }
    },
  };
}

/** SDK log lines go to the connector log, masked like everything else it writes. */
export function createLarkLogger(
  log: (message: string) => void,
  redact: (text: string) => string
): LarkLogger {
  const line =
    (level: string) =>
    (...parts: unknown[]) => {
      const text = parts
        .map((part) => {
          if (typeof part === 'string') {
            return part;
          }
          if (part instanceof Error) {
            return part.message || part.name;
          }
          try {
            return JSON.stringify(part) ?? String(part);
          } catch {
            return String(part);
          }
        })
        .join(' ');
      log(`lark ${level}: ${redact(text)}`);
    };
  return {
    error: line('error'),
    warn: line('warn'),
    info: line('info'),
    debug: line('debug'),
    trace: line('trace'),
  };
}
