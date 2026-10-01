// @vitest-environment node
/**
 * Task 19.8: the Feishu connector end to end. The official SDK (`@larksuiteoapi/node-sdk`) is
 * replaced by a fake long connection and IM client, the ACP connection by a fake port, and time
 * by fake timers, so the acknowledgement, the summary, the retries and the approval timeout run
 * at their real intervals (requirements 15.1–15.5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Domain } from '@larksuiteoapi/node-sdk';
import { createFeishuController, type FeishuControllerHandle } from './feishuSdkAdapter';
import type { FeishuAcpPortHandle } from './feishuAcpPort';
import type {
  FeishuApprovalDecision,
  FeishuApprovalRequest,
  FeishuSessionEvent,
  FeishuSessionRef,
  FeishuStateStore,
  FeishuTurnOutcome,
} from './feishuConnector';
import { FEISHU_SUMMARY_LIMIT, FEISHU_SUMMARY_NOTE } from './replyFormat';
import { createLarkMessenger, normalizeLarkMessage } from './larkChannel';

type Handler = (data: unknown) => unknown;

interface SentMessage {
  params: { receive_id_type: string };
  data: { receive_id: string; msg_type: string; content: string; uuid?: string };
}

const lark = vi.hoisted(() => ({
  sockets: [] as Array<{
    params: Record<string, unknown>;
    handlers: Record<string, Handler>;
    started: boolean;
    closed: boolean;
  }>,
  clients: [] as Array<Record<string, unknown>>,
  sent: [] as SentMessage[],
  /** Returns true for a text Feishu should refuse. */
  refuse: null as null | ((text: string) => boolean),
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class EventDispatcher {
    readonly handlers: Record<string, Handler> = {};
    register(handles: Record<string, Handler>) {
      Object.assign(this.handlers, handles);
      return this;
    }
  }
  class WSClient {
    private readonly socket: (typeof lark.sockets)[number];
    constructor(params: Record<string, unknown>) {
      this.socket = { params, handlers: {}, started: false, closed: false };
      lark.sockets.push(this.socket);
    }
    async start(options: { eventDispatcher: EventDispatcher }): Promise<void> {
      this.socket.handlers = options.eventDispatcher.handlers;
      this.socket.started = true;
    }
    close(): void {
      this.socket.closed = true;
    }
  }
  class Client {
    readonly im: {
      message: { create: (payload: SentMessage) => Promise<{ code: number; msg?: string }> };
    };
    constructor(params: Record<string, unknown>) {
      lark.clients.push(params);
      this.im = {
        message: {
          create: async (payload: SentMessage) => {
            lark.sent.push(payload);
            const { text } = JSON.parse(payload.data.content) as { text: string };
            return lark.refuse?.(text) ? { code: 230020, msg: 'rate limited' } : { code: 0 };
          },
        },
      };
    }
  }
  return {
    AppType: { SelfBuild: 0, ISV: 1 },
    Domain: { Feishu: 0, Lark: 1 },
    LoggerLevel: { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 },
    Client,
    EventDispatcher,
    WSClient,
  };
});

const ALLOWED = 'ou_allowed';
const CHAT = 'oc_private_chat';

function sentTexts(): Array<{ chatId: string; text: string; uuid: string | undefined }> {
  return lark.sent.map((message) => ({
    chatId: message.data.receive_id,
    text: (JSON.parse(message.data.content) as { text: string }).text,
    uuid: message.data.uuid,
  }));
}

function lastText(): string {
  const all = sentTexts();
  return all.length > 0 ? all[all.length - 1].text : '';
}

let messageCounter = 0;

function receive(
  text: string,
  overrides: {
    openId?: string;
    chatId?: string;
    chatType?: string;
    messageType?: string;
    content?: string;
    senderType?: string;
  } = {}
): void {
  const socket = lark.sockets[lark.sockets.length - 1];
  const handler = socket?.handlers['im.message.receive_v1'];
  if (!handler) {
    throw new Error('no im.message.receive_v1 handler registered');
  }
  messageCounter += 1;
  handler({
    sender: {
      sender_id: { open_id: overrides.openId ?? ALLOWED },
      sender_type: overrides.senderType ?? 'user',
    },
    message: {
      message_id: `om_${messageCounter}`,
      chat_id: overrides.chatId ?? CHAT,
      chat_type: overrides.chatType ?? 'p2p',
      message_type: overrides.messageType ?? 'text',
      content: overrides.content ?? JSON.stringify({ text }),
      create_time: '1727000000000',
    },
  });
}

