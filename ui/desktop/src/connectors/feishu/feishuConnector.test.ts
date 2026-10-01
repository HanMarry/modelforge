// @vitest-environment node
/**
 * Feishu connector core with fake ports (requirement 15): session mapping, follow-up messages
 * during a running turn, progress throttling, duplicate events and masking. The SDK-level flow
 * is covered in `feishuSdkAdapter.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFeishuConnector,
  type FeishuAcpPort,
  type FeishuApprovalDecision,
  type FeishuApprovalRequest,
  type FeishuConnector,
  type FeishuInboundEvent,
  type FeishuSessionEvent,
  type FeishuSessionRef,
  type FeishuTurnOutcome,
} from './feishuConnector';

const ALLOWED = 'ou_allowed';
const CHAT = 'oc_chat';

let counter = 0;

function textEvent(text: string, overrides: Partial<FeishuInboundEvent> = {}): FeishuInboundEvent {
  counter += 1;
  return {
    messageId: `om_${counter}`,
    chatId: CHAT,
    message: { chatType: 'p2p', messageType: 'text', text, senderOpenId: ALLOWED },
    ...overrides,
  };
}

interface SentReply {
  chatId: string;
  text: string;
}

interface PendingTurn {
  sessionId: string;
  text: string;
  resolve: (outcome: FeishuTurnOutcome) => void;
}

let active: FeishuConnector | null = null;

async function createHarness(
  options: {
    stored?: Record<string, FeishuSessionRef>;
    existing?: Record<string, string>;
    steerResult?: boolean;
    redact?: (text: string) => string;
  } = {}
) {
  const names = new Map(Object.entries(options.existing ?? {}));
  const sent: SentReply[] = [];
  const turns: PendingTurn[] = [];
  let inbound: ((event: FeishuInboundEvent) => void) | null = null;
  let permission: ((request: FeishuApprovalRequest) => Promise<FeishuApprovalDecision>) | null =
    null;
  let events: ((event: FeishuSessionEvent) => void) | null = null;

  const createSession = vi.fn(async (firstMessage: string): Promise<FeishuSessionRef> => {
    const sessionId = `new-session-${names.size + 1}`;
    names.set(sessionId, `飞书：${firstMessage}`);
    return { sessionId, name: `飞书：${firstMessage}` };
  });
  const prompt = vi.fn(
    (sessionId: string, text: string) =>
      new Promise<FeishuTurnOutcome>((resolve) => {
        turns.push({ sessionId, text, resolve });
      })
  );
  const steer = vi.fn(async (_sessionId: string, _text: string) => options.steerResult ?? false);
  const saveChats = vi.fn(async (_chats: Record<string, FeishuSessionRef>) => {});

  const acp: FeishuAcpPort = {
    createSession,
    sessionInfo: async (sessionId: string) => {
      const name = names.get(sessionId);
      return name === undefined ? null : { name };
    },
    prompt,
    steer,
    onPermissionRequest: (handler) => {
      permission = handler;
      return () => {
        permission = null;
      };
    },
    onSessionEvent: (handler) => {
      events = handler;
      return () => {
        events = null;
      };
    },
  };

  const connector = createFeishuConnector({
    whitelist: [ALLOWED],
    messenger: {
      sendText: async (chatId, text) => {
        sent.push({ chatId, text });
      },
    },
    acp,
    store: {
      loadChats: async () => ({ ...(options.stored ?? {}) }),
      saveChats,
      markUndelivered: async () => {},
    },
    subscribe: (handler) => {
      inbound = handler;
      return () => {
        inbound = null;
      };
    },
    redact: options.redact,
  });
  await connector.start();
  active = connector;

  return {
    connector,
    emit: (event: FeishuInboundEvent) => inbound?.(event),
    sent,
    turns,
    createSession,
    prompt,
    steer,
    saveChats,
    requestPermission: (request: FeishuApprovalRequest): Promise<FeishuApprovalDecision> => {
      if (!permission) {
        throw new Error('no permission handler');
      }
      return permission(request);
    },
    sessionEvent: (event: FeishuSessionEvent) => events?.(event),
  };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

function progress(h: { sent: SentReply[] }): string[] {
  return h.sent.map((message) => message.text).filter((text) => text.startsWith('任务进行中'));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await active?.stop();
  active = null;
  vi.useRealTimers();
});

describe('session mapping', () => {
  it('reuses the stored session of a chat, with its current name', async () => {
    const h = await createHarness({
      stored: { [CHAT]: { sessionId: 'session-old', name: '旧名字' } },
      existing: { 'session-old': '用户改过的名字' },
    });

    h.emit(textEvent('继续上次的分析'));
    await flush();

    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.prompt).toHaveBeenCalledWith('session-old', '继续上次的分析');
    expect(h.sent.at(-1)?.text).toBe('已受理，ModelForge 会话「用户改过的名字」开始处理。');
    expect(h.saveChats).toHaveBeenLastCalledWith({
      [CHAT]: { sessionId: 'session-old', name: '用户改过的名字' },
    });
  });

  it('starts a new session when the stored one was deleted', async () => {
    const h = await createHarness({
      stored: { [CHAT]: { sessionId: 'session-deleted', name: '已删除' } },
    });

    h.emit(textEvent('重新开始'));
    await flush();

    expect(h.createSession).toHaveBeenCalledWith('重新开始');
    expect(h.prompt).toHaveBeenCalledWith('new-session-1', '重新开始');
    expect(h.saveChats).toHaveBeenLastCalledWith({
      [CHAT]: { sessionId: 'new-session-1', name: '飞书：重新开始' },
    });
  });

  it('creates one session for two quick messages of a new chat', async () => {
    const h = await createHarness({ steerResult: true });

    h.emit(textEvent('第一条'));
    h.emit(textEvent('第二条'));
    await flush();

    expect(h.createSession).toHaveBeenCalledTimes(1);
    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(h.steer).toHaveBeenCalledWith('new-session-1', '第二条');
  });
});

describe('messages during a running turn', () => {
  it('steers the running turn when the Kernel accepts it', async () => {
    const h = await createHarness({ steerResult: true });
    h.emit(textEvent('拟合模型'));
    await flush();

    h.emit(textEvent('顺便输出残差图'));
    await flush();

    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(h.sent.at(-1)?.text).toBe('已受理，已追加到会话「飞书：拟合模型」正在进行的任务中。');
  });

  it('queues the message as the next turn when it cannot be steered', async () => {
    const h = await createHarness({ steerResult: false });
    h.emit(textEvent('拟合模型'));
    await flush();

    h.emit(textEvent('再算一遍置信区间'));
    await flush();
    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(h.sent.at(-1)?.text).toContain('正在处理上一条任务');

    h.turns[0].resolve({
      status: 'completed',
      statusText: '完成',
      artifactFileNames: [],
      reply: '',
    });
    await flush();

    expect(h.prompt).toHaveBeenCalledTimes(2);
    expect(h.prompt).toHaveBeenLastCalledWith('new-session-1', '再算一遍置信区间');
  });
});

describe('progress messages', () => {
  it('start after 60 seconds, come at most every 5 minutes and pause during approvals', async () => {
    const h = await createHarness();
    h.emit(textEvent('长时间计算'));
    await flush();

    await vi.advanceTimersByTimeAsync(40_000);
    h.sessionEvent({ type: 'step-completed', sessionId: 'new-session-1', stepName: '读取数据' });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(progress(h)).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(progress(h)).toEqual(['任务进行中：已运行 1 分 0 秒，最近完成的步骤：读取数据。']);

    h.sessionEvent({ type: 'step-completed', sessionId: 'new-session-1', stepName: '拟合' });
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(progress(h)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(progress(h)).toEqual([
      '任务进行中：已运行 1 分 0 秒，最近完成的步骤：读取数据。',
      '任务进行中：已运行 6 分 0 秒，最近完成的步骤：拟合。',
    ]);

    // Nothing while an approval is pending, even past the next 5 minutes.
    const decision = h.requestPermission({
      sessionId: 'new-session-1',
      toolCallId: 'call-1',
      toolName: 'developer__shell',
      arguments: '{}',
    });
    await flush();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(progress(h)).toHaveLength(2);

    const code = /「批准 ([A-Z0-9]{6})」/.exec(h.sent.map((m) => m.text).join('\n'))?.[1];
    h.emit(textEvent(`批准 ${code}`));
    await flush();
    await expect(decision).resolves.toEqual({ outcome: 'allow' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(progress(h)).toHaveLength(3);

    // None after the turn ended.
    h.turns[0].resolve({
      status: 'completed',
      statusText: '完成',
      artifactFileNames: [],
      reply: '',
    });
    await flush();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(progress(h)).toHaveLength(3);
  });
});

describe('inbound filtering and replies', () => {
  it('handles a message delivered twice only once', async () => {
    const h = await createHarness();
    const event = textEvent('只处理一次');

    h.emit(event);
    h.emit({ ...event });
    await flush();

    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(h.sent).toHaveLength(1);
  });

  it('treats an approval reply with an unknown code as a reply, not a task', async () => {
    const h = await createHarness();

    h.emit(textEvent('批准 ABC234'));
    await flush();

    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.sent.at(-1)?.text).toBe('审批码 ABC234 无效或已失效，没有对应的待审批工具调用。');
  });

  it('masks key values in everything it sends', async () => {
    const h = await createHarness({ redact: (text) => text.replaceAll('sk-live-123', '***') });
    h.emit(textEvent('用 sk-live-123 调接口'));
    await flush();

    h.turns[0].resolve({
      status: 'completed',
      statusText: '完成',
      artifactFileNames: [],
      reply: '已用 sk-live-123 完成调用',
    });
    await flush();

    expect(h.sent.map((message) => message.text).join('\n')).not.toContain('sk-live-123');
    expect(h.sent.at(-1)?.text).toBe('状态：完成\n结果：\n已用 *** 完成调用');
  });

  it('cancels pending approvals when the ACP connection closes', async () => {
    const h = await createHarness();
    h.emit(textEvent('删除临时文件'));
    await flush();
    const decision = h.requestPermission({
      sessionId: 'new-session-1',
      toolCallId: 'call-1',
      toolName: 'developer__shell',
      arguments: '{"command":"rm tmp"}',
    });
    await flush();

    h.sessionEvent({ type: 'disconnected' });

    await expect(decision).resolves.toEqual({ outcome: 'cancelled' });
  });
});
