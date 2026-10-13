import { describe, expect, it } from 'vitest';
import { dayKey, dayKeyFromDate, streaks } from './ProfileSection';

describe('ProfileSection streak and date helpers', () => {
  it('formats local calendar dates and rejects invalid timestamps', () => {
    const sample = new Date(2026, 2, 8, 15, 30, 0);
    expect(dayKeyFromDate(sample)).toBe('2026-03-08');
    expect(dayKey(undefined)).toBeNull();
    expect(dayKey('not-a-date')).toBeNull();
  });

  it('returns zero streaks when there are no active days', () => {
    expect(streaks(new Map())).toEqual({ current: 0, longest: 0 });
    expect(streaks(new Map([['2026-03-01', 0]]))).toEqual({ current: 0, longest: 0 });
  });

  it('counts current streak from yesterday when today has no activity yet', () => {
    const now = new Date(2026, 4, 10, 9, 0, 0); // 2026-05-10
    const active = new Map<string, number>([
      ['2026-05-07', 2],
      ['2026-05-08', 1],
      ['2026-05-09', 3],
    ]);

    expect(streaks(active, now)).toEqual({ current: 3, longest: 3 });
  });

  it('resets current streak when both today and yesterday are inactive, while preserving longest', () => {
    const now = new Date(2026, 4, 15, 12, 0, 0); // 2026-05-15
    const active = new Map<string, number>([
      ['2026-05-01', 1],
      ['2026-05-02', 1],
      ['2026-05-03', 1],
      ['2026-05-04', 1],
      ['2026-05-10', 2],
    ]);

    expect(streaks(active, now)).toEqual({ current: 0, longest: 4 });
  });

  it('keeps streaks intact across 23-hour and 25-hour DST transition days', () => {
    const RealDate = globalThis.Date;
    const baseMs = new RealDate('2026-03-07T00:00:00Z').getTime();
    // Simulate a spring-forward 23h gap followed by a fall-back 25h gap
    const fakeTimestamps: Record<string, number> = {
      '2026-03-07T00:00:00': baseMs,
      '2026-03-08T00:00:00': baseMs + 23 * 3_600_000,
      '2026-03-09T00:00:00': baseMs + (23 + 25) * 3_600_000,
    };

    const OriginalDate = globalThis.Date;
    class PatchedDate extends OriginalDate {
      constructor(value?: string | number | Date) {
        if (typeof value === 'string' && value in fakeTimestamps) {
          super(fakeTimestamps[value]);
        } else if (value !== undefined) {
          super(value as string | number);
        } else {
          super();
        }
      }
    }
    globalThis.Date = PatchedDate as DateConstructor;

    try {
      const now = new OriginalDate(2026, 2, 9, 12, 0, 0);
      const active = new Map<string, number>([
        ['2026-03-07', 1],
        ['2026-03-08', 2],
        ['2026-03-09', 1],
      ]);
      expect(streaks(active, now)).toEqual({ current: 3, longest: 3 });
    } finally {
      globalThis.Date = OriginalDate;
    }
  });
});
