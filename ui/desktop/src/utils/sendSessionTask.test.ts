import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatState } from '../types/chatState';
import type { Message } from '../types/message';
import {
  isSameDirectory,
  kernelUnavailableReason,
  sendSessionTask,
  sessionTaskTarget,
} from './sendSessionTask';

const mocks = vi.hoisted(() => ({
  recovering: vi.fn(() => false),
  submitMessage: vi.fn(),
  stop: vi.fn(),
  getSnapshot: vi.fn(),
  setMessages: vi.fn(),
  kernelStatus: vi.fn(),
}));

vi.mock('../acp/acpConnection', () => ({ isAcpRecovering: mocks.recovering }));
vi.mock('../acp/chatSessionController', () => ({
  acpChatSessionController: { submitMessage: mocks.submitMessage, stop: mocks.stop },
}));
vi.mock('../acp/chatSessionStore', () => ({
  acpChatSessionStore: { getSnapshot: mocks.getSnapshot },
  acpChatSessionActions: { setMessages: mocks.setMessages },
}));

const originalElectron = window.electron;
const TIMEOUT_MS = 120_000;

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    session: { id: 'session-1', working_dir: '/project' },
    messages: [],
    chatState: ChatState.Idle,
    sessionLoadError: undefined,
    activePromptAttemptId: null,
    pendingCancelPromptAttemptId: null,
    ...overrides,
  };
}

interface SubmitOptions {
  onFinish: (error?: string) => void;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recovering.mockReturnValue(false);
  mocks.getSnapshot.mockReturnValue(snapshot());
  mocks.kernelStatus.mockResolvedValue({ error: null });
  window.electron = { ...originalElectron, getAgentKernelStatus: mocks.kernelStatus };
});

afterEach(() => {
  vi.useRealTimers();
  window.electron = originalElectron;
});

