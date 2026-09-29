/**
 * Learning-mode chats per exercise (task 27.5, requirement 20.3). Learning mode lasts from
 * opening an exercise's chat until the learner closes the exercise or leaves learning mode, so
 * the renderer remembers which sessions it put into learning mode, across page changes and
 * restarts, to take them out again. Kept in `localStorage`; the Kernel keeps the mode itself in
 * the session (`_goose/unstable/session/learning-mode/set`).
 */
const STORAGE_KEY = 'modelforge.learning.sessions';

type SessionMap = Record<string, string[]>;

function load(): SessionMap {
  try {
    const data: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return {};
    const map: SessionMap = {};
    for (const [exerciseId, ids] of Object.entries(data)) {
      if (Array.isArray(ids)) {
        map[exerciseId] = ids.filter((id): id is string => typeof id === 'string');
      }
    }
    return map;
  } catch {
    return {};
  }
}

function save(map: SessionMap): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (error) {
    console.warn('[learning] could not remember learning-mode sessions', error);
  }
}

/** Sessions currently in learning mode for `exerciseId`, oldest first. */
export function learningSessionsFor(exerciseId: string): string[] {
  return load()[exerciseId] ?? [];
}

export function rememberLearningSession(exerciseId: string, sessionId: string): void {
  const map = load();
  const ids = map[exerciseId] ?? [];
  if (!ids.includes(sessionId)) map[exerciseId] = [...ids, sessionId];
  save(map);
}

/** Forgets the sessions of `exerciseId` and returns them. */
export function forgetLearningSessions(exerciseId: string): string[] {
  const map = load();
  const ids = map[exerciseId] ?? [];
  delete map[exerciseId];
  save(map);
  return ids;
}
