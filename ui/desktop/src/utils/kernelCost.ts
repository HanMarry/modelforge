/**
 * Cost estimate for sessions served by an external kernel.
 *
 * The kernel reports its own token usage and goose has no price for the model it names
 * (`current`), while the request is really served by the user's model. So the app prices the
 * kernel's tokens with the per-million prices the user enters for that model.
 */
export interface KernelPrices {
  inputTokenCost: number | null;
  outputTokenCost: number | null;
  currency: string;
}

export const DEFAULT_KERNEL_CURRENCY = '¥';

export function hasKernelPrices(prices: KernelPrices): boolean {
  return prices.inputTokenCost !== null || prices.outputTokenCost !== null;
}

export function estimateKernelCost(
  inputTokens: number,
  outputTokens: number,
  prices: KernelPrices
): number | null {
  if (!hasKernelPrices(prices)) {
    return null;
  }
  const input = ((inputTokens || 0) * (prices.inputTokenCost ?? 0)) / 1_000_000;
  const output = ((outputTokens || 0) * (prices.outputTokenCost ?? 0)) / 1_000_000;
  return input + output;
}

/** Small numbers are common (a chat turn can cost a fraction of a cent), so keep 4 decimals. */
export function formatKernelCost(cost: number, currency: string): string {
  const symbol = currency || DEFAULT_KERNEL_CURRENCY;
  if (cost > 0 && cost < 0.01) {
    return `${symbol}${cost.toFixed(4)}`;
  }
  return `${symbol}${cost.toFixed(2)}`;
}
