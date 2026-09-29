import { describe, expect, it } from 'vitest';
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

// 任务 19.3 的示例测试：恰好 2000、超出 1 个码点、截断处是代理对。
// 没有生成文件时摘要为 `状态：<status>`，前缀「状态：」占 3 个码点。
const STATUS_PREFIX_LENGTH = 3;
const NOTE_LENGTH = [...FEISHU_SUMMARY_NOTE].length;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function summaryWithStatus(status: string): string {
  return formatSummary({ status, artifactFileNames: [] });
}

describe('formatSummary example tests', () => {
  it('returns the summary unchanged at exactly the limit', () => {
    const status = 'a'.repeat(FEISHU_SUMMARY_LIMIT - STATUS_PREFIX_LENGTH);
    const summary = summaryWithStatus(status);
    expect([...summary].length).toBe(FEISHU_SUMMARY_LIMIT);
    expect(summary).toBe(`状态：${status}`);
    expect(summary).not.toContain(FEISHU_SUMMARY_NOTE);
  });

  it('truncates one code point over the limit and counts the note toward it', () => {
    const status = 'a'.repeat(FEISHU_SUMMARY_LIMIT - STATUS_PREFIX_LENGTH + 1);
    const summary = summaryWithStatus(status);
    expect([...summary].length).toBe(FEISHU_SUMMARY_LIMIT);
    expect(summary.endsWith(FEISHU_SUMMARY_NOTE)).toBe(true);
  });

  it('never splits a surrogate pair at the truncation point', () => {
    // 截断后保留 limit - 注释长度 个码点，让最后一个保留的码点正好是一个增补平面字符
    const keep = FEISHU_SUMMARY_LIMIT - NOTE_LENGTH;
    const status = `${'a'.repeat(keep - STATUS_PREFIX_LENGTH - 1)}𝄞${'b'.repeat(100)}`;
    const summary = summaryWithStatus(status);
    expect([...summary].length).toBe(FEISHU_SUMMARY_LIMIT);
    expect(summary).toContain(`𝄞${FEISHU_SUMMARY_NOTE}`);
    expect(LONE_SURROGATE.test(summary)).toBe(false);
  });
});
