import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../test/pbt';
import { MASK_PREFIX, maskSecret, redactText } from './secretMask';

interface MaskVectors {
  mask: { input: string; masked: string }[];
  redact: { text: string; secrets: string[]; expected: string }[];
}

const vectorsFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/secret-mask-vectors.json'
);
const vectors = JSON.parse(fs.readFileSync(vectorsFile, 'utf8')) as MaskVectors;

/** Secrets never consist of mask characters, otherwise a mask could equal its own input. */
const secretChars = fc.constantFrom(...Array.from('abcXYZ019-_中文键🔑é'));
const secretArb = fc.array(secretChars, { minLength: 0, maxLength: 20 }).map((chars) => chars.join(''));

describe('shared masking vectors', () => {
  it.each(vectors.mask)('masks %j', ({ input, masked }) => {
    expect(maskSecret(input)).toBe(masked);
  });

  it.each(vectors.redact)('redacts %j', ({ text, secrets, expected }) => {
    expect(redactText(text, secrets)).toBe(expected);
  });
});

// Feature: mathmodel-parity-and-beyond, Property 7: 敏感值掩码
describe('Property 7: 敏感值掩码', () => {
  it('keeps at most the last four code points, and only for values longer than eight', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 40 }), (value) => {
        const points = Array.from(value);
        const masked = maskSecret(value);
        if (points.length <= 8) {
          expect(masked).toBe(MASK_PREFIX);
        } else {
          expect(masked).toBe(MASK_PREFIX + points.slice(-4).join(''));
        }
      }),
      pbtParams
    );
  });

  it('never leaves a known secret longer than four code points in the text', () => {
    const scenario = fc
      .record({
        secrets: fc.array(secretArb, { maxLength: 6 }),
        filler: fc.array(fc.string({ maxLength: 6 }), { maxLength: 8 }),
      })
      .chain(({ secrets, filler }) =>
        fc
          .shuffledSubarray([...secrets, ...filler, ...secrets])
          .map((parts) => ({ secrets, text: parts.join('') }))
      );

    fc.assert(
      fc.property(scenario, ({ secrets, text }) => {
        const redacted = redactText(text, secrets);
        for (const secret of secrets) {
          if (Array.from(secret).length > 4) {
            expect(redacted.includes(secret)).toBe(false);
          }
        }
      }),
      pbtParams
    );
  });
});
