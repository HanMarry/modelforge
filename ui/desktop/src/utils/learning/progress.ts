/**
 * Learning path progress (requirements 20.2, 20.4, 20.5): turning the verdicts of an
 * exercise's check items into its record, and per-group completion for the profile page.
 *
 * The catalogue is `src/catalog/learning-path.json`; `scripts/check-skills.js` guarantees
 * that every exercise has at least one check item and that exercise ids are unique. A check
 * run that failed or timed out (requirement 20.6) produces no verdicts and must not reach
 * {@link applyCheckResults}: the exercise keeps its previous state.
 */

export type ExerciseStatus = '未开始' | '未通过' | '已完成';

/** One exercise's progress (design: ExerciseRecord), as kept in `learning-progress.json`. */
export interface ExerciseRecord {
  exerciseId: string;
  status: ExerciseStatus;
  /** Time of the submission that passed every check; only set while `已完成`. */
  completedAt?: string;
  /** The user opened the full solution (requirement 20.7). */
  solutionViewed: boolean;
  /** What the user submitted last, kept so it can be revised and resubmitted. */
  lastSubmission?: string;
}

/** The verdict on one check item of an exercise. */
export interface CheckResult {
  checkId: string;
  passed: boolean;
  /** Why the item failed (or a note when it passed). */
  reason: string;
}

export interface CheckFailure {
  checkId: string;
  reason: string;
}

/** The part of a catalogue exercise that decides completion. */
export interface ExerciseChecks {
  id: string;
  checks: readonly { id: string }[];
}

export interface CheckOutcome {
  record: ExerciseRecord;
  /** Every check item that did not pass, in catalogue order (requirement 20.5). */
  failures: CheckFailure[];
}

/** Reason recorded for a check item that received no verdict. */
export const NO_VERDICT_REASON = '检查项没有返回结论';
/** Reason recorded for a failed check item whose checker gave no explanation. */
export const UNEXPLAINED_FAILURE_REASON = '未通过（检查器没有给出原因）';

/**
 * Applies the verdicts of one submission (requirements 20.2, 20.5).
 *
 * A check item passes when it has at least one verdict and all of its verdicts pass; a
 * verdict for an id the exercise does not have is ignored. The exercise becomes `已完成`,
 * with `completedAt = checkedAt`, exactly when it has check items and every one passes;
 * otherwise it becomes `未通过` and `failures` lists each item that did not pass. The
 * submission is kept either way, and `solutionViewed` carries over from `previous`.
 */
export function applyCheckResults(
  previous: ExerciseRecord | undefined,
  exercise: ExerciseChecks,
  results: readonly CheckResult[],
  checkedAt: string,
  submission: string
): CheckOutcome {
  const failures: CheckFailure[] = [];
  for (const check of exercise.checks) {
    const verdicts = results.filter((result) => result.checkId === check.id);
    const failed = verdicts.find((result) => !result.passed);
    if (verdicts.length === 0) {
      failures.push({ checkId: check.id, reason: NO_VERDICT_REASON });
    } else if (failed !== undefined) {
      const reason = failed.reason.trim() === '' ? UNEXPLAINED_FAILURE_REASON : failed.reason;
      failures.push({ checkId: check.id, reason });
    }
  }

  const completed = exercise.checks.length > 0 && failures.length === 0;
  const solutionViewed =
    previous !== undefined && previous.exerciseId === exercise.id ? previous.solutionViewed : false;
  const record: ExerciseRecord = {
    exerciseId: exercise.id,
    status: completed ? '已完成' : '未通过',
    solutionViewed,
    lastSubmission: submission,
  };
  if (completed) {
    record.completedAt = checkedAt;
  }
  return { record, failures };
}

/** The shape of the catalogue that progress counting needs. */
export interface ProgressCatalog {
  groups: readonly {
    id: string;
    title: string;
    courses: readonly { exercises: readonly { id: string }[] }[];
  }[];
}

export interface GroupProgress {
  groupId: string;
  title: string;
  /** Exercises of the group recorded as `已完成`. */
  completed: number;
  /** Exercises in the group. */
  total: number;
  /** `round(100 × completed / total)`, halves rounded up; 0 for a group without exercises. */
  percent: number;
}

/**
 * Completion per course group, in catalogue order (requirement 20.4). When `records` holds
 * several entries for one exercise the last one counts; records of exercises that are not in
 * the catalogue are ignored.
 */
export function progressByGroup(
  records: readonly ExerciseRecord[],
  catalog: ProgressCatalog
): GroupProgress[] {
  const status = new Map<string, ExerciseStatus>();
  for (const record of records) {
    status.set(record.exerciseId, record.status);
  }

  return catalog.groups.map((group) => {
    let total = 0;
    let completed = 0;
    for (const course of group.courses) {
      for (const exercise of course.exercises) {
        total += 1;
        if (status.get(exercise.id) === '已完成') completed += 1;
      }
    }
    // Integer form of Math.round(100 * completed / total), free of floating-point error.
    const percent = total === 0 ? 0 : Math.floor((200 * completed + total) / (2 * total));
    return { groupId: group.id, title: group.title, completed, total, percent };
  });
}
