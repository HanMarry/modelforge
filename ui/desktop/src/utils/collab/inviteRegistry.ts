/**
 * Invite-code lifecycle for a LAN collab session (requirement 14.1, 14.6).
 *
 * - `issue(now)` mints a 6-character `[A-Z0-9]` code with a cryptographically secure random
 *   source (injectable; defaults to `crypto.randomInt`) and a 30-minute validity window.
 * - A code can be redeemed successfully only once.
 * - `redeem(code, now)` is a pure state transition: five consecutive failures (invalid,
 *   expired, used or full) lock the registry for 60 seconds, during which every redeem
 *   returns `locked`.
 */
import { randomInt } from 'node:crypto';

export const INVITE_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const INVITE_CODE_LENGTH = 6;
export const INVITE_TTL_MS = 30 * 60 * 1000;
export const MAX_GUESTS = 2;
export const FAILURE_THRESHOLD = 5;
export const LOCK_MS = 60 * 1000;

export type RedeemResult = 'ok' | 'invalid' | 'expired' | 'used' | 'full' | 'locked';

export interface InviteRegistryOptions {
  /** Returns a uniform integer in `[0, maxExclusive)`. Defaults to `crypto.randomInt`. */
  randomInt?: (maxExclusive: number) => number;
  ttlMs?: number;
  maxGuests?: number;
  failureThreshold?: number;
  lockMs?: number;
}

interface IssuedCode {
  expiresAt: number;
  used: boolean;
}

export interface InviteRegistry {
  issue: (now: number) => string;
  redeem: (code: string, now: number) => RedeemResult;
  /** Number of guests currently seated in the session; drives the `full` result. */
  setGuestCount: (count: number) => void;
  guestCount: () => number;
  /** Invalidates one code (e.g. after the host rejects that guest). */
  revoke: (code: string) => void;
  /** Invalidates every outstanding code (end of session, requirement 14.4). */
  revokeAll: () => void;
  activeCodes: () => readonly string[];
}

export function createInviteRegistry(options: InviteRegistryOptions = {}): InviteRegistry {
  const nextInt = options.randomInt ?? ((max) => randomInt(max));
  const ttlMs = options.ttlMs ?? INVITE_TTL_MS;
  const maxGuests = options.maxGuests ?? MAX_GUESTS;
  const failureThreshold = options.failureThreshold ?? FAILURE_THRESHOLD;
  const lockMs = options.lockMs ?? LOCK_MS;

  const issued = new Map<string, IssuedCode>();
  let guests = 0;
  let consecutiveFailures = 0;
  let lockedUntil = 0;

  const recordFailure = (now: number): void => {
    consecutiveFailures += 1;
    if (consecutiveFailures >= failureThreshold) {
      lockedUntil = now + lockMs;
      consecutiveFailures = 0;
    }
  };

  const issue = (now: number): string => {
    let code = '';
    do {
      code = Array.from({ length: INVITE_CODE_LENGTH }, () =>
        INVITE_CODE_ALPHABET[nextInt(INVITE_CODE_ALPHABET.length)]
      ).join('');
    } while (issued.has(code));
    issued.set(code, { expiresAt: now + ttlMs, used: false });
    return code;
  };

  const redeem = (code: string, now: number): RedeemResult => {
    if (now < lockedUntil) {
      return 'locked';
    }
    const normalized = code.trim().toUpperCase();
    if (guests >= maxGuests) {
      recordFailure(now);
      return 'full';
    }
    const entry = issued.get(normalized);
    if (!entry) {
      recordFailure(now);
      return 'invalid';
    }
    if (entry.used) {
      recordFailure(now);
      return 'used';
    }
    if (now > entry.expiresAt) {
      recordFailure(now);
      return 'expired';
    }
    entry.used = true;
    consecutiveFailures = 0;
    return 'ok';
  };

  return {
    issue,
    redeem,
    setGuestCount: (count) => {
      guests = Math.max(0, Math.floor(count));
    },
    guestCount: () => guests,
    revoke: (code) => {
      issued.delete(code.trim().toUpperCase());
    },
    revokeAll: () => {
      issued.clear();
    },
    activeCodes: () => [...issued.keys()].filter((code) => !issued.get(code)?.used),
  };
}
