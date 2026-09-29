/**
 * Renderer API for the learning path (requirement 20, tasks 27.2, 27.5, 27.6). Implemented by
 * `bridges/learningBridge.ts`, served by `utils/learning/learningIpc.ts`; owned by
 * `mp/s2-c1-learning`. Progress lives in `userData/learning-progress.json`.
 *
 * Check items are defined once, in `src/catalog/learning-path.json` (validated by
 * `scripts/check-skills.js`), not in skill frontmatter.
 */
import type { IpcResult } from '../utils/ipcResult';
import type { CheckOutcome, CheckResult, ExerciseRecord } from '../utils/learning/progress';

interface LearningCheckBase {
  id: string;
  description: string;
}

/** Passes when the Project-relative `path` is a regular file inside the Project. */
export interface FileExistsCheck extends LearningCheckBase {
  kind: 'file-exists';
  path: string;
}

/** Passes when top-level key `field` of the JSON file `path` is a number in `[min, max]`. */
export interface NumberInRangeCheck extends LearningCheckBase {
  kind: 'number-in-range';
  path: string;
  field: string;
  min: number;
  max: number;
}

/** Judged by the Kernel from the submission and the Project files listed in `files`. */
export interface SubjectiveCheck extends LearningCheckBase {
  kind: 'subjective';
  files?: string[];
}

/** One check item of an exercise, as in `src/catalog/learning-path.json`. */
export type LearningCheck = FileExistsCheck | NumberInRangeCheck | SubjectiveCheck;

export interface LearningExercise {
  id: string;
  title: string;
  prompt: string;
  checks: LearningCheck[];
}

export interface LearningCourse {
  id: string;
  title: string;
  objectives: string[];
  /** Builtin skill names; `check-skills.js` verifies they exist (20.1). */
  skills: string[];
  exercises: LearningExercise[];
}

export interface LearningGroup {
  id: string;
  title: string;
  courses: LearningCourse[];
}

export interface LearningCatalog {
  version: number;
  updatedAt: string;
  groups: LearningGroup[];
}

export interface LearningMaterialsRequest {
  exerciseId: string;
  /** Project the exercise's files are read from. */
  projectDir: string;
}

/** A Project file handed to the Kernel for the subjective items. */
export interface LearningFileExcerpt {
  /** Project-relative, `/`-separated. */
  path: string;
  /** UTF-8 text, cut at `truncated`; null when the file is missing or unreadable. */
  content: string | null;
  truncated: boolean;
}

/** What the Kernel needs to judge an exercise's subjective items (task 27.2). */
export interface LearningReviewMaterials {
  exerciseId: string;
  checks: SubjectiveCheck[];
  files: LearningFileExcerpt[];
}

export interface LearningSubmitRequest {
  exerciseId: string;
  /** Project the exercise's files are checked in. */
  projectDir: string;
  /** What the user submitted; kept in the record so it can be revised (20.5). */
  submission: string;
  /** The Kernel's verdicts on the subjective items; verdicts for other items are ignored. */
  subjectiveResults?: CheckResult[];
  /**
   * Epoch milliseconds after which the outcome must not be recorded: a check that misses it
   * fails with `CHECK_TIMEOUT` and leaves the record as it was (20.6).
   */
  deadline?: number;
}

export interface LearningApi {
  learningCatalog: () => Promise<IpcResult<LearningCatalog>>;
  learningProgressGet: () => Promise<IpcResult<ExerciseRecord[]>>;
  learningProgressSave: (records: ExerciseRecord[]) => Promise<IpcResult<null>>;
  /** Reads the files the subjective items are judged on. */
  learningCheckMaterials: (
    request: LearningMaterialsRequest
  ) => Promise<IpcResult<LearningReviewMaterials>>;
  /** Runs the exercise's checks (20.2); a failed or timed-out run changes nothing (20.6). */
  learningCheckSubmit: (request: LearningSubmitRequest) => Promise<IpcResult<CheckOutcome>>;
  /** "查看完整解答" after the second confirmation; marks the record `solutionViewed` (20.7). */
  learningSolutionUnlock: (exerciseId: string) => Promise<IpcResult<ExerciseRecord>>;
}
