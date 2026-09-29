import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../../test/pbt';
import {
  FEISHU_TEXT_MAX_CODE_POINTS,
  normalizeWhitelist,
  routeInbound,
  type FeishuInboundMessage,
} from './routing';

// Feature: mathmodel-parity-and-beyond, Property 34: 飞书消息路由
describe('Property 34: 飞书消息路由', () => {
  it('forwards exactly when p2p + text + 1..4000 code points + whitelisted sender', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('p2p', 'group'),
        fc.constantFrom('text', 'image', 'post'),
        fc.string(),
        fc.constantFrom('ou_1', 'ou_2', '', '  '),
        fc.boolean(),
        (chatType, messageType, text, senderOpenId, whitelisted) => {
          const whitelist = whitelisted ? ['ou_1', 'ou_2'] : [];
          const message: FeishuInboundMessage = { chatType, messageType, text, senderOpenId };
          const length = [...text].length;
          const expected =
            chatType === 'p2p' &&
            messageType === 'text' &&
            length >= 1 &&
            length <= FEISHU_TEXT_MAX_CODE_POINTS &&
            senderOpenId.trim() !== '' &&
            normalizeWhitelist(whitelist).includes(senderOpenId.trim());

          expect(routeInbound(message, whitelist)).toBe(expected ? 'forward' : 'ignore');
        }
      ),
      pbtParams
    );
  });

  it('counts code points, not UTF-16 units, toward the 4000 limit', () => {
    // 4000 astral characters = 8000 UTF-16 units but 4000 code points.
    const astral = '𝄞'.repeat(FEISHU_TEXT_MAX_CODE_POINTS);
    const base: FeishuInboundMessage = {
      chatType: 'p2p',
      messageType: 'text',
      text: astral,
      senderOpenId: 'ou_1',
    };
    expect(routeInbound(base, ['ou_1'])).toBe('forward');

    const over = { ...base, text: `${astral}𝄞` };
    expect(routeInbound(over, ['ou_1'])).toBe('ignore');
  });

  it('ignores empty and blank-only whitelists', () => {
    const message: FeishuInboundMessage = {
      chatType: 'p2p',
      messageType: 'text',
      text: 'hi',
      senderOpenId: 'ou_1',
    };
    expect(routeInbound(message, [])).toBe('ignore');
    expect(routeInbound(message, ['  ', '\t'])).toBe('ignore');
  });

  it('normalizes whitelist entries by trimming and deduplicating', () => {
    expect(normalizeWhitelist([' ou_1 ', 'ou_1', '', '  '])).toEqual(['ou_1']);
  });
});
