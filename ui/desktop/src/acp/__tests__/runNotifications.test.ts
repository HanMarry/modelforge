import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  RunFinishedNotification_unstable,
  RunStartedNotification_unstable,
} from '@aaif/goose-acp-client';
import {
  handleAcpRunFinishedNotification,
  handleAcpRunStartedNotification,
  handleRunToolCallEnded,
  RUN_END_GRACE_MS,
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

  describe('with the desktop main process', () => {
    const original = window.electron;

    afterEach(() => {
      window.electron = original;
    });

    it('passes each notification on to the main process', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const artifactsRunStarted = vi
        .fn()
        .mockResolvedValue({ ok: true, data: { schemaVersion: 1, entries: {} } });
      const artifactsRunFinished = vi
        .fn()
        .mockResolvedValue({ ok: false, error: { code: 'READ_FAILED', message: 'unreadable' } });
      window.electron = { ...original, artifactsRunStarted, artifactsRunFinished };

      await handleAcpRunStartedNotification(started);
      await handleAcpRunFinishedNotification(finished);

      expect(artifactsRunStarted).toHaveBeenCalledExactlyOnceWith({
        workingDir: '/projects/q1',
        runId: RUN_ID,
        declaredOutputs: ['results/out.csv'],
        toolCallId: 'tool-1',
      });
      expect(artifactsRunFinished).toHaveBeenCalledExactlyOnceWith({
        workingDir: '/projects/q1',
        runId: RUN_ID,
        recordPath: `.modelforge/runs/${RUN_ID}.json`,
        toolCallId: 'tool-1',
      });
      // The refusal is logged; the rescan of the Project catches up later.
      expect(warn).toHaveBeenCalledOnce();
    });

    describe('when the tool call that started a run ends', () => {
      const ok = { ok: true, data: { schemaVersion: 1, entries: {} } };

      afterEach(() => {
        vi.useRealTimers();
      });

      function mainProcessWith() {
        const artifactsRunStarted = vi.fn().mockResolvedValue(ok);
        const artifactsRunFinished = vi.fn().mockResolvedValue(ok);
        window.electron = { ...original, artifactsRunStarted, artifactsRunFinished };
        return artifactsRunFinished;
      }

      it('tells the main process the run is over when no runs/finished follows', async () => {
        vi.useFakeTimers();
        const artifactsRunFinished = mainProcessWith();
        await handleAcpRunStartedNotification({ ...started, toolCallId: 'tool-no-record' });

        handleRunToolCallEnded('session-1', 'tool-no-record');
        await vi.advanceTimersByTimeAsync(RUN_END_GRACE_MS - 1);
        expect(artifactsRunFinished).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        expect(artifactsRunFinished).toHaveBeenCalledExactlyOnceWith({
          workingDir: '/projects/q1',
          runId: RUN_ID,
          recordPath: `.modelforge/runs/${RUN_ID}.json`,
          toolCallId: 'tool-no-record',
        });
        // Once is enough.
        handleRunToolCallEnded('session-1', 'tool-no-record');
        await vi.advanceTimersByTimeAsync(RUN_END_GRACE_MS);
        expect(artifactsRunFinished).toHaveBeenCalledOnce();
      });

      it('lets the runs/finished that follows end the run instead', async () => {
        vi.useFakeTimers();
        const artifactsRunFinished = mainProcessWith();
        const toolCallId = 'tool-with-record';
        await handleAcpRunStartedNotification({ ...started, toolCallId });

        handleRunToolCallEnded('session-1', toolCallId);
        await handleAcpRunFinishedNotification({ ...finished, toolCallId });
        await vi.advanceTimersByTimeAsync(RUN_END_GRACE_MS);

        expect(artifactsRunFinished).toHaveBeenCalledExactlyOnceWith({
          workingDir: '/projects/q1',
          runId: RUN_ID,
          recordPath: `.modelforge/runs/${RUN_ID}.json`,
          toolCallId,
        });
      });

      it('ignores tool calls that started no run', async () => {
        vi.useFakeTimers();
        const artifactsRunFinished = mainProcessWith();

        handleRunToolCallEnded('session-1', 'tool-without-run');
        handleRunToolCallEnded('session-2', 'tool-no-record');
        await vi.advanceTimersByTimeAsync(RUN_END_GRACE_MS);

        expect(artifactsRunFinished).not.toHaveBeenCalled();
      });
    });

    it('still notifies the listeners when the main process cannot be reached', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const onStarted = vi.fn();
      unsubscribers.push(subscribeToRunStarted(onStarted));
      window.electron = {
        ...original,
        artifactsRunStarted: vi.fn(() => {
          throw new Error('the main process is gone');
        }),
      };

      await expect(handleAcpRunStartedNotification(started)).resolves.toBeUndefined();
      expect(onStarted).toHaveBeenCalledExactlyOnceWith(started);
    });
  });
});
