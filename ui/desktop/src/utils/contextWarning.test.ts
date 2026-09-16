import { describe, expect, it } from 'vitest';
import {
  CONTEXT_CRITICAL_PERCENT,
  CONTEXT_WARNING_PERCENT,
  contextWarningLevel,
  shouldAnnounce,
} from './contextWarning';

describe('context warning thresholds', () => {
  const limit = 128_000;

  it('stays quiet below the warning threshold', () => {
    expect(contextWarningLevel(0, limit)).toBe(0);
    expect(contextWarningLevel(limit * 0.5, limit)).toBe(0);
    expect(contextWarningLevel(limit * ((CONTEXT_WARNING_PERCENT - 1) / 100), limit)).toBe(0);
  });

  it('warns from the warning threshold', () => {
    expect(contextWarningLevel(limit * (CONTEXT_WARNING_PERCENT / 100), limit)).toBe(1);
    expect(contextWarningLevel(limit * ((CONTEXT_CRITICAL_PERCENT - 1) / 100), limit)).toBe(1);
  });

  it('turns critical from the critical threshold', () => {
    expect(contextWarningLevel(limit * (CONTEXT_CRITICAL_PERCENT / 100), limit)).toBe(2);
    expect(contextWarningLevel(limit, limit)).toBe(2);
    expect(contextWarningLevel(limit * 2, limit)).toBe(2);
  });

  it('ignores unknown limits and empty usage', () => {
    expect(contextWarningLevel(1000, 0)).toBe(0);
    expect(contextWarningLevel(0, limit)).toBe(0);
    expect(contextWarningLevel(-5, limit)).toBe(0);
  });

  it('announces each escalation once', () => {
    expect(shouldAnnounce(1, 0)).toBe(true);
    expect(shouldAnnounce(1, 1)).toBe(false);
    expect(shouldAnnounce(2, 1)).toBe(true);
    expect(shouldAnnounce(2, 2)).toBe(false);
    expect(shouldAnnounce(0, 0)).toBe(false);
  });
});
