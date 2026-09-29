import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../../test/pbt';
import {
  initialWizardState,
  isKeySubmittable,
  next,
  openAt,
  prev,
  skip,
  skippedSteps,
} from './wizardMachine';
import { classifyProviderError, type ProviderErrorClass } from '../../utils/providerConnectivity';

const CLASSES: readonly ProviderErrorClass[] = [
  'invalid_key',
  'network',
  'quota',
  'model_unsupported',
  'timeout',
  'other',
];

describe('classifyProviderError', () => {
  it.each([
    [401, '', null, 'invalid_key'],
    [403, '', null, 'invalid_key'],
    [402, '', null, 'quota'],
    [429, '', null, 'quota'],
    [200, 'insufficient quota', null, 'quota'],
    [404, '', null, 'model_unsupported'],
    [200, 'model not found', null, 'model_unsupported'],
    [500, 'server exploded', null, 'other'],
  ] as const)('maps status %s body %j to %s', (status, body, cause, expected) => {
    expect(classifyProviderError(status, body, cause)).toBe(expected);
  });

  it('maps a missing response with a network error to network', () => {
    expect(classifyProviderError(null, '', new TypeError('fetch failed'))).toBe('network');
  });
});

// Feature: mathmodel-parity-and-beyond, Property 14: 向导密钥校验与错误分类
describe('Property 14: 向导密钥校验与错误分类', () => {
  it('a key is submittable iff its trimmed length is 1..512', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 600 }), (key) => {
        const trimmed = key.trim();
        expect(isKeySubmittable(key)).toBe(trimmed.length >= 1 && trimmed.length <= 512);
      }),
      pbtParams
    );
  });

  it('classifies into exactly one class, and timeout/abort always maps to timeout', () => {
    const scenario = fc.record({
      status: fc.oneof(fc.constant(null), fc.integer({ min: 100, max: 599 })),
      body: fc.string({ maxLength: 40 }),
      causeKind: fc.constantFrom('abort', 'timeout', 'network', 'none'),
    });
    fc.assert(
      fc.property(scenario, ({ status, body, causeKind }) => {
        let cause: unknown;
        if (causeKind === 'abort') {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          cause = error;
        } else if (causeKind === 'timeout') {
          const error = new Error('The request timed out');
          error.name = 'TimeoutError';
          cause = error;
        } else if (causeKind === 'network') {
          cause = new TypeError('fetch failed');
        } else {
          cause = null;
        }
        const cls = classifyProviderError(status, body, cause);
        expect(CLASSES).toContain(cls);
        if (causeKind === 'abort' || causeKind === 'timeout') {
          expect(cls).toBe('timeout');
        }
      }),
      pbtParams
    );
  });
});

describe('wizard machine', () => {
  it('walks the four steps and completes on the last next', () => {
    let state = initialWizardState();
    expect(state.current).toBe('provider');
    state = next(state);
    expect(state.current).toBe('key');
    state = next(state);
    expect(state.current).toBe('environment');
    state = next(state);
    expect(state.current).toBe('example');
    state = next(state);
    expect(state.completed).toBe(true);
  });

  it('records skipped steps and completes on the last skip', () => {
    let state = initialWizardState();
    state = skip(state);
    state = skip(state);
    expect(skippedSteps(state)).toEqual(['provider', 'key']);
    state = skip(state);
    state = skip(state);
    expect(state.completed).toBe(true);
    expect(skippedSteps(state)).toEqual(['provider', 'key', 'environment', 'example']);
  });

  it('prev returns to the previous step but not before the first', () => {
    let state = next(initialWizardState());
    state = prev(state);
    expect(state.current).toBe('provider');
    state = prev(state);
    expect(state.current).toBe('provider');
  });

  it('openAt jumps to a step for 补做', () => {
    let state = initialWizardState();
    state = openAt(state, 'environment');
    expect(state.current).toBe('environment');
    state = next(state);
    expect(state.steps.environment).toBe('done');
  });
});
