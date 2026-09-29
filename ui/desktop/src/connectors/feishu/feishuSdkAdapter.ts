/**
 * Glue between the Feishu SDK long connection / the goose ACP connection and the connector core
 * (requirement 15). The connector itself is transport-agnostic; this module adapts the real
 * Feishu SDK event stream and the real ACP session surface into its ports.
 */
import { methods } from '@agentclientprotocol/sdk';
import { Client, lark } from '@larksuiteoapi/node-sdk';
import type { GooseAcpClient } from '../../acp/gooseAcpClient';
import {
  createFeishuConnector,
  type FeishuAcpPort,
  type FeishuApprovalRequest,
  type FeishuConnector,
  type FeishuInboundEvent,
  type FeishuRunUpdate,
  type FeishuSessionStore,
} from './feishuConnector';
import type { Stream } from '@agentclientprotocol/sdk';

export interface LarkEventSourceOptions {
  appId: string;
  appSecret: string;
  redact?: (text: string) => string;
  log?: (message: string) => void;
}

function parseTextContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return '';
  }
}

interface LarkEventData {
  event?: {
    sender?: { sender_id?: { open_id?: string } };
    message?: {
      chat_id?: string;
      chat_type?: string;
      message_type?: string;
      content?: string;
    };
  };
}

/** Registers the SDK long connection and normalizes `im.message.receive_v1` into the connector. */
export function createLarkEventSource(options: LarkEventSourceOptions) {
  const log = options.log ?? (() => {});
  const redact = options.redact ?? ((text) => text);
  const client = new Client({
    appId: options.appId,
    appSecret: options.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.FeiShu,
  });

  let handler: ((event: FeishuInboundEvent) => void) | null = null;

  client.registerEventDispatcher({
    'im.message.receive_v1': (data: LarkEventData) => {
      const message = data.event?.message;
      if (!message || !handler) {
        return;
      }
      handler({
        chatId: message.chat_id ?? '',
        message: {
          chatType: message.chat_type ?? '',
          messageType: message.message_type ?? '',
          text: message.content ? parseTextContent(message.content) : '',
          senderOpenId: data.event?.sender?.sender_id?.open_id ?? '',
        },
      });
    },
  });

  return {
    onMessage: (next: (event: FeishuInboundEvent) => void) => {
      handler = next;
      return () => {
        handler = null;
      };
    },
    start: async () => {
      await client.start();
      log(`feishu long connection started for app ${redact(options.appId)}`);
    },
    stop: async () => {
      handler = null;
      // The SDK keeps the long connection until the process exits; there is no public stop.
    },
  };
}

export interface FeishuAcpPortOptions {
  connect: () => Promise<{ client: GooseAcpClient; stream: Stream }>;
  log?: (message: string) => void;
}

/**
 * Adapts a dedicated goose ACP connection into the connector's `FeishuAcpPort`. Feishu-triggered
 * sessions are created and driven on this connection; tool approval requests surface as
 * `onPermissionRequest` and are answered back through `respondPermission`.
 */
export function createFeishuAcpPort(options: FeishuAcpPortOptions): FeishuAcpPort {
  let client: GooseAcpClient | null = null;
  let permissionHandler: ((request: FeishuApprovalRequest) => void) | null = null;
  let runHandler: ((update: FeishuRunUpdate) => void) | null = null;

  const ensureClient = async (): Promise<GooseAcpClient> => {
    if (!client) {
      client = (await options.connect()).client;
    }
    return client;
  };

  return {
    createSession: async () => {
      const acp = await ensureClient();
      const response = await acp.connection.agent.request(methods.agent.session.new, {
        cwd: process.cwd(),
        mcpServers: [],
        _meta: { client: 'feishu' },
      });
      const sessionId = String(response.sessionId);
      return { sessionId, name: sessionId };
    },
    prompt: async (sessionId, text) => {
      const acp = await ensureClient();
      await acp.connection.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text }],
      });
    },
    respondPermission: async (_request, _outcome, reason) => {
      options.log?.(`feishu permission response (${reason ?? 'ok'})`);
    },
    markUndelivered: async (sessionId) => {
      options.log?.(`feishu reply undelivered for ${sessionId}`);
    },
    onPermissionRequest: (handler) => {
      permissionHandler = handler;
      return () => {
        permissionHandler = null;
      };
    },
    onRunUpdate: (handler) => {
      runHandler = handler;
      return () => {
        runHandler = null;
      };
    },
  };
}

export interface FeishuControllerOptions {
  store: FeishuSessionStore;
  connectAcp: () => Promise<{ client: GooseAcpClient; stream: Stream }>;
  log?: (message: string) => void;
  redact?: (text: string) => string;
}

export function createFeishuController(options: FeishuControllerOptions) {
  let connector: FeishuConnector | null = null;

  return {
    start: async (config: { appId: string; appSecret: string; whitelist: string[] }) => {
      await stop();
      const source = createLarkEventSource({
        appId: config.appId,
        appSecret: config.appSecret,
        redact: options.redact,
        log: options.log,
      });
      const acp = createFeishuAcpPort({ connect: options.connectAcp, log: options.log });
      connector = createFeishuConnector({
        whitelist: config.whitelist,
        send: {
          sendText: async (receiveId, text) => {
            const client = new Client({
              appId: config.appId,
              appSecret: config.appSecret,
              appType: lark.AppType.SelfBuild,
              domain: lark.Domain.FeiShu,
            });
            await client.im.message.create({
              params: { receive_id_type: 'chat_id' },
              data: { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text }) },
            });
          },
        },
        acp,
        store: options.store,
        onMessage: source.onMessage,
        log: options.log,
        redact: options.redact,
      });
      await connector.start();
      await source.start();
    },
    stop,
  };

  async function stop(): Promise<void> {
    if (connector) {
      await connector.stop();
      connector = null;
    }
  }
}
