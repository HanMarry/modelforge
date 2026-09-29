import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../../test/pbt';
import {
  DIAGNOSTIC_CATEGORIES,
  runAll,
  type CategoryResult,
  type DiagnosticCategory,
  type DiagnosticDetector,
} from './diagnosticsService';

type Behavior = 'ok-normal' | 'ok-abnormal' | 'throw' | 'timeout';

const OK_NORMAL: CategoryResult = {
  state: '正常',
  version: '1.2.3',
  checkedAt: null,
  reason: null,
  fixes: [],
  logIds: [],
};

const OK_ABNORMAL: CategoryResult = {
  state: '异常',
  version: '未知',
  checkedAt: null,
  reason: 'some reason',
  fixes: [],
  logIds: [],
};

function makeDetector(
  behavior: Behavior
): { detector: DiagnosticDetector; expected: CategoryResult; passthrough: boolean } {
  switch (behavior) {
    case 'ok-normal':
      return { detector: async () => OK_NORMAL, expected: OK_NORMAL, passthrough: true };
    case 'ok-abnormal':
      return { detector: async () => OK_ABNORMAL, expected: OK_ABNORMAL, passthrough: true };
    case 'throw':
      return {
        detector: async () => {
          throw new Error('boom');
        },
        expected: { ...OK_ABNORMAL, reason: 'boom' },
        passthrough: false,
      };
    case 'timeout':
      return {
        detector: () => new Promise<CategoryResult>(() => {}),
        expected: { ...OK_ABNORMAL, reason: '检测超时' },
        passthrough: false,
      };
  }
}

// Feature: mathmodel-parity-and-beyond, Property 15: 诊断类别互不影响
describe('Property 15: 诊断类别互不影响', () => {
  it('error/timeout categories become 异常 with a reason, others keep their own result', () => {
    const behaviorArb = fc.constantFrom<Behavior>('ok-normal', 'ok-abnormal', 'throw', 'timeout');
    fc.assert(
      fc.asyncProperty(
        fc.record({
          provider: behaviorArb,
          runtime: behaviorArb,
          python: behaviorArb,
          typesetting: behaviorArb,
        }),
        async (behaviors) => {
          const built = Object.fromEntries(
            DIAGNOSTIC_CATEGORIES.map((category) => [category, makeDetector(behaviors[category])])
          ) as Record<
            DiagnosticCategory,
            { detector: DiagnosticDetector; expected: CategoryResult; passthrough: boolean }
          >;
          const detectors = Object.fromEntries(
            DIAGNOSTIC_CATEGORIES.map((category) => [category, built[category].detector])
          ) as Record<DiagnosticCategory, DiagnosticDetector>;

          const results = await runAll(detectors, { timeoutMs: 20 });

          for (const category of DIAGNOSTIC_CATEGORIES) {
            const { expected, passthrough } = built[category];
            const actual = results[category];
            if (passthrough) {
              expect(actual).toEqual(expected);
            } else {
              expect(actual.state).toBe('异常');
              expect(actual.reason).toBe(expected.reason);
            }
          }
        }
      ),
      pbtParams
    );
  });
});