function completed(artifactFileNames: string[] = [], reply = ''): FeishuTurnOutcome {
  return { status: 'completed', statusText: '完成', artifactFileNames, reply };
}

function createFakeAcp() {
  const turns: Array<{ sessionId: string; text: string; resolve: (o: FeishuTurnOutcome) => void }> =
    [];
  const names = new Map<string, string>();
  let permissionHandler: ((r: FeishuApprovalRequest) => Promise<FeishuApprovalDecision>) | null =
    null;
  let eventHandler: ((event: FeishuSessionEvent) => void) | null = null;
  let repliesBeforePrompt: number[] = [];

  const createSession = vi.fn(async (firstMessage: string): Promise<FeishuSessionRef> => {
    const sessionId = `session-${names.size + 1}`;
    const name = `飞书：${firstMessage}`;
    names.set(sessionId, name);
    return { sessionId, name };
  });
  const prompt = vi.fn(
    (sessionId: string, text: string) =>
      new Promise<FeishuTurnOutcome>((resolve) => {
        repliesBeforePrompt = [...repliesBeforePrompt, lark.sent.length];
        turns.push({ sessionId, text, resolve });
      })
  );
  const port: FeishuAcpPortHandle = {
    createSession,
    sessionInfo: async (sessionId: string) => {
      const name = names.get(sessionId);
      return name === undefined ? null : { name };
    },
    prompt,
    steer: async () => false,
    onPermissionRequest: (handler) => {
      permissionHandler = handler;
      return () => {
        permissionHandler = null;
      };
    },
    onSessionEvent: (handler) => {
      eventHandler = handler;
      return () => {
        eventHandler = null;
      };
    },
    close: vi.fn(),
  };
  return {
    port,
    createSession,
    prompt,
    turns,
    repliesBeforePrompt: () => repliesBeforePrompt,
    requestPermission: (request: FeishuApprovalRequest): Promise<FeishuApprovalDecision> => {
      if (!permissionHandler) {
        throw new Error('the connector did not subscribe to permission requests');
      }
      return permissionHandler(request);
    },
    emit: (event: FeishuSessionEvent) => eventHandler?.(event),
  };
}

function createStore() {
  let chats: Record<string, FeishuSessionRef> = {};
  const markUndelivered = vi.fn(async (_sessionId: string) => {});
  const store: FeishuStateStore = {
    loadChats: async () => ({ ...chats }),
    saveChats: async (next) => {
      chats = { ...next };
    },
    markUndelivered,
  };
  return { store, markUndelivered, chats: () => chats };
}

let controller: FeishuControllerHandle | null = null;

async function startController(whitelist: string[] = [ALLOWED]) {
  const acp = createFakeAcp();
  const state = createStore();
  controller = createFeishuController({
    store: state.store,
    openAcpStream: async () => {
      throw new Error('the fake port opens no stream');
    },
    workingDir: async () => '/projects/demo',
    clientInfo: { name: 'modelforge-feishu', version: 'test' },
    createAcpPort: () => acp.port,
  });
  await controller.start({ appId: 'cli_test_app', appSecret: 'test-app-secret', whitelist });
  return { controller, acp, state };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  lark.sockets.length = 0;
  lark.clients.length = 0;
  lark.sent.length = 0;
  lark.refuse = null;
});

afterEach(async () => {
  await controller?.stop();
  controller = null;
  vi.useRealTimers();
});

