import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  RunFinishedNotification_unstable,
  RunStartedNotification_unstable,
} from '@aaif/goose-acp-client';
import {
  handleAcpRunFinishedNotification,
  handleAcpRunStartedNotification,
  subscribeToRunFinished,
  subscribeToRunStarted,
} from '../runNotifications';

const RUN_ID = '20260920T101530123-a1b2c3';

const started: RunStartedNotification_unstable = {
  sessionId: 'session-1',
  toolCallId: 'tool-1',
  runId: RUN_ID,
  workingDir: '/projects/q1',
  declaredOutputs: ['results/out.csv'],
};

const finished: RunFinishedNotification_unstable = {
  sessionId: 'session-1',
  toolCallId: 'tool-1',
  runId: RUN_ID,
  workingDir: '/projects/q1',
  recordPath: `.modelforge/runs/${RUN_ID}.json`,
  exitCode: 0,
  failure: null,
  outputs: ['results/out.csv'],
};

describe('run notifications', () => {
  const unsubscribers: Array<() => void> = [];

  afterEach(() => {
    unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    vi.restoreAllMocks();
  });

  it('delivers each notification to the listeners of its kind', async () => {
    const onStarted = vi.fn();
    const onFinished = vi.fn();
    unsubscribers.push(subscribeToRunStarted(onStarted), subscribeToRunFinished(onFinished));

    await handleAcpRunStartedNotification(started);
    await handleAcpRunFinishedNotification(finished);

    expect(onStarted).toHaveBeenCalledExactlyOnceWith(started);
    expect(onFinished).toHaveBeenCalledExactlyOnceWith(finished);
  });

  it('stops delivering after unsubscribe', async () => {
    const onFinished = vi.fn();
    const unsubscribe = subscribeToRunFinished(onFinished);

    unsubscribe();
    await handleAcpRunFinishedNotification(finished);

    expect(onFinished).not.toHaveBeenCalled();
  });

  it('keeps delivering when a listener throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = vi.fn(() => {
      throw new Error('listener failed');
    });
    const working = vi.fn();
    unsubscribers.push(subscribeToRunFinished(failing), subscribeToRunFinished(working));

    await expect(handleAcpRunFinishedNotification(finished)).resolves.toBeUndefined();

    expect(failing).toHaveBeenCalledOnce();
    expect(working).toHaveBeenCalledExactlyOnceWith(finished);
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it('resolves without listeners', async () => {
    await expect(handleAcpRunStartedNotification(started)).resolves.toBeUndefined();
  });
});
