/**
 * Mock review results (requirement 19): validation of the object the `mathmodel-mock-review`
 * skill returns, and the per-dimension comparison with the previous completed review of the
 * same paper.
 *
 * A result that fails {@link validateReview} is an incomplete review (design error
 * `REVIEW_INCOMPLETE`): it must not be saved, and the paper's earlier records stay as they
 * are (requirement 19.6). The dimension names must match the enum in the skill's output
 * schema, `crates/goose/src/skills/builtins/mathmodel_mock_review/review-output.schema.json`;
 * `reviewModel.test.ts` checks that.
 */

/** The six scoring dimensions of requirement 19.1, in display order. */
export const REVIEW_DIMENSIONS = [
  '问题分析',
  '模型假设',
  '模型建立',
  '求解与结果',
  '灵敏度分析',
  '写作表达',
] as const;

export type DimensionName = (typeof REVIEW_DIMENSIONS)[number];

export const MIN_SCORE = 0;
export const MAX_SCORE = 10;

export interface ReviewDimension {
  name: DimensionName;
  /** Integer in [MIN_SCORE, MAX_SCORE]. */
  score: number;
  /** At least one non-blank reason. */
  reasons: string[];
}

/**
 * Where a suggestion applies (requirement 19.2): the section title, plus a 1-based inclusive
 * line range for LaTeX or Markdown sources or a 1-based page for PDF.
 */
export interface ReviewLocation {
  section: string;
  lines?: [number, number];
  page?: number;
}

export interface ReviewSuggestion {
  text: string;
  location: ReviewLocation;
}

/** The structured output of the review skill. */
export interface ReviewOutput {
  dimensions: ReviewDimension[];
  suggestions: ReviewSuggestion[];
}

/** A completed review as saved under `.modelforge/reviews/` (design: ReviewRecord). */
export interface ReviewRecord extends ReviewOutput {
  /** Project-relative path of the reviewed paper. */
  paper: string;
  /** Id from `src/catalog/competitions.json`. */
  competitionId: string;
  /** ISO 8601 time the review completed. */
  completedAt: string;
}

export type ReviewProblem =
  | { kind: 'not-object' }
  | { kind: 'dimensions-not-array' }
  /** The entry is not an object, or its `name` is not a string. */
  | { kind: 'invalid-dimension-entry'; index: number }
  | { kind: 'unknown-dimension'; index: number; name: string }
  | { kind: 'duplicate-dimension'; name: DimensionName }
  | { kind: 'missing-dimension'; name: DimensionName }
  | { kind: 'invalid-score'; name: DimensionName }
  /** `reasons` is not a non-empty array of non-blank strings. */
  | { kind: 'invalid-reasons'; name: DimensionName }
  | { kind: 'suggestions-not-array' }
  | { kind: 'invalid-suggestion'; index: number };

export type ReviewValidation =
  | { valid: true; review: ReviewOutput; problems: ReviewProblem[] }
  | { valid: false; problems: ReviewProblem[] };

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isDimensionName(value: string): value is DimensionName {
  return (REVIEW_DIMENSIONS as readonly string[]).includes(value);
}

export function isValidScore(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_SCORE &&
    value <= MAX_SCORE
  );
}

function isValidReasons(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonBlankString);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** `null` is accepted as "absent": structured-output modes often emit it for optional fields. */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

/** The normalized suggestion, or null when it lacks text or a usable location. */
function parseSuggestion(value: unknown): ReviewSuggestion | null {
  if (!isObject(value) || !isNonBlankString(value.text) || !isObject(value.location)) {
    return null;
  }
  const { section, lines, page } = value.location;
  if (!isNonBlankString(section)) return null;

  const location: ReviewLocation = { section };
  if (!isAbsent(lines)) {
    if (
      !Array.isArray(lines) ||
      lines.length !== 2 ||
      !isPositiveInteger(lines[0]) ||
      !isPositiveInteger(lines[1]) ||
      lines[0] > lines[1]
    ) {
      return null;
    }
    location.lines = [lines[0], lines[1]];
  }
  if (!isAbsent(page)) {
    if (!isPositiveInteger(page)) return null;
    location.page = page;
  }
  if (location.lines === undefined && location.page === undefined) return null;
  return { text: value.text, location };
}

/**
 * Checks a review object returned by the model (requirements 19.1, 19.2, 19.6).
 *
 * Valid exactly when: it is an object; `dimensions` holds each of the six dimensions exactly
 * once and nothing else, each with an integer score in 0..10 and at least one non-blank
 * reason; and `suggestions` is an array whose every item has non-blank text and a location
 * with a section title and a line range or page. Every problem is reported. A valid result
 * carries a normalized copy: dimensions in {@link REVIEW_DIMENSIONS} order, unknown fields
 * dropped.
 */
