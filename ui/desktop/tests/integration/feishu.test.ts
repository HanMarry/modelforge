import { afterEach, describe, expect, it } from 'vitest';
import {
  createFeishuConnector,
  type FeishuAcpPort,
  type FeishuApprovalDecision,
  type FeishuApprovalRequest,
  type FeishuConnector,
  type FeishuInboundEvent,
  type FeishuSessionRef,
  type FeishuTurnOutcome,
} from '../../src/connectors/feishu/feishuConnector';
import { FEISHU_SUMMARY_LIMIT, FEISHU_SUMMARY_NOTE } from '../../src/connectors/feishu/replyFormat';

// The full SDK-level flow on fake timers is in src/connectors/feishu/feishuSdkAdapter.test.ts;
// this keeps a real-timer pass over the connector with short intervals.

class FakeAcp implements FeishuAcpPort {
  sessions = 0;
  prompted: Array<{
    sessionId: string;
    text: string;
    finish: (outcome: FeishuTurnOutcome) => void;
  }> = [];
  permissionHandler: ((request: FeishuApprovalRequest) => Promise<FeishuApprovalDecision>) | null =
    null;

  async createSession(): Promise<FeishuSessionRef> {
    const sessionId = `s${this.sessions}`;
    this.sessions += 1;
    return { sessionId, name: `会话 ${this.sessions}` };
  }
  async sessionInfo(sessionId: string): Promise<{ name: string } | null> {
    return { name: sessionId };
  }
  prompt(sessionId: string, text: string): Promise<FeishuTurnOutcome> {
    return new Promise((finish) => {
      this.prompted.push({ sessionId, text, finish });
    });
  }
  async steer(): Promise<boolean> {
    return false;
  }
  onPermissionRequest(
    handler: (request: FeishuApprovalRequest) => Promise<FeishuApprovalDecision>
  ): () => void {
    this.permissionHandler = handler;
    return () => {};
  }
  onSessionEvent(): () => void {
    return () => {};
  }
}

function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (condition()) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error('condition not met within timeout'));
      } else {
        setTimeout(tick, 5);
      }
    };
    tick();
  });
}

const running: FeishuConnector[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((connector) => connector.stop()));
});

async function setup(overrides: { send?: (chatId: string, text: string) => Promise<void> } = {}) {
  const sent: string[] = [];
  const undelivered: string[] = [];
  let messageHandler: ((event: FeishuInboundEvent) => void) | null = null;
  const acp = new FakeAcp();
  const send =
    overrides.send ??
    (async (_chatId: string, text: string) => {
      sent.push(text);
    });
  const connector = createFeishuConnector({
    whitelist: ['ou_1'],
    messenger: { sendText: send },
    acp,
    store: {
      loadChats: async () => ({}),
      saveChats: async () => {},
      markUndelivered: async (sessionId: string) => {
        undelivered.push(sessionId);
      },
    },
    subscribe: (handler) => {
      messageHandler = handler;
      return () => {};
    },
    retryIntervalMs: 1,
    retryMax: 1,
    approvalTimeoutMs: 50,
    randomInt: () => 0,
  });
  await connector.start();
  running.push(connector);
  const emit = (chatId: string, text: string, senderOpenId = 'ou_1') => {
    if (!messageHandler) {
      throw new Error('message handler not registered');
    }
    messageHandler({
      messageId: `${chatId}-${text}`,
      chatId,
      message: { chatType: 'p2p', messageType: 'text', text, senderOpenId },
    });
  };
  return { sent, undelivered, acp, emit };
}

describe('feishu connector (integration, fake SDK/ACP)', () => {
  it('forwards a whitelisted private text message and replies an accept notice', async () => {
    const { sent, acp, emit } = await setup();
    emit('chat1', '帮我建模');

    await waitUntil(() => acp.prompted.length === 1 && sent.length >= 1);
    expect(acp.prompted[0].text).toBe('帮我建模');
    expect(sent[0]).toContain('已受理');
    expect(sent[0]).toContain('会话 1');
  });

  it('ignores a non-whitelisted sender', async () => {
    const { sent, acp, emit } = await setup();
    emit('chat2', 'hi', 'ou_evil');

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(acp.prompted).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('truncates a long summary with the session note', async () => {
    const { sent, acp, emit } = await setup();
    emit('chat3', 'run');
    await waitUntil(() => acp.prompted.length === 1);

    acp.prompted[0].finish({
      status: 'completed',
      statusText: '完成',
      artifactFileNames: Array.from({ length: 300 }, (_, i) => `artifact-${i}.png`),
      reply: '',
    });

    await waitUntil(() => sent.some((text) => text.startsWith('状态：完成')));
    const summary = sent.find((text) => text.startsWith('状态：完成')) ?? '';
    expect([...summary].length).toBeLessThanOrEqual(FEISHU_SUMMARY_LIMIT);
    expect(summary.endsWith(FEISHU_SUMMARY_NOTE)).toBe(true);
  });

  it('marks the session undelivered after all reply retries fail', async () => {
    const { sent, undelivered, acp, emit } = await setup({
      send: async () => {
        throw new Error('network down');
      },
    });
    emit('chat4', 'run');
    await waitUntil(() => acp.prompted.length === 1);

    acp.prompted[0].finish({
      status: 'completed',
      statusText: '完成',
      artifactFileNames: ['a.pdf'],
      reply: '',
    });
    await waitUntil(() => undelivered.length === 1);
    expect(undelivered).toEqual(['s0']);
    expect(sent).toHaveLength(0);
  });

  it('denies an approval that times out and explains the reason', async () => {
    const { sent, acp, emit } = await setup();
    emit('chat5', 'run');
    await waitUntil(() => acp.prompted.length === 1);
    if (!acp.permissionHandler) {
      throw new Error('permission handler not registered');
    }

    const decision = await acp.permissionHandler({
      sessionId: 's0',
      toolCallId: 'call-1',
      toolName: 'run',
      arguments: '{"x":1}',
    });

    expect(decision).toEqual({ outcome: 'deny', reason: 'timeout' });
    await waitUntil(() => sent.some((text) => text.includes('未执行')));
    expect(sent.some((text) => text.includes('工具调用需要审批'))).toBe(true);
  });
});
