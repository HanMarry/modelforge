/**
 * Renderer API for the learning path (requirement 20, tasks 27.2, 27.5, 27.6). Implemented by
 * `bridges/learningBridge.ts`, served by `utils/learning/learningIpc.ts`; owned by
 * `mp/s2-c1-learning`. Progress lives in `userData/learning-progress.json`.
 */
import type { IpcResult } from '../utils/ipcResult';
import type { CheckOutcome, ExerciseRecord } from '../utils/learning/progress';

/** One check item of an exercise, as in `src/catalog/learning-path.json`. */
export interface LearningCheck {
  id: string;
  /** `file-exists`, `number-in-range` and `subjective` today. */
  kind: string;
  description: string;
}

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

export interface LearningSubmitRequest {
  exerciseId: string;
  /** Project the exercise's files are checked in. */
  projectDir: string;
  /** What the user submitted; kept in the record so it can be revised (20.6). */
  submission: string;
}

export interface LearningApi {
  learningCatalog: () => Promise<IpcResult<LearningCatalog>>;
  learningProgressGet: () => Promise<IpcResult<ExerciseRecord[]>>;
  learningProgressSave: (records: ExerciseRecord[]) => Promise<IpcResult<null>>;
  /** Runs the exercise's checks (20.2); a failed or timed-out run changes nothing (20.6). */
  learningCheckSubmit: (request: LearningSubmitRequest) => Promise<IpcResult<CheckOutcome>>;
  /** "查看完整解答" after the second confirmation; marks the record `solutionViewed` (20.7). */
  learningSolutionUnlock: (exerciseId: string) => Promise<IpcResult<ExerciseRecord>>;
}
