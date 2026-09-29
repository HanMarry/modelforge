import { describe, expect, it } from 'vitest';
import { truncateText } from '../../utils/textTruncate';
import {
  FEISHU_SUMMARY_LIMIT,
  FEISHU_SUMMARY_NOTE,
  formatSummary,
  type SummaryResult,
} from './replyFormat';

describe('formatSummary', () => {
  it('lists status and artifact file names within the limit', () => {
    const result: SummaryResult = {
      status: '完成',
      artifactFileNames: ['paper.pdf', 'figure1.png'],
    };
    const summary = formatSummary(result);
    expect(summary).toContain('完成');
    expect(summary).toContain('paper.pdf');
    expect(summary).toContain('figure1.png');
    expect(summary).not.toContain(FEISHU_SUMMARY_NOTE);
  });

  it('appends the session note when truncated, counting it toward the limit', () => {
    const result: SummaryResult = {
      status: '完成',
      artifactFileNames: Array.from({ length: 400 }, (_, i) => `artifact-${i}.png`),
    };
    const summary = formatSummary(result);
    expect([...summary].length).toBeLessThanOrEqual(FEISHU_SUMMARY_LIMIT);
    expect(summary.endsWith(FEISHU_SUMMARY_NOTE)).toBe(true);
  });
});

describe('truncateText example tests', () => {
  it('returns input unchanged at exactly the limit', () => {
    const input = 'a'.repeat(FEISHU_SUMMARY_LIMIT);
    expect(truncateText(input, FEISHU_SUMMARY_LIMIT)).toBe(input);
  });

  it('truncates when one code point over the limit, with ellipsis counting toward it', () => {
    const input = 'a'.repeat(FEISHU_SUMMARY_LIMIT + 1);
    const out = truncateText(input, FEISHU_SUMMARY_LIMIT);
    expect([...out].length).toBe(FEISHU_SUMMARY_LIMIT);
    expect(out.endsWith('…')).toBe(true);
  });

  it('never splits a surrogate pair at the truncation point', () => {
    // 1999 ASCII + one astral character (2 UTF-16 units, 1 code point) = 2000 code points.
    const input = `${'a'.repeat(FEISHU_SUMMARY_LIMIT - 1)}𝄞${'b'.repeat(10)}`;
    const out = truncateText(input, FEISHU_SUMMARY_LIMIT);
    expect([...out].length).toBe(FEISHU_SUMMARY_LIMIT);
    // The astral character survives intact rather than being cut to a lone surrogate.
    expect(out.includes('𝄞')).toBe(true);
    expect(out).not.toContain('\uD834');
  });
});
