import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../test/pbt';
import type { Competition, CompetitionDateRange, CompetitionStatus, LocalDate } from '../types/catalog';
import {
  ALL_STATUSES,
  COMPETITION_CATALOG,
  filterCompetitions,
  formatDate,
  sortCompetitions,
  statusOf,
} from './competitionRules';

const localDateArb: fc.Arbitrary<LocalDate> = fc
  .date({ min: new Date(Date.UTC(2000, 0, 1)), max: new Date(Date.UTC(2099, 11, 31)) })
  .map((date) => date.toISOString().slice(0, 10) as LocalDate);

const dateRangeArb: fc.Arbitrary<CompetitionDateRange> = fc
  .tuple(localDateArb, localDateArb)
  .map(([a, b]) => (a <= b ? { start: a, end: b } : { start: b, end: a }))
  .chain((range) =>
    fc.boolean().map((hasDates) => (hasDates ? range : { start: null, end: null }))
  );

const competitionArb: fc.Arbitrary<Competition> = fc
  .record({
    id: fc.uuid(),
    name: fc.string({ minLength: 1, maxLength: 24 }),
    organizer: fc.string({ maxLength: 16 }),
    website: fc.oneof(fc.constant(null), fc.constant('https://example.com/')),
    registration: dateRangeArb,
    contest: dateRangeArb,
    templateIds: fc.array(fc.string(), { maxLength: 3 }),
    exampleIds: fc.array(fc.string(), { maxLength: 3 }),
  });

const todayArb: fc.Arbitrary<LocalDate> = localDateArb;

const statusesArb: fc.Arbitrary<CompetitionStatus[]> = fc
  .subarray(ALL_STATUSES, { minLength: 0 })
  .map((subset) => subset as CompetitionStatus[]);

function idOrder(list: Competition[]): string[] {
  return list.map((c) => c.id);
}

describe('formatDate', () => {
  it('renders null as 待公布', () => {
    expect(formatDate(null)).toBe('待公布');
  });

  it('renders a date verbatim', () => {
    expect(formatDate('2026-09-04')).toBe('2026-09-04');
  });
});

describe('statusOf', () => {
  it('classifies running, registering, ended, and pending competitions', () => {
    const base: Competition = {
      id: 'c',
      name: 'c',
      organizer: 'o',
      website: null,
      registration: { start: null, end: null },
      contest: { start: '2026-05-01', end: '2026-05-03' },
      templateIds: [],
      exampleIds: [],
    };
    expect(statusOf(base, '2026-05-01')).toBe('进行中');
    expect(statusOf(base, '2026-05-02')).toBe('进行中');
    expect(statusOf(base, '2026-05-03')).toBe('进行中');
    expect(statusOf(base, '2026-05-04')).toBe('已结束');
    expect(statusOf(base, '2026-04-30')).toBe('未开始');
  });

  it('reports 报名中 inside the registration window', () => {
    const c: Competition = {
      id: 'c',
      name: 'c',
      organizer: 'o',
      website: null,
      registration: { start: '2026-04-01', end: '2026-04-30' },
      contest: { start: '2026-05-01', end: '2026-05-03' },
      templateIds: [],
      exampleIds: [],
    };
    expect(statusOf(c, '2026-04-15')).toBe('报名中');
  });

  it('treats unannounced contest dates as 未开始', () => {
    const c: Competition = {
      id: 'c',
      name: 'c',
      organizer: 'o',
      website: null,
      registration: { start: null, end: null },
      contest: { start: null, end: null },
      templateIds: [],
      exampleIds: [],
    };
    expect(statusOf(c, '2026-06-01')).toBe('未开始');
  });
});

// Feature: mathmodel-parity-and-beyond, Property 16: 赛事排序
describe('Property 16: 赛事排序', () => {
  it('is a permutation grouped by status, ordered by date then id', () => {
    fc.assert(
      fc.property(fc.array(competitionArb, { maxLength: 40 }), todayArb, (list, today) => {
        const sorted = sortCompetitions(list, today);

        // Same set of competitions (a permutation).
        expect(idOrder(sorted).slice().sort()).toEqual(idOrder(list).slice().sort());
        expect(sorted).toHaveLength(list.length);

        // Group order: 进行中, then 未开始 (with a contest date), then 待公布, then 已结束.
        let lastGroup = 0;
        for (const competition of sorted) {
          const status = statusOf(competition, today);
          const group =
            status === '进行中' ? 0 : status === '已结束' ? 3 : competition.contest.start === null ? 2 : 1;
          expect(group).toBeGreaterThanOrEqual(lastGroup);
          lastGroup = group;
        }

        // Within 进行中: non-decreasing contest end.
        const runningEnds = sorted
          .filter((c) => statusOf(c, today) === '进行中')
          .map((c) => c.contest.end as string);
        for (let i = 1; i < runningEnds.length; i += 1) {
          expect(runningEnds[i - 1] <= runningEnds[i]).toBe(true);
        }

        // Within 未开始: non-decreasing contest start.
        const pendingStarts = sorted
          .filter(
            (c) => statusOf(c, today) === '未开始' && c.contest.start !== null
          )
          .map((c) => c.contest.start as string);
        for (let i = 1; i < pendingStarts.length; i += 1) {
          expect(pendingStarts[i - 1] <= pendingStarts[i]).toBe(true);
        }
      }),
      pbtParams
    );
  });
});

// Feature: mathmodel-parity-and-beyond, Property 17: 赛事筛选
describe('Property 17: 赛事筛选', () => {
  it('matches the predicate and commutes with sorting', () => {
    const scenario = fc
      .record({
        list: fc.array(competitionArb, { maxLength: 40 }),
        statuses: statusesArb,
        keyword: fc.oneof(
          fc.constant(''),
          fc.string({ maxLength: 50 }),
          fc.array(competitionArb, { minLength: 1, maxLength: 1 }).map(([c]) => c.name)
        ),
        today: todayArb,
      })
      .filter(({ keyword }) => keyword.length <= 50);

    fc.assert(
      fc.property(scenario, ({ list, statuses, keyword, today }) => {
        const statusSet = new Set(statuses);
        const needle = keyword.trim().toLowerCase();
        const predicate = (c: Competition): boolean =>
          (statusSet.size === 0 || statusSet.has(statusOf(c, today))) &&
          (needle === '' || c.name.toLowerCase().includes(needle));

        const filtered = filterCompetitions(list, { statuses, keyword }, today);
        expect(idOrder(filtered)).toEqual(idOrder(list.filter(predicate)));

        // filter ∘ sort === sort ∘ filter (filter preserves order).
        const a = sortCompetitions(filterCompetitions(list, { statuses, keyword }, today), today);
        const b = filterCompetitions(sortCompetitions(list, today), { statuses, keyword }, today);
        expect(idOrder(a)).toEqual(idOrder(b));
      }),
      pbtParams
    );
  });
});

describe('COMPETITION_CATALOG', () => {
  it('ships at least the eight required competitions', () => {
    const required = [
      '全国大学生数学建模竞赛',
      '美国大学生数学建模竞赛',
      '华数杯',
      '电工杯',
      'MathorCup',
      '深圳杯',
      'APMCM',
      '统计建模大赛',
    ];
    for (const name of required) {
      expect(COMPETITION_CATALOG.competitions.some((c) => c.name.includes(name))).toBe(true);
    }
    expect(COMPETITION_CATALOG.competitions.length).toBeGreaterThanOrEqual(8);
  });
});
