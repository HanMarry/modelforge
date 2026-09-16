import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KERNEL_CURRENCY,
  estimateKernelCost,
  formatKernelCost,
  hasKernelPrices,
} from './kernelCost';

describe('kernel cost estimate', () => {
  it('prices input and output tokens per million', () => {
    const cost = estimateKernelCost(1_000_000, 500_000, {
      inputTokenCost: 2,
      outputTokenCost: 8,
      currency: '¥',
    });

    expect(cost).toBeCloseTo(2 + 4, 6);
  });

  it('returns null when the user has not entered prices', () => {
    expect(
      estimateKernelCost(1000, 1000, {
        inputTokenCost: null,
        outputTokenCost: null,
        currency: '',
      })
    ).toBeNull();
    expect(
      hasKernelPrices({ inputTokenCost: null, outputTokenCost: null, currency: '' })
    ).toBe(false);
  });

  it('treats a missing side as free instead of failing', () => {
    const cost = estimateKernelCost(1_000_000, 1_000_000, {
      inputTokenCost: 1,
      outputTokenCost: null,
      currency: '',
    });

    expect(cost).toBeCloseTo(1, 6);
  });

  it('keeps small amounts readable', () => {
    expect(formatKernelCost(0.0042, '¥')).toBe('¥0.0042');
    expect(formatKernelCost(0.42, '¥')).toBe('¥0.42');
    expect(formatKernelCost(1, '')).toBe(`${DEFAULT_KERNEL_CURRENCY}1.00`);
  });
});
