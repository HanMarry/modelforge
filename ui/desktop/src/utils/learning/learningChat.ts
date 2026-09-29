/**
 * Learning-mode chats (task 27.5, requirements 20.3 and 20.7): starting a chat for an exercise in
 * learning mode, unlocking its full solution, and leaving learning mode. The Kernel's system
 * prompt does the tutoring (`crates/goose/src/acp/server/learning_mode_prompt.md`); the first
 * message only hands it the exercise statement.
 */
import { setLearningMode } from '../../acp/learningMode';
import { acpDeleteSession } from '../../acp/sessions';
import type { LearningExercise } from '../../types/learningApi';
import {
  forgetLearningSessions,
  learningSessionsFor,
  rememberLearningSession,
} from './learningSessions';

/** The first message of a learning-mode chat; model-facing, so it is not localized. */
export function exerciseChatMessage(exercise: LearningExercise, solutionUnlocked: boolean): string {
  const lines = [`我在学习路径里做练习「${exercise.title}」，题目如下：`, '', exercise.prompt, ''];
  lines.push(
    solutionUnlocked
      ? '我已在练习页确认查看完整解答。请给出这道练习的完整解答代码，并解释每一步。'
      : '请用提示和追问带我一步步做，先帮我理清思路。'
  );
  return lines.join('\n');
}

export interface LearningChatDeps<S extends { id: string }> {
  /** Creates the chat session in `projectDir`. */
  createSession: (projectDir: string) => Promise<S>;
  setMode?: typeof setLearningMode;
  deleteSession?: (sessionId: string) => Promise<void>;
}

/**
 * Creates a chat for `exercise` and puts it into learning mode. When the Kernel refuses the mode
 * the new session is deleted and the error is rethrown, so no chat runs without it.
 */
export async function startLearningChat<S extends { id: string }>(
  exercise: LearningExercise,
  projectDir: string,
  solutionUnlocked: boolean,
  deps: LearningChatDeps<S>
): Promise<{ session: S; message: string }> {
  const setMode = deps.setMode ?? setLearningMode;
  const deleteSession = deps.deleteSession ?? acpDeleteSession;
  const session = await deps.createSession(projectDir);
  try {
    await setMode(session.id, { exerciseId: exercise.id, solutionUnlocked });
  } catch (error) {
    await deleteSession(session.id).catch(() => undefined);
    throw error;
  }
  rememberLearningSession(exercise.id, session.id);
  return { session, message: exerciseChatMessage(exercise, solutionUnlocked) };
}

/** Lets every learning-mode chat of `exerciseId` give the full solution (best effort). */
export async function unlockLearningChats(
  exerciseId: string,
  setMode: typeof setLearningMode = setLearningMode
): Promise<void> {
  await Promise.all(
    learningSessionsFor(exerciseId).map((sessionId) =>
      setMode(sessionId, { exerciseId, solutionUnlocked: true }).catch((error: unknown) => {
        console.warn('[learning] could not unlock the solution in session', sessionId, error);
      })
    )
  );
}

/**
 * Takes every chat of `exerciseId` out of learning mode (best effort: a deleted session cannot
 * be updated and needs nothing) and forgets them.
 */
export async function leaveLearningMode(
  exerciseId: string,
  setMode: typeof setLearningMode = setLearningMode
): Promise<void> {
  await Promise.all(
    forgetLearningSessions(exerciseId).map((sessionId) =>
      setMode(sessionId, null).catch((error: unknown) => {
        console.warn('[learning] could not leave learning mode in session', sessionId, error);
      })
    )
  );
}
