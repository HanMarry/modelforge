// @vitest-environment node
/**
 * The Feishu connector's ACP port over a fake goose ACP client (tasks 19.5, 19.6): sessions are
 * created and driven on this connection, permission requests are answered with the denial
 * reason in `_meta`, and a turn's end is reported with its failure category.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  methods,
  RequestError,
  type PermissionOption,
  type RequestPermissionRequest,
  type SessionNotification,
  type Stream,
} from '@agentclientprotocol/sdk';
import type { GooseAcpCallbacks, GooseAcpClient } from '../../acp/gooseAcpClient';
import type {
  FeishuApprovalDecision,
  FeishuSessionEvent,
  FeishuTurnOutcome,
} from './feishuConnector';
import {
  FEISHU_ACP_CLIENT,
  FEISHU_PERMISSION_META_KEY,
  createFeishuAcpPort,
  failureFromError,
  permissionResponse,
  turnOutcome,
} from './feishuAcpPort';

const OPTIONS: PermissionOption[] = [
  { optionId: 'allow_always', name: 'allow_always', kind: 'allow_always' },
  { optionId: 'allow_once', name: 'allow_once', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'reject_once', kind: 'reject_once' },
  { optionId: 'reject_always', name: 'reject_always', kind: 'reject_always' },
];

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createFakeKernel() {
  const prompts: Array<Deferred<{ stopReason: string }>> = [];
  const connections: Array<{ close: () => void }> = [];
  let callbacks: GooseAcpCallbacks | null = null;

  const request = vi.fn(async (method: string, _params: unknown): Promise<unknown> => {
    if (method === methods.agent.initialize) {
      return { protocolVersion: 1 };
    }
    if (method === methods.agent.session.new) {
      return { sessionId: 'session-1' };
    }
    if (method === methods.agent.session.prompt) {
      const turn = deferred<{ stopReason: string }>();
      prompts.push(turn);
      return turn.promise;
    }
    throw new Error(`unexpected ${method}`);
  });
  const goose = {
    sessionRename_unstable: vi.fn(async (_params: { sessionId: string; title: string }) => {}),
    sessionInfo_unstable: vi.fn(
      async (_params: { sessionId: string }): Promise<{ session: { title?: string | null } }> => ({
        session: { title: '飞书：数据分析' },
      })
    ),
    sessionSteer_unstable: vi.fn(async (_params: unknown) => ({
      runId: 'run-7',
      messageId: 'steer-1',
    })),
  };

  const connectClient = vi.fn((_stream: Stream, cb: GooseAcpCallbacks): GooseAcpClient => {
    callbacks = cb;
    const closed = deferred<void>();
    const connection = { close: () => closed.resolve() };
    connections.push(connection);
    return {
      connection: {
        agent: { request },
        closed: closed.promise,
        close: vi.fn(() => closed.resolve()),
      },
      goose,
    } as unknown as GooseAcpClient;
  });

  return {
    request,
    goose,
    prompts,
    connections,
    connectClient,
    callbacks: (): GooseAcpCallbacks => {
      if (!callbacks) {
        throw new Error('not connected');
      }
      return callbacks;
    },
  };
}

function createPort(kernel: ReturnType<typeof createFakeKernel>) {
  const events: FeishuSessionEvent[] = [];
  const runFinished = vi.fn();
  const port = createFeishuAcpPort({
    openStream: async () => ({}) as Stream,
    workingDir: async () => '/projects/demo',
    clientInfo: { name: 'modelforge-feishu', version: 'test' },
    onRunFinished: runFinished,
    connectClient: kernel.connectClient,
  });
  port.onSessionEvent((event) => events.push(event));
  return { port, events, runFinished };
}

function update(sessionId: string, value: Record<string, unknown>): SessionNotification {
  return { sessionId, update: value } as unknown as SessionNotification;
}

/** A macrotask boundary: every pending promise callback has run afterwards. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('createFeishuAcpPort', () => {
  it('connects once, declares run notifications only, and creates a named user session', async () => {
    const kernel = createFakeKernel();
    const { port } = createPort(kernel);

    const session = await port.createSession('  数据分析\n第一问  ');

    expect(session).toEqual({ sessionId: 'session-1', name: '飞书：数据分析 第一问' });
    const [initialize, newSession] = kernel.request.mock.calls;
    expect(initialize[0]).toBe(methods.agent.initialize);
    expect(initialize[1]).toMatchObject({
      clientCapabilities: { _meta: { goose: { runNotifications: true } } },
      clientInfo: { name: 'modelforge-feishu', version: 'test' },
    });
    const goose = (initialize[1] as { clientCapabilities: { _meta: { goose: object } } })
      .clientCapabilities._meta.goose;
    expect(Object.keys(goose)).toEqual(['runNotifications']);
    expect(newSession).toEqual([
      methods.agent.session.new,
      { cwd: '/projects/demo', mcpServers: [], _meta: { client: FEISHU_ACP_CLIENT } },
    ]);
    expect(kernel.goose.sessionRename_unstable).toHaveBeenCalledWith({
      sessionId: 'session-1',
      title: '飞书：数据分析 第一问',
    });

    await port.sessionInfo('session-1');
    expect(kernel.connectClient).toHaveBeenCalledTimes(1);
  });

  it('reports a deleted session as missing', async () => {
    const kernel = createFakeKernel();
    const { port } = createPort(kernel);
    kernel.goose.sessionInfo_unstable.mockRejectedValueOnce(
      new RequestError(-32002, 'Resource not found', 'Session not found: session-9')
    );

    await expect(port.sessionInfo('session-9')).resolves.toBeNull();
    await expect(port.sessionInfo('session-1')).resolves.toEqual({ name: '飞书：数据分析' });
  });

  it('answers permission requests through the connector, with the denial reason in _meta', async () => {
    const kernel = createFakeKernel();
    const { port } = createPort(kernel);
    const decisions: FeishuApprovalDecision[] = [
      { outcome: 'deny', reason: 'timeout' },
      { outcome: 'allow' },
    ];
    const handler = vi.fn(async () => decisions.shift() ?? { outcome: 'cancelled' as const });
    port.onPermissionRequest(handler);
    await port.createSession('清理');
    const callbacks = kernel.callbacks();

    const turn = port.prompt('session-1', '清理旧结果');
    await flush();
    await callbacks.sessionUpdate(
      update('session-1', {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'developer: shell · rm -rf results',
        status: 'pending',
        _meta: {
          goose: { toolCall: { toolName: 'developer__shell', extensionName: 'developer' } },
        },
      })
    );
    const request: RequestPermissionRequest = {
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'call-1',
        title: 'developer: shell · rm -rf results',
        rawInput: { command: 'rm -rf results' },
      },
      options: OPTIONS,
    };

    await expect(callbacks.requestPermission(request)).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'reject_once' },
      _meta: { [FEISHU_PERMISSION_META_KEY]: { reason: 'timeout' } },
    });
    expect(handler).toHaveBeenCalledWith({
      sessionId: 'session-1',
      toolCallId: 'call-1',
      toolName: 'developer__shell',
      arguments: '{"command":"rm -rf results"}',
    });
    await expect(callbacks.requestPermission(request)).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });

    kernel.prompts[0].resolve({ stopReason: 'end_turn' });
    await expect(turn).resolves.toMatchObject({ status: 'completed' });
  });

  it('reports steps, run outputs and the final reply of a turn', async () => {
    const kernel = createFakeKernel();
    const { port, events, runFinished } = createPort(kernel);
    await port.createSession('拟合');
    const callbacks = kernel.callbacks();

    const turn = port.prompt('session-1', '拟合模型并画图');
    await flush();
    expect(kernel.request).toHaveBeenLastCalledWith(methods.agent.session.prompt, {
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: '拟合模型并画图' }],
    });

    await callbacks.sessionUpdate(
      update('session-1', {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-1',
        content: { type: 'text', text: '先运行脚本。' },
      })
    );
    await callbacks.sessionUpdate(
      update('session-1', {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'modeling: run script · fit.py',
        status: 'pending',
      })
    );
    await callbacks.sessionUpdate(
      update('session-1', {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
      })
    );
    await callbacks.unstable_runsFinished({
      sessionId: 'session-1',
      toolCallId: 'call-1',
      runId: 'run-1',
      workingDir: '/projects/demo',
      recordPath: '.modelforge/runs/run-1.json',
      exitCode: 0,
      outputs: ['figures\\fit.png', 'results/table.csv', 'figures\\fit.png'],
    });
    await callbacks.sessionUpdate(
      update('session-1', {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-2',
        content: { type: 'text', text: '拟合完成，' },
      })
    );
    await callbacks.sessionUpdate(
      update('session-1', {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-2',
        content: { type: 'text', text: 'R² = 0.93。' },
      })
    );
    kernel.prompts[0].resolve({ stopReason: 'end_turn' });

    await expect(turn).resolves.toEqual({
      status: 'completed',
      statusText: '完成',
      artifactFileNames: ['figures/fit.png', 'results/table.csv'],
      reply: '拟合完成，R² = 0.93。',
    } satisfies FeishuTurnOutcome);
    expect(events).toEqual([
      { type: 'step-completed', sessionId: 'session-1', stepName: 'modeling: run script · fit.py' },
    ]);
    expect(runFinished).toHaveBeenCalledTimes(1);
  });

  it('steers the running turn with the run id the Kernel announced', async () => {
    const kernel = createFakeKernel();
    const { port } = createPort(kernel);
    await port.createSession('长任务');
    const callbacks = kernel.callbacks();

    expect(await port.steer('session-1', '顺便输出残差')).toBe(false);
    await callbacks.sessionUpdate(
      update('session-1', {
        sessionUpdate: 'session_info_update',
        _meta: { goose: { activeRunId: 'run-7' } },
      })
    );

    expect(await port.steer('session-1', '顺便输出残差')).toBe(true);
    expect(kernel.goose.sessionSteer_unstable).toHaveBeenCalledWith({
      sessionId: 'session-1',
      expectedRunId: 'run-7',
      prompt: [{ type: 'text', text: '顺便输出残差' }],
    });

    await callbacks.sessionUpdate(
      update('session-1', {
        sessionUpdate: 'session_info_update',
        _meta: { goose: { activeRunId: null } },
      })
    );
    expect(await port.steer('session-1', '再来一条')).toBe(false);
  });

  it('reconnects after the connection closes and tells the connector', async () => {
    const kernel = createFakeKernel();
    const { port, events } = createPort(kernel);
    await port.createSession('第一次');

    kernel.connections[0].close();
    await flush();
    expect(events).toEqual([{ type: 'disconnected' }]);

    await port.sessionInfo('session-1');
    expect(kernel.connectClient).toHaveBeenCalledTimes(2);
  });
});

describe('permissionResponse', () => {
  it('maps decisions to ACP outcomes', () => {
    expect(permissionResponse(OPTIONS, { outcome: 'allow' })).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
    expect(permissionResponse(OPTIONS, { outcome: 'deny', reason: 'rejected' })).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject_once' },
      _meta: { 'modelforge/permission': { reason: 'rejected' } },
    });
    expect(permissionResponse(OPTIONS, { outcome: 'cancelled' })).toEqual({
      outcome: { outcome: 'cancelled' },
    });
    // Without a one-time reject option the denial still says why.
    expect(permissionResponse([], { outcome: 'deny', reason: 'timeout' })).toEqual({
      outcome: { outcome: 'cancelled' },
      _meta: { 'modelforge/permission': { reason: 'timeout' } },
    });
  });
});

describe('failure categories', () => {
  const turnWith = (reply: string) => ({ artifacts: [], reply });

  it('classifies how a turn ended', () => {
    expect(turnOutcome('cancelled', turnWith(''))).toEqual({
      status: 'failed',
      failure: '用户中断',
    });
    expect(turnOutcome('refusal', turnWith(''))).toEqual({
      status: 'failed',
      failure: '模型供应商错误',
    });
    expect(
      turnOutcome(
        'end_turn',
        turnWith(
          'Ran into this error: Request failed: 503.\n\nPlease retry if you think this is a transient or recoverable error.'
        )
      )
    ).toEqual({ status: 'failed', failure: '模型供应商错误' });
    expect(turnOutcome('max_turn_requests', turnWith('部分完成'))).toMatchObject({
      status: 'completed',
      statusText: '已停止：达到单次任务的轮次上限',
    });
  });

  it('classifies errors of a turn', () => {
    expect(failureFromError(new RequestError(-32000, 'Authentication required'))).toBe(
      '模型供应商错误'
    );
    expect(
      failureFromError(new RequestError(-32603, 'Internal error', { reason: 'credits_exhausted' }))
    ).toBe('模型供应商错误');
    expect(
      failureFromError(
        new RequestError(
          -32603,
          'Internal error',
          'Error in agent response stream: extension developer crashed'
        )
      )
    ).toBe('工具执行错误');
    expect(failureFromError(new Error('ACP connection closed'))).toBe('内核异常');
  });
});
