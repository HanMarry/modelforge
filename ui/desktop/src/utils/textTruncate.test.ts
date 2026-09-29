import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../test/pbt';
import { truncateText } from './textTruncate';

function codePoints(value: string): string[] {
  return Array.from(value);
}

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const atom = fc.constantFrom('a', 'b', '中', '文', 'é', '😀', '🚀', '🔑', '🙂', '\u200d');
const textArb = fc.array(atom, { maxLength: 40 }).map((chars) => chars.join(''));
const ellipsisArb = fc.constantFrom('', '…', '……');

describe('truncateText deterministic limits', () => {
  it.each([
    [100_000, 'x'.repeat(100_001)],
    [200, 'x'.repeat(201)],
    [300, 'x'.repeat(301)],
    [2000, 'x'.repeat(2001)],
  ])('truncates a %i-code-point input to %i code points', (limit, over) => {
    const result = truncateText(over, limit);
    expect(result.truncated).toBe(true);
    expect(codePoints(result.text).length).toBe(limit);
  });

  it('counts the ellipsis toward the title limit', () => {
    const result = truncateText('x'.repeat(250), 200, { ellipsis: '…' });
    expect(result.truncated).toBe(true);
    expect(codePoints(result.text).length).toBe(200);
    expect(result.text.endsWith('…')).toBe(true);
  });

  it('never splits a surrogate pair at the 200-code-point boundary', () => {
    const result = truncateText('😀'.repeat(300), 200, { ellipsis: '…' });
    expect(hasLoneSurrogate(result.text)).toBe(false);
  });
});

// Feature: mathmodel-parity-and-beyond, Property 28: 文本截断规则
describe('Property 28: 文本截断规则', () => {
  it('keeps the result within the limit, prefixes the source, and never splits a pair', () => {
    fc.assert(
      fc.property(textArb, fc.nat(50), ellipsisArb, (text, limit, ellipsis) => {
        const options = ellipsis ? { ellipsis } : {};
        const result = truncateText(text, limit, options);
        const points = codePoints(text);
        const resultPoints = codePoints(result.text);

        expect(resultPoints.length).toBeLessThanOrEqual(limit);
        expect(hasLoneSurrogate(result.text)).toBe(false);
        expect(result.truncated).toBe(points.length > limit);

        if (!result.truncated) {
          expect(result.text).toBe(text);
        } else if (!ellipsis) {
          expect(result.text).toBe(points.slice(0, limit).join(''));
        } else {
          const keep = limit - codePoints(ellipsis).length;
          const expected =
            keep > 0 ? points.slice(0, keep).join('') + ellipsis : points.slice(0, limit).join('');
          expect(result.text).toBe(expected);
        }
      }),
      pbtParams
    );
  });
});