describe('sendSessionTask', () => {
  it('appends the task to the session and resolves when the turn finishes', async () => {
    const earlier = { id: 'earlier', role: 'user', content: [] };
    mocks.getSnapshot.mockReturnValue(snapshot({ messages: [earlier] }));
    mocks.submitMessage.mockImplementation(
      async (_sessionId: string, _message: Message, options: SubmitOptions) => options.onFinish()
    );

    await expect(sendSessionTask('session-1', 'write the paragraph', TIMEOUT_MS)).resolves.toEqual(
      { ok: true }
    );

    const [sessionId, message] = mocks.submitMessage.mock.calls[0];
    expect(sessionId).toBe('session-1');
    expect(message.role).toBe('user');
    expect(message.content).toEqual([{ type: 'text', text: 'write the paragraph' }]);
    expect(mocks.setMessages).toHaveBeenCalledWith('session-1', [earlier, message]);
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it('reports the Kernel as unavailable without sending', async () => {
    mocks.kernelStatus.mockResolvedValue({ error: 'shim failed to start' });

    await expect(sendSessionTask('session-1', 'task', TIMEOUT_MS)).resolves.toEqual({
      ok: false,
      reason: 'kernelUnavailable',
      detail: 'shim failed to start',
    });
    expect(mocks.setMessages).not.toHaveBeenCalled();
    expect(mocks.submitMessage).not.toHaveBeenCalled();
  });

  it('reports the Kernel as unavailable while reconnecting or when the session is not loaded', async () => {
    mocks.recovering.mockReturnValueOnce(true);
    await expect(sendSessionTask('session-1', 'task', TIMEOUT_MS)).resolves.toMatchObject({
      ok: false,
      reason: 'kernelUnavailable',
    });

    mocks.getSnapshot.mockReturnValue(
      snapshot({ session: undefined, sessionLoadError: 'connection refused' })
    );
    await expect(sendSessionTask('session-1', 'task', TIMEOUT_MS)).resolves.toEqual({
      ok: false,
      reason: 'kernelUnavailable',
      detail: 'connection refused',
    });
    expect(mocks.submitMessage).not.toHaveBeenCalled();
  });

  it('does not send while the session is running a turn', async () => {
    mocks.getSnapshot.mockReturnValue(snapshot({ chatState: ChatState.Streaming }));

    await expect(sendSessionTask('session-1', 'task', TIMEOUT_MS)).resolves.toMatchObject({
      ok: false,
      reason: 'busy',
    });
    expect(mocks.setMessages).not.toHaveBeenCalled();
    expect(mocks.submitMessage).not.toHaveBeenCalled();
  });

  it('reports a Kernel error from the turn, a rejection or a turn without result', async () => {
    mocks.submitMessage.mockImplementationOnce(
      async (_sessionId: string, _message: Message, options: SubmitOptions) =>
        options.onFinish('model overloaded')
    );
    await expect(sendSessionTask('session-1', 'task', TIMEOUT_MS)).resolves.toEqual({
      ok: false,
      reason: 'kernelError',
      detail: 'model overloaded',
    });

    mocks.submitMessage.mockRejectedValueOnce(new Error('socket closed'));
    await expect(sendSessionTask('session-1', 'task', TIMEOUT_MS)).resolves.toEqual({
      ok: false,
      reason: 'kernelError',
      detail: 'socket closed',
    });

    mocks.submitMessage.mockResolvedValueOnce(undefined);
    await expect(sendSessionTask('session-1', 'task', TIMEOUT_MS)).resolves.toMatchObject({
      ok: false,
      reason: 'kernelError',
    });
  });

  it('treats a credits notice after the task as a Kernel error', async () => {
    mocks.submitMessage.mockImplementationOnce(
      async (_sessionId: string, message: Message, options: SubmitOptions) => {
        const notice = {
          id: 'notice',
          role: 'assistant',
          created: 0,
          content: [
            {
              type: 'systemNotification',
              notificationType: 'creditsExhausted',
              msg: 'Out of credits',
            },
          ],
          metadata: { userVisible: true, agentVisible: false },
        };
        mocks.getSnapshot.mockReturnValue(snapshot({ messages: [message, notice] }));
        options.onFinish();
      }
    );

    await expect(sendSessionTask('session-1', 'task', TIMEOUT_MS)).resolves.toEqual({
      ok: false,
      reason: 'kernelError',
      detail: 'Out of credits',
    });
  });

  it('times out after the given time and stops the turn', async () => {
    vi.useFakeTimers();
    mocks.submitMessage.mockReturnValueOnce(new Promise(() => {}));
    let outcome: unknown;
    const pending = sendSessionTask('session-1', 'task', TIMEOUT_MS).then((value) => {
      outcome = value;
    });

    await vi.advanceTimersByTimeAsync(119_999);
    expect(outcome).toBeUndefined();
    expect(mocks.stop).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(outcome).toEqual({
      ok: false,
      reason: 'timeout',
      detail: 'no result within 120 seconds',
    });
    expect(mocks.stop).toHaveBeenCalledWith('session-1');
  });
});

describe('kernelUnavailableReason', () => {
  it('passes the status error on and treats a failing status query as available', async () => {
    mocks.kernelStatus.mockResolvedValueOnce({ error: 'not started' });
    await expect(kernelUnavailableReason()).resolves.toBe('not started');

    mocks.kernelStatus.mockRejectedValueOnce(new Error('ipc closed'));
    await expect(kernelUnavailableReason()).resolves.toBeNull();

    mocks.recovering.mockReturnValueOnce(true);
    await expect(kernelUnavailableReason()).resolves.toBe('reconnecting to the Kernel');
  });
});

describe('sessionTaskTarget', () => {
  it('returns the session when it is in the store and works in the directory', () => {
    expect(sessionTaskTarget('session-1', '/project')).toBe('session-1');
    expect(mocks.getSnapshot).toHaveBeenCalledWith('session-1');
  });

  it('returns null without a session id or when the store does not hold the session', () => {
    expect(sessionTaskTarget('', '/project')).toBeNull();
    expect(sessionTaskTarget(null, '/project')).toBeNull();
    expect(mocks.getSnapshot).not.toHaveBeenCalled();

    mocks.getSnapshot.mockReturnValue(undefined);
    expect(sessionTaskTarget('session-1', '/project')).toBeNull();
  });

  it('returns null when the session works in another directory', () => {
    expect(sessionTaskTarget('session-1', '/other-project')).toBeNull();
  });

  it('keeps a session whose metadata is not loaded yet, so sending reports why', () => {
    mocks.getSnapshot.mockReturnValue(snapshot({ session: undefined }));
    expect(sessionTaskTarget('session-1', '/project')).toBe('session-1');
  });
});

describe('isSameDirectory', () => {
  it('ignores separators, repeated and trailing slashes', () => {
    expect(isSameDirectory('/home/me/project/', '/home/me//project')).toBe(true);
    expect(isSameDirectory('C:\\Users\\me\\建模\\', 'C:/Users/me/建模')).toBe(true);
    expect(isSameDirectory('/', '/')).toBe(true);
  });

  it('ignores case only for Windows drive paths', () => {
    expect(isSameDirectory('c:\\Users\\Me\\Project', 'C:\\users\\me\\project')).toBe(true);
    expect(isSameDirectory('/home/Me/project', '/home/me/project')).toBe(false);
    expect(isSameDirectory('/home/me/project', '/home/me/project-2')).toBe(false);
  });
});
