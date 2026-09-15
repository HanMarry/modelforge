/**
 * Rough token estimate for text that has been generated but not yet counted by the backend.
 *
 * The kernel only reports `used` (the prompt size of the last request), so the live indicator
 * would otherwise freeze for the whole turn. This is deliberately a heuristic: CJK runs are
 * close to 1.5 characters per token, Latin text closer to 4.
 */
const CJK_PATTERN = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  const cjkCount = text.match(CJK_PATTERN)?.length ?? 0;
  const otherCount = text.length - cjkCount;
  return Math.round(cjkCount / 1.5 + otherCount / 4);
}

export function estimateTokensFromChars(charCount: number): number {
  return charCount <= 0 ? 0 : Math.round(charCount / 2.5);
}