describe('Feishu connector through the official SDK', () => {
  it('opens the long connection for im.message.receive_v1 and closes it on stop', async () => {
    const { controller: running, acp } = await startController();

    const socket = lark.sockets[0];
    expect(socket.params).toMatchObject({
      appId: 'cli_test_app',
      appSecret: 'test-app-secret',
      domain: Domain.Feishu,
      autoReconnect: true,
    });
    expect(socket.started).toBe(true);
    expect(Object.keys(socket.handlers)).toEqual(['im.message.receive_v1']);
    expect(lark.clients[0]).toMatchObject({ appId: 'cli_test_app', domain: Domain.Feishu });
    expect(running.status()).toEqual({ started: true, link: 'connecting' });

    (socket.params.onReady as () => void)();
    expect(running.status().link).toBe('connected');

    await running.stop();
    expect(socket.closed).toBe(true);
    expect(acp.port.close).toHaveBeenCalled();
    expect(running.status()).toEqual({ started: false, link: 'idle' });
  });

  it('hands a whitelisted private text to the Kernel, then acknowledges it with the session name', async () => {
    const { acp, state } = await startController();

    receive('整理附件里的数据并画图');
    await flush();

    expect(acp.createSession).toHaveBeenCalledWith('整理附件里的数据并画图');
    expect(acp.prompt).toHaveBeenCalledWith('session-1', '整理附件里的数据并画图');
    // The turn reached the Kernel before any reply went out.
    expect(acp.repliesBeforePrompt()).toEqual([0]);
    expect(sentTexts()).toEqual([
      {
        chatId: CHAT,
        text: '已受理，ModelForge 会话「飞书：整理附件里的数据并画图」开始处理。',
        uuid: expect.any(String),
      },
    ]);
    expect(lark.sent[0].params).toEqual({ receive_id_type: 'chat_id' });
    expect(lark.sent[0].data.msg_type).toBe('text');
    expect(state.chats()).toEqual({
      [CHAT]: { sessionId: 'session-1', name: '飞书：整理附件里的数据并画图' },
    });

    // A later message of the same chat goes to the same session.
    acp.turns[0].resolve(completed());
    await flush();
    receive('再加一张箱线图');
    await flush();
    expect(acp.createSession).toHaveBeenCalledTimes(1);
    expect(acp.prompt).toHaveBeenLastCalledWith('session-1', '再加一张箱线图');
    expect(lastText()).toBe('已受理，ModelForge 会话「飞书：整理附件里的数据并画图」开始处理。');
  });

  it('replies with the summary when the turn ends, truncated to 2000 code points', async () => {
    const { acp } = await startController();
    receive('批量生成图表');
    await flush();

    const artifacts = Array.from({ length: 300 }, (_, index) => `figures/figure-${index}.png`);
    acp.turns[0].resolve(completed(artifacts, '全部图表已生成。'));
    await flush();

    const summary = lastText();
    expect(summary.startsWith('状态：完成\n生成文件：\n- figures/figure-0.png')).toBe(true);
    expect([...summary].length).toBeLessThanOrEqual(FEISHU_SUMMARY_LIMIT);
    expect(summary.endsWith(FEISHU_SUMMARY_NOTE)).toBe(true);
  });

  it('retries an undelivered summary every 30 seconds, 3 times, then marks the session', async () => {
    const { acp, state } = await startController();
    receive('跑一下模型');
    await flush();
    lark.refuse = (text) => text.startsWith('状态：');

    acp.turns[0].resolve(completed(['results/table.csv']));
    await flush();
    const attempts = () => sentTexts().filter((message) => message.text.startsWith('状态：'));
    expect(attempts()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(attempts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(attempts()).toHaveLength(3);
    expect(state.markUndelivered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();

    expect(attempts()).toHaveLength(4);
    // Every retry reuses the same idempotency key, so Feishu posts the reply at most once.
    expect(new Set(attempts().map((message) => message.uuid)).size).toBe(1);
    expect(state.markUndelivered).toHaveBeenCalledTimes(1);
    expect(state.markUndelivered).toHaveBeenCalledWith('session-1');

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(attempts()).toHaveLength(4);
  });

  it('reports a failed turn with its failure category', async () => {
    const { acp } = await startController();
    receive('调用外部数据接口');
    await flush();

    acp.turns[0].resolve({ status: 'failed', failure: '工具执行错误' });
    await flush();

    expect(lastText()).toBe(
      '任务失败：工具执行错误。已产生的对话记录和文件保留在 ModelForge 会话「飞书：调用外部数据接口」中。'
    );
  });

  describe('tool approvals', () => {
    async function pendingApproval() {
      const started = await startController();
      receive('清理旧的结果');
      await flush();
      const decision = started.acp.requestPermission({
        sessionId: 'session-1',
        toolCallId: 'call-1',
        toolName: 'developer__shell',
        arguments: JSON.stringify({ command: 'rm -rf results', note: '说明'.repeat(400) }),
      });
      let settled: FeishuApprovalDecision | null = null;
      void decision.then((value) => {
        settled = value;
      });
      await flush();
      const message = lastText();
      const match = /「批准 ([A-Z0-9]{6})」/.exec(message);
      if (!match) {
        throw new Error(`no approval code in ${message}`);
      }
      return { ...started, decision, code: match[1], message, settled: () => settled };
    }

    it('sends the tool name, a 500 code point argument summary and a one-time code', async () => {
      const { message } = await pendingApproval();

      const [title, args] = message.split('\n');
      expect(title).toBe('工具调用需要审批：developer__shell');
      expect([...args.slice('参数：'.length)]).toHaveLength(500);
      expect(args.endsWith('…')).toBe(true);
    });

    it('runs the tool only after 批准 <code> from the same chat, without forwarding the reply', async () => {
      const { acp, code, decision, settled } = await pendingApproval();

      // Another chat, even of a whitelisted account, cannot approve it.
      receive(`批准 ${code}`, { chatId: 'oc_other_chat' });
      await flush();
      expect(settled()).toBeNull();
      expect(lastText()).toContain('无效或已失效');

      receive(`批准 ${code.toLowerCase()}`);
      await flush();
      await expect(decision).resolves.toEqual({ outcome: 'allow' });
      expect(lastText()).toBe('已批准，继续执行工具「developer__shell」。');
      expect(acp.prompt).toHaveBeenCalledTimes(1);
      expect(acp.createSession).toHaveBeenCalledTimes(1);
    });

    it('rejects on 拒绝 <code> and tells the chat the tool did not run', async () => {
      const { acp, code, decision } = await pendingApproval();

      receive(`拒绝 ${code}`);
      await flush();

      await expect(decision).resolves.toEqual({ outcome: 'deny', reason: 'rejected' });
      expect(lastText()).toBe('工具「developer__shell」未执行：审批被拒绝。');
      expect(acp.prompt).toHaveBeenCalledTimes(1);
    });

    it('times out after 10 minutes without an answer', async () => {
      const { decision, settled } = await pendingApproval();

      await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
      expect(settled()).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      await flush();

      await expect(decision).resolves.toEqual({ outcome: 'deny', reason: 'timeout' });
      expect(lastText()).toBe('工具「developer__shell」未执行：审批已超时（10 分钟内未获批准）。');
    });

    it('does not let an account outside the whitelist answer', async () => {
      const { code, settled } = await pendingApproval();
      const before = lark.sent.length;

      receive(`批准 ${code}`, { openId: 'ou_stranger' });
      await flush();

      expect(settled()).toBeNull();
      expect(lark.sent).toHaveLength(before);
    });
  });

  it('ignores accounts outside the whitelist, group chats, non-text messages and bots', async () => {
    const { acp } = await startController();

    receive('帮我写论文', { openId: 'ou_stranger' });
    receive('帮我写论文', { chatType: 'group' });
    receive('', { messageType: 'image', content: JSON.stringify({ image_key: 'img_v3_1' }) });
    receive('帮我写论文', { senderType: 'app' });
    await flush();

    expect(lark.sent).toHaveLength(0);
    expect(acp.createSession).not.toHaveBeenCalled();
    expect(acp.prompt).not.toHaveBeenCalled();
  });

  it('answers nobody when the whitelist is empty', async () => {
    const { acp } = await startController([]);

    receive('帮我写论文');
    await flush();

    expect(lark.sent).toHaveLength(0);
    expect(acp.prompt).not.toHaveBeenCalled();
  });
});

describe('normalizeLarkMessage', () => {
  it('reads the chat, the sender and the text of a private text message', () => {
    expect(
      normalizeLarkMessage({
        sender: { sender_id: { open_id: 'ou_1' }, sender_type: 'user' },
        message: {
          message_id: 'om_1',
          chat_id: 'oc_1',
          chat_type: 'p2p',
          message_type: 'text',
          content: '{"text":"你好"}',
        },
      })
    ).toEqual({
      messageId: 'om_1',
      chatId: 'oc_1',
      message: { chatType: 'p2p', messageType: 'text', text: '你好', senderOpenId: 'ou_1' },
    });
  });

  it('keeps no text for other message types or unreadable content', () => {
    const image = normalizeLarkMessage({
      sender: { sender_id: { open_id: 'ou_1' }, sender_type: 'user' },
      message: {
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'image',
        content: '{"text":"x"}',
      },
    });
    expect(image?.message.text).toBe('');
    const broken = normalizeLarkMessage({
      message: { chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: 'not json' },
    });
    expect(broken?.message.text).toBe('');
    expect(broken?.message.senderOpenId).toBe('');
    expect(normalizeLarkMessage({ message: { chat_type: 'p2p' } })).toBeNull();
  });
});

describe('createLarkMessenger', () => {
  it('treats a non-zero Feishu code as a failure', async () => {
    const create = vi.fn(async () => ({ code: 99991663, msg: 'token invalid' }));
    const messenger = createLarkMessenger({ im: { message: { create } } });

    await expect(messenger.sendText('oc_1', '你好', 'key-1')).rejects.toThrow('99991663');
    expect(create).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_1', msg_type: 'text', content: '{"text":"你好"}', uuid: 'key-1' },
    });
  });
});
