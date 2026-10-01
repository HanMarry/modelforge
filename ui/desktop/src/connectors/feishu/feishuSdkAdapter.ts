/**
 * Puts the Feishu connector together for the main process (requirement 15): the SDK long
 * connection and IM client (`larkChannel.ts`), the dedicated ACP connection to `goose serve`
 * (`feishuAcpPort.ts`) and the connector core (`feishuConnector.ts`). `registerFeishuIpc` starts
 * and stops it with the enable switch. The SDK and the ACP port are injectable for tests.
 */
import type { Stream } from '@agentclientprotocol/sdk';
import type {
  RunFinishedNotification_unstable,
  RunStartedNotification_unstable,
} from '@aaif/goose-acp-client';
import {
  createFeishuAcpPort,
  type FeishuAcpPortHandle,
  type FeishuAcpPortOptions,
} from './feishuAcpPort';
import {
  createFeishuConnector,
  type FeishuConnector,
  type FeishuInboundEvent,
  type FeishuStateStore,
} from './feishuConnector';
import {
  createLarkLogger,
  createLarkMessenger,
  larkSdk,
  normalizeLarkMessage,
  type FeishuLinkState,
  type LarkLink,
  type LarkSdk,
} from './larkChannel';

export interface FeishuControllerConfig {
  appId: string;
  appSecret: string;
  whitelist: string[];
}

export interface FeishuControllerStatus {
  /** Whether the connector runs (not just whether it is enabled in the settings). */
  started: boolean;
  /** State of the Feishu long connection. */
  link: FeishuLinkState;
}

export interface FeishuControllerOptions {
  store: FeishuStateStore;
  /** Opens a stream to the desktop's `goose serve` for the dedicated ACP connection. */
  openAcpStream: () => Promise<Stream>;
  /** Working directory of new Feishu sessions. */
  workingDir: () => Promise<string>;
  clientInfo: { name: string; version: string };
  onRunStarted?: (notification: RunStartedNotification_unstable) => void;
  onRunFinished?: (notification: RunFinishedNotification_unstable) => void;
  log?: (message: string) => void;
  /** Masks key values in logs and outgoing messages. */
  redact?: (text: string) => string;
  sdk?: LarkSdk;
  createAcpPort?: (options: FeishuAcpPortOptions) => FeishuAcpPortHandle;
}

export interface FeishuControllerHandle {
  start: (config: FeishuControllerConfig) => Promise<void>;
  stop: () => Promise<void>;
  isStarted: () => boolean;
  status: () => FeishuControllerStatus;
}

interface Running {
  connector: FeishuConnector;
  acp: FeishuAcpPortHandle;
  link: LarkLink;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

export function createFeishuController(options: FeishuControllerOptions): FeishuControllerHandle {
  const log = options.log ?? (() => {});
  const redact = options.redact ?? ((text: string) => text);
  const sdk = options.sdk ?? larkSdk;
  const createAcpPort = options.createAcpPort ?? createFeishuAcpPort;

  let running: Running | null = null;
  let link: FeishuLinkState = 'idle';
  // Bumped by every stop, so a start that is still setting up knows it was cancelled.
  let generation = 0;

  const stop = async (): Promise<void> => {
    generation += 1;
    const current = running;
    running = null;
    link = 'idle';
    if (!current) {
      return;
    }
    try {
      current.link.close();
    } catch (error) {
      log(`closing the long connection failed: ${redact(describe(error))}`);
    }
    await current.connector.stop();
    current.acp.close();
  };

  const start = async (config: FeishuControllerConfig): Promise<void> => {
    await stop();
    const own = generation;
    const logger = createLarkLogger(log, redact);
    const imClient = sdk.createImClient({
      appId: config.appId,
      appSecret: config.appSecret,
      logger,
    });
    const acp = createAcpPort({
      openStream: options.openAcpStream,
      workingDir: options.workingDir,
      clientInfo: options.clientInfo,
      onRunStarted: options.onRunStarted,
      onRunFinished: options.onRunFinished,
      log: (message) => log(`acp: ${redact(message)}`),
    });
    let deliver: ((event: FeishuInboundEvent) => void) | null = null;
    const connector = createFeishuConnector({
      whitelist: config.whitelist,
      messenger: createLarkMessenger(imClient),
      acp,
      store: options.store,
      subscribe: (handler) => {
        deliver = handler;
        return () => {
          if (deliver === handler) {
            deliver = null;
          }
        };
      },
      log,
      redact,
    });
    await connector.start();
    if (own !== generation) {
      await connector.stop();
      acp.close();
      return;
    }

    const larkLink = sdk.connect({
      appId: config.appId,
      appSecret: config.appSecret,
      logger,
      onMessage: (data) => {
        const event = normalizeLarkMessage(data);
        if (event) {
          deliver?.(event);
        }
      },
      onStateChange: (state, error) => {
        if (own !== generation) {
          return;
        }
        link = state;
        const detail = error === undefined ? '' : `: ${redact(describe(error))}`;
        log(`long connection ${state}${detail}`);
      },
    });
    running = { connector, acp, link: larkLink };
  };

  return {
    start,
    stop,
    isStarted: () => running !== null,
    status: () => ({ started: running !== null, link }),
  };
}
