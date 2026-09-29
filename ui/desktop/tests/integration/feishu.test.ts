import { describe, expect, it } from 'vitest';
import {
  createFeishuConnector,
  type FeishuAcpPort,
  type FeishuApprovalRequest,
  type FeishuConnector,
  type FeishuInboundEvent,
  type FeishuRunUpdate,
} from '../../src/connectors/feishu/feishuConnector';
import { FEISHU_SUMMARY_LIMIT, FEISHU_SUMMARY_NOTE } from '../../src/connectors/feishu/replyFormat';

class FakeAcp implements FeishuAcpPort {
  sessions = 0;
  prompted: Array<{ sessionId: string; text: string }> = [];
  responded: Array<{ request: FeishuApprovalRequest; outcome: string; reason?: string }> = [];
  undelivered: string[] = [];
  permissionHandler: ((request: FeishuApprovalRequest) => void) | null = null;
  runHandler: ((update: FeishuRunUpdate) => void) | null = null;

  async createSession() {
    const id = `s${this.sessions++}`;
    return { sessionId: id, name: `会话 ${this.sessions}` };
  }
  async prompt(sessionId: string, text: string) {
    this.prompted.push({ sessionId, text });
  }
  async respondPermission(request: FeishuApprovalRequest, outcome: 'allow' | 'deny', reason?: string) {
    this.responded.push({ request, outcome, reason });
  }
  async markUndelivered(sessionId: string) {
    this.undelivered.push(sessionId);
  }
  onPermissionRequest(handler: (request: FeishuApprovalRequest) => void) {
    this.permissionHandler = handler;
    return () => {};
  }
  onRunUpdate(handler: (update: FeishuRunUpdate) => void) {
    this.runHandler = handler;
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

function setup(overrides: { send?: (id: string, text: string) => Promise<void> } = {}) {
  const sent: string[] = [];
  let messageHandler: ((event: FeishuInboundEvent) => void) | null = null;
  const acp = new FakeAcp();
  const connector: FeishuConnector = createFeishuConnector({
    whitelist: ['ou_1'],
    send: { sendText: overrides.send ?? (async (_id, text) => { sent.push(text); }) },
    acp,
    store: { load: async () => ({}), save: async () => {} },
    onMessage: (handler) => {
      messageHandler = handler;
      return () => {};
    },
    retryIntervalMs: 1,
    retryMax: 1,
    approvalTimeoutMs: 50,
    randomInt: () => 0,
  });
  return { sent, acp, connector, messageHandler };
}

function emit(handler: ((event: FeishuInboundEvent) => void) | null, event: FeishuInboundEvent): void {
  if (!handler) {
    throw new Error('message handler not registered');
  }
  handler(event);
}

describe('feishu connector (integration, fake SDK/ACP)', () => {
  it('forwards a whitelisted private text message and replies an accept notice', async () => {
    const { sent, acp, connector, messageHandler } = setup();
    await connector.start();
    emit(messageHandler, {
      chatId: 'chat1',
      message: { chatType: 'p2p', messageType: 'text', text: '帮我建模', senderOpenId: 'ou_1' },
    });

    await waitUntil(() => acp.prompted.length === 1 && sent.length >= 1);
    expect(acp.prompted[0].text).toBe('帮我建模');
    expect(sent[0]).toContain('已受理');
    expect(sent[0]).toContain('会话');
  });

  it('ignores a non-whitelisted sender', async () => {
    const { sent, acp, connector, messageHandler } = setup();
    await connector.start();
    emit(messageHandler, {
      chatId: 'chat2',
      message: { chatType: 'p2p', messageType: 'text', text: 'hi', senderOpenId: 'ou_evil' },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(acp.prompted).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('truncates a long summary with the session note', async () => {
    const { sent, acp, connector, messageHandler } = setup();
    await connector.start();
    emit(messageHandler, {
      chatId: 'chat3',
      message: { chatType: 'p2p', messageType: 'text', text: 'run', senderOpenId: 'ou_1' },
    });
    await waitUntil(() => acp.prompted.length === 1);

    const run: FeishuRunUpdate = {
      sessionId: 's0',
      status: 'completed',
      artifactFileNames: Array.from({ length: 300 }, (_, i) => `artifact-${i}.png`),
      startedAt: 0,
    };
    acp.runHandler?.(run);

    await waitUntil(() => sent.some((text) => text.includes('完成')));
    const summary = sent.find((text) => text.includes('完成')) ?? '';
    expect([...summary].length).toBeLessThanOrEqual(FEISHU_SUMMARY_LIMIT);
    expect(summary.endsWith(FEISHU_SUMMARY_NOTE)).toBe(true);
  });

  it('marks the session undelivered after all reply retries fail', async () => {
    const { sent, acp, connector, messageHandler } = setup({
      send: async () => {
        throw new Error('network down');
      },
    });
    await connector.start();
    emit(messageHandler, {
      chatId: 'chat4',
      message: { chatType: 'p2p', messageType: 'text', text: 'run', senderOpenId: 'ou_1' },
    });
    await waitUntil(() => acp.prompted.length === 1);

    acp.runHandler?.({
      sessionId: 's0',
      status: 'completed',
      artifactFileNames: ['a.pdf'],
      startedAt: 0,
    });
    await waitUntil(() => acp.undelivered.length === 1);
    expect(acp.undelivered).toEqual(['s0']);
    expect(sent).toHaveLength(0);
  });

  it('denies an approval that times out and explains the reason', async () => {
    const { sent, acp, connector } = setup();
    await connector.start();
    acp.permissionHandler?.({ sessionId: 's0', chatId: 'chat5', toolName: 'run', arguments: '{"x":1}' });

    await waitUntil(() => acp.responded.length === 1);
    expect(acp.responded[0].outcome).toBe('deny');
    expect(acp.responded[0].reason).toBe('已超时');
    expect(sent.some((text) => text.includes('工具审批'))).toBe(true);
    expect(sent.some((text) => text.includes('未执行'))).toBe(true);
  });
});
