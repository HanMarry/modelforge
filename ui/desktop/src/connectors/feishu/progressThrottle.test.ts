import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../../test/pbt';
import {
  PROGRESS_MIN_ELAPSED_MS,
  PROGRESS_MIN_INTERVAL_MS,
  progressMessages,
  type ProgressEvent,
  type ProgressPhase,
  type ProgressRun,
} from './progressThrottle';

const phases: ProgressPhase[] = ['completed', 'failed', 'awaiting-approval'];

// Feature: mathmodel-parity-and-beyond, Property 35: 飞书进度消息节流
describe('Property 35: 飞书进度消息节流', () => {
  it('emits at most one message per 5 minutes, only after 60s, never after the end', () => {
    fc.assert(
      fc.property(
        fc.nat(1_000_000),
        fc.array(
          fc.record({
            offsetMs: fc.integer({ min: 0, max: PROGRESS_MIN_ELAPSED_MS * 4 }),
            stepName: fc.string({ minLength: 1, maxLength: 20 }),
          }),
          { minLength: 1, maxLength: 40 }
        ),
        fc.constantFrom(...phases),
        fc.boolean(),
        (startMs, steps, phase, hasEnd) => {
          const events: ProgressEvent[] = steps.map((step) => ({
            atMs: startMs + step.offsetMs,
            stepName: step.stepName,
          }));
          const end = hasEnd
            ? { atMs: startMs + PROGRESS_MIN_ELAPSED_MS * 2, phase }
            : null;
          const run: ProgressRun = { startMs, events, end };

          const messages = progressMessages(run);

          // Elapsed ≥ 60s for every message.
          for (const message of messages) {
            expect(message.elapsedMs).toBeGreaterThanOrEqual(PROGRESS_MIN_ELAPSED_MS);
            expect(message.elapsedMs).toBe(message.atMs - startMs);
          }
          // Consecutive messages at least 5 minutes apart.
          for (let i = 1; i < messages.length; i += 1) {
            expect(messages[i].atMs - messages[i - 1].atMs).toBeGreaterThanOrEqual(
              PROGRESS_MIN_INTERVAL_MS
            );
          }
          // Nothing after the terminal moment.
          if (end) {
            for (const message of messages) {
              expect(message.atMs).toBeLessThan(end.atMs);
            }
          }
        }
      ),
      pbtParams
    );
  });

  it('uses the most recent completed step name in each message', () => {
    const run: ProgressRun = {
      startMs: 0,
      events: [
        { atMs: 10_000, stepName: 'data load' },
        { atMs: 70_000, stepName: 'model solve' },
      ],
      end: null,
    };
    const [message] = progressMessages(run);
    expect(message.stepName).toBe('model solve');
  });
});
