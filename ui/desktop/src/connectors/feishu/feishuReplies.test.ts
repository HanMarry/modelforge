import { describe, expect, it } from 'vitest';
import {
  FEISHU_APPROVAL_ALPHABET,
  FEISHU_APPROVAL_TEXT_LIMIT,
  buildApprovalMessage,
  feishuSessionTitle,
  formatElapsed,
  generateApprovalCode,
  parseApprovalReply,
} from './feishuReplies';

describe('parseApprovalReply', () => {
  it('reads 批准 and 拒绝 with any spacing and letter case', () => {
    expect(parseApprovalReply('批准 ABC234')).toEqual({ action: 'approve', code: 'ABC234' });
    expect(parseApprovalReply('  拒绝\u3000abc234 ')).toEqual({ action: 'reject', code: 'ABC234' });
    expect(parseApprovalReply('批准ABC234')).toEqual({ action: 'approve', code: 'ABC234' });
  });

  it('does not read anything else as an approval', () => {
    expect(parseApprovalReply('批准')).toBeNull();
    expect(parseApprovalReply('批准 ABC23')).toBeNull();
    expect(parseApprovalReply('我批准 ABC234')).toBeNull();
    expect(parseApprovalReply('批准 ABC234 并继续')).toBeNull();
    expect(parseApprovalReply('同意 ABC234')).toBeNull();
  });
});

describe('buildApprovalMessage', () => {
  it('names the tool, caps the argument summary at 500 code points and shows the code', () => {
    const message = buildApprovalMessage('developer__shell', '𝄞'.repeat(800), 'ABC234');
    const [title, args, help] = message.split('\n');

    expect(title).toBe('工具调用需要审批：developer__shell');
    expect([...args.slice('参数：'.length)]).toHaveLength(FEISHU_APPROVAL_TEXT_LIMIT);
    expect(help).toContain('批准 ABC234');
    expect(help).toContain('拒绝 ABC234');
    expect(help).toContain('10 分钟');
  });

  it('keeps short arguments as they are', () => {
    expect(buildApprovalMessage('read', '{"path":"a.csv"}', 'XYZ789').split('\n')[1]).toBe(
      '参数：{"path":"a.csv"}'
    );
  });
});

describe('generateApprovalCode', () => {
  it('draws 6 characters from the unambiguous alphabet', () => {
    let next = 0;
    const code = generateApprovalCode((max) => {
      next += 7;
      return next % max;
    });
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    expect([...code].every((char) => FEISHU_APPROVAL_ALPHABET.includes(char))).toBe(true);
    expect(generateApprovalCode()).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });
});

describe('formatElapsed and feishuSessionTitle', () => {
  it('formats running time', () => {
    expect(formatElapsed(42_000)).toBe('42 秒');
    expect(formatElapsed(6 * 60_000 + 5_000)).toBe('6 分 5 秒');
    expect(formatElapsed(2 * 3_600_000 + 3 * 60_000)).toBe('2 小时 3 分');
  });

  it('names a session after the start of the first message', () => {
    expect(feishuSessionTitle('分析\n  2024 年数据')).toBe('飞书：分析 2024 年数据');
    expect(feishuSessionTitle('很长'.repeat(30))).toBe(`飞书：${'很长'.repeat(11)}很…`);
    expect(feishuSessionTitle('   ')).toBe('飞书：新任务');
  });
});