export function validateReview(raw: unknown): ReviewValidation {
  if (!isObject(raw)) {
    return { valid: false, problems: [{ kind: 'not-object' }] };
  }

  const problems: ReviewProblem[] = [];
  const found = new Map<DimensionName, ReviewDimension>();

  if (!Array.isArray(raw.dimensions)) {
    problems.push({ kind: 'dimensions-not-array' });
  } else {
    const duplicated = new Set<DimensionName>();
    raw.dimensions.forEach((entry: unknown, index: number) => {
      if (!isObject(entry) || typeof entry.name !== 'string') {
        problems.push({ kind: 'invalid-dimension-entry', index });
        return;
      }
      const name = entry.name;
      if (!isDimensionName(name)) {
        problems.push({ kind: 'unknown-dimension', index, name });
        return;
      }
      if (found.has(name)) {
        if (!duplicated.has(name)) problems.push({ kind: 'duplicate-dimension', name });
        duplicated.add(name);
        return;
      }
      const { score, reasons } = entry;
      if (!isValidScore(score)) problems.push({ kind: 'invalid-score', name });
      if (!isValidReasons(reasons)) problems.push({ kind: 'invalid-reasons', name });
      found.set(name, {
        name,
        score: isValidScore(score) ? score : Number.NaN,
        reasons: isValidReasons(reasons) ? [...reasons] : [],
      });
    });
    for (const name of REVIEW_DIMENSIONS) {
      if (!found.has(name)) problems.push({ kind: 'missing-dimension', name });
    }
  }

  const suggestions: ReviewSuggestion[] = [];
  if (!Array.isArray(raw.suggestions)) {
    problems.push({ kind: 'suggestions-not-array' });
  } else {
    raw.suggestions.forEach((entry: unknown, index: number) => {
      const suggestion = parseSuggestion(entry);
      if (suggestion === null) {
        problems.push({ kind: 'invalid-suggestion', index });
      } else {
        suggestions.push(suggestion);
      }
    });
  }

  if (problems.length > 0) {
    return { valid: false, problems };
  }
  const dimensions = REVIEW_DIMENSIONS.map((name) => found.get(name) as ReviewDimension);
  return { valid: true, review: { dimensions, suggestions }, problems };
}

export interface DimensionDelta {
  name: DimensionName;
  previous: number;
  current: number;
  /** `current - previous` (requirement 19.3). */
  delta: number;
}

export type ReviewComparison =
  /** No earlier completed review of this paper (requirement 19.4): nothing to compare. */
  | { firstReview: true }
  | { firstReview: false; previousCompletedAt: string; deltas: DimensionDelta[] };

function timeOf(record: ReviewRecord): number {
  return Date.parse(record.completedAt);
}

/**
 * The completed review of `current.paper` in `history` that finished last before `current`,
 * or null. Records of other papers, and records with an unparsable time, are ignored; on
 * equal times the later entry in `history` wins.
 */
export function previousReview(
  current: ReviewRecord,
  history: readonly ReviewRecord[]
): ReviewRecord | null {
  const currentTime = timeOf(current);
  let previous: ReviewRecord | null = null;
  let previousTime = Number.NEGATIVE_INFINITY;
  for (const record of history) {
    if (record.paper !== current.paper) continue;
    const time = timeOf(record);
    if (Number.isNaN(time) || !(time < currentTime)) continue;
    if (time >= previousTime) {
      previous = record;
      previousTime = time;
    }
  }
  return previous;
}

/**
 * Compares `current` with the previous completed review of the same paper (requirements
 * 19.3, 19.4). `history` holds the paper's saved records and may include `current` itself.
 * Both sides are expected to have passed {@link validateReview}; a dimension missing on
 * either side is left out of `deltas`.
 */
export function compareReviews(
  current: ReviewRecord,
  history: readonly ReviewRecord[]
): ReviewComparison {
  const previous = previousReview(current, history);
  if (previous === null) {
    return { firstReview: true };
  }

  const deltas: DimensionDelta[] = [];
  for (const name of REVIEW_DIMENSIONS) {
    const now = current.dimensions.find((dimension) => dimension.name === name);
    const before = previous.dimensions.find((dimension) => dimension.name === name);
    if (now === undefined || before === undefined) continue;
    deltas.push({
      name,
      previous: before.score,
      current: now.score,
      delta: now.score - before.score,
    });
  }
  return { firstReview: false, previousCompletedAt: previous.completedAt, deltas };
}
