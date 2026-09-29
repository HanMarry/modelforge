/**
 * Pure rules for the competition hub (requirement 8).
 *
 * All date comparisons are lexicographic on `YYYY-MM-DD`, which is a total order for
 * fixed-width ISO dates, and ranges are inclusive of both ends (requirement 8.4).
 */
import competitionsData from './competitions.json';
import type {
  Competition,
  CompetitionCatalog,
  CompetitionFilter,
  CompetitionStatus,
  LocalDate,
} from '../types/catalog';

export type { Competition, CompetitionCatalog, CompetitionFilter, CompetitionStatus, LocalDate };

/** The shipped catalogue. Dates are exactly as published; unknown dates are `null`. */
export const COMPETITION_CATALOG: CompetitionCatalog =
  competitionsData as unknown as CompetitionCatalog;

export const ALL_STATUSES: CompetitionStatus[] = [
  '未开始',
  '报名中',
  '进行中',
  '已结束',
];

/** How "today" relates to a date range with an inclusive end. */
function withinRange(today: LocalDate, start: LocalDate, end: LocalDate): boolean {
  return today >= start && today <= end;
}

/**
 * Current status of a competition (requirement 8.4). A competition whose contest dates are
 * not yet announced falls through to "未开始" (confirmed design assumption).
 */
export function statusOf(competition: Competition, today: LocalDate): CompetitionStatus {
  const { start: contestStart, end: contestEnd } = competition.contest;
  if (contestStart !== null && contestEnd !== null) {
    if (withinRange(today, contestStart, contestEnd)) {
      return '进行中';
    }
    if (today > contestEnd) {
      return '已结束';
    }
  }

  const { start: regStart, end: regEnd } = competition.registration;
  if (regStart !== null && regEnd !== null && withinRange(today, regStart, regEnd)) {
    return '报名中';
  }
  return '未开始';
}

/** Group rank used by {@link sortCompetitions}; lower sorts earlier. */
function groupRank(competition: Competition, today: LocalDate): number {
  switch (statusOf(competition, today)) {
    case '进行中':
      return 0;
    case '未开始':
      // A competition with no contest dates is "待公布" and sits after "未开始".
      return competition.contest.start === null ? 2 : 1;
    case '已结束':
      return 3;
    default:
      // "报名中" competitions are not yet running: sort with the not-started group by
      // their contest start (registration always precedes the contest).
      return competition.contest.start === null ? 2 : 1;
  }
}

function compareKey(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/**
 * Stable sort (requirement 8.4): running first by contest end, then not-started by contest
 * start, then "待公布", then ended; equal keys are ordered by id for determinism.
 */
export function sortCompetitions(list: Competition[], today: LocalDate): Competition[] {
  return [...list].sort((a, b) => {
    const rankDiff = groupRank(a, today) - groupRank(b, today);
    if (rankDiff !== 0) return rankDiff;

    const rank = groupRank(a, today);
    if (rank === 0) return compareKey(a.contest.end, b.contest.end) || compareKey(a.id, b.id);
    if (rank === 1) {
      return compareKey(a.contest.start, b.contest.start) || compareKey(a.id, b.id);
    }
    return compareKey(a.id, b.id);
  });
}

/**
 * Filters by optional status set and by a 0..50 char, case-insensitive substring keyword
 * (requirement 8.6, 8.7). The result keeps the input order so it composes with sorting.
 */
export function filterCompetitions(
  list: Competition[],
  filter: CompetitionFilter,
  today: LocalDate
): Competition[] {
  const statuses = new Set(filter.statuses);
  const keyword = filter.keyword.trim().toLowerCase();

  return list.filter((competition) => {
    if (statuses.size > 0 && !statuses.has(statusOf(competition, today))) {
      return false;
    }
    if (keyword && !competition.name.toLowerCase().includes(keyword)) {
      return false;
    }
    return true;
  });
}

/** `YYYY-MM-DD`, or "待公布" when the date is not yet announced (requirement 8.1). */
export function formatDate(date: LocalDate | null): string {
  return date ?? '待公布';
}
