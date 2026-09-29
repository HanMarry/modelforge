import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../../test/pbt';
import { resolveUniqueDirName } from './resolveUniqueDirName';

// Feature: mathmodel-parity-and-beyond, Property 21: 目录名后缀规则
describe('Property 21: 目录名后缀规则', () => {
  it('returns a name not already taken, using name, name-2, name-3…', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.array(fc.string({ maxLength: 20 }), { maxLength: 30 }),
        (desired, existing) => {
          const set = new Set(existing);
          const result = resolveUniqueDirName(desired, set);

          // Case-insensitive: the result is never already taken.
          expect([...set].some((n) => n.toLowerCase() === result.toLowerCase())).toBe(false);

          if (![...set].some((n) => n.toLowerCase() === desired.toLowerCase())) {
            expect(result).toBe(desired);
          } else {
            // result is desired-k for the smallest k >= 2 not taken.
            const match = /^(.*)-(\d+)$/.exec(result);
            expect(match).not.toBeNull();
            expect(match?.[1]).toBe(desired);
            const k = Number(match?.[2]);
            expect(k).toBeGreaterThanOrEqual(2);
            for (let i = 2; i < k; i += 1) {
              expect([...set].some((n) => n.toLowerCase() === `${desired.toLowerCase()}-${i}`)).toBe(
                true
              );
            }
          }
        }
      ),
      pbtParams
    );
  });

  it('compares case-insensitively', () => {
    expect(resolveUniqueDirName('Report', new Set(['report']))).toBe('Report-2');
    expect(resolveUniqueDirName('Report', new Set(['report', 'report-2']))).toBe('Report-3');
  });
});
