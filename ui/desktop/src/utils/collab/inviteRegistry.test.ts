import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../../test/pbt';
import {
  createInviteRegistry,
  FAILURE_THRESHOLD,
  INVITE_CODE_ALPHABET,
  INVITE_TTL_MS,
  LOCK_MS,
  MAX_GUESTS,
  type RedeemResult,
} from './inviteRegistry';

function seededRandom(seed: number): (max: number) => number {
  let state = seed >>> 0;
  return (max) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state % max;
  };
}

function randomCode(randomInt: (max: number) => number): string {
  return Array.from({ length: 6 }, () => INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)]).join(
    ''
  );
}

// Feature: mathmodel-parity-and-beyond, Property 31: 邀请码生命周期
describe('Property 31: 邀请码生命周期', () => {
  it('issues unique 6-character [A-Z0-9] codes', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), fc.nat(200), (seed, count) => {
        const registry = createInviteRegistry({ randomInt: seededRandom(seed) });
        const seen = new Set<string>();
        for (let i = 0; i < count; i += 1) {
          const code = registry.issue(i);
          expect(code).toMatch(/^[A-Z0-9]{6}$/);
          seen.add(code);
        }
        expect(seen.size).toBe(count);
      }),
      pbtParams
    );
  });

  it('a code redeems once within its window and then expires', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: INVITE_TTL_MS }),
        (issuedAt, withinWindow) => {
          const registry = createInviteRegistry({ randomInt: seededRandom(issuedAt) });
          const code = registry.issue(issuedAt);
          const first = registry.redeem(code, issuedAt + withinWindow);
          expect(first).toBe('ok');
          const second = registry.redeem(code, issuedAt + withinWindow);
          expect(second).toBe('used');
          const late = registry.redeem(registry.issue(issuedAt), issuedAt + INVITE_TTL_MS + 1);
          expect(late).toBe('expired');
        }
      ),
      pbtParams
    );
  });

  it('a random redeem sequence never yields ok twice for one code and locks after 5 failures', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        fc.nat(40),
        (seed, attempts) => {
          const randomInt = seededRandom(seed);
          const registry = createInviteRegistry({ randomInt });
          const code = registry.issue(0);
          const okCount: RedeemResult[] = [];

          // Exhaust the failure budget on a fixed unknown code, then observe the lock.
          const unknown = randomCode(randomInt);
          let t = 1;
          for (let i = 0; i < FAILURE_THRESHOLD; i += 1) {
            expect(registry.redeem(unknown, t)).toBe('invalid');
            t += 1;
          }
          expect(registry.redeem(code, t)).toBe('locked');

          for (let i = 0; i < attempts; i += 1) {
            t += 1;
            okCount.push(registry.redeem(code, t));
          }
          // While locked, nothing but `locked` is returned.
          expect(okCount.every((result) => result === 'locked')).toBe(true);

          // After the lock expires the valid code redeems again.
          expect(registry.redeem(code, t + LOCK_MS + 1)).toBe('ok');
          expect(registry.redeem(code, t + LOCK_MS + 1)).toBe('used');
        }
      ),
      pbtParams
    );
  });

  it('returns full once the session is at capacity', () => {
    const registry = createInviteRegistry({ randomInt: seededRandom(1) });
    const code = registry.issue(0);
    registry.setGuestCount(MAX_GUESTS);
    expect(registry.redeem(code, 1)).toBe('full');
    registry.setGuestCount(MAX_GUESTS - 1);
    expect(registry.redeem(code, 1)).toBe('ok');
  });

  it('normalizes case and surrounding whitespace', () => {
    const registry = createInviteRegistry({ randomInt: seededRandom(2) });
    const code = registry.issue(0);
    expect(registry.redeem(`  ${code.toLowerCase()}  `, 1)).toBe('ok');
  });

  it('revokeAll invalidates outstanding codes', () => {
    const registry = createInviteRegistry({ randomInt: seededRandom(3) });
    const code = registry.issue(0);
    registry.revokeAll();
    expect(registry.redeem(code, 1)).toBe('invalid');
  });
});
