/**
 * Main-process IPC for the learning path (requirement 20, tasks 27.2, 27.5, 27.6). C0 skeleton:
 * every channel is registered and answers `NOT_IMPLEMENTED` until `mp/s2-c1-learning` fills it in
 * (progress in `<deps.userDataDir>/learning-progress.json`, written atomically).
 */
import type { IpcMain } from 'electron';
import { notImplemented, type FeatureIpcDeps } from '../featureIpc';

export function registerLearningIpc(ipc: Pick<IpcMain, 'handle'>, deps: FeatureIpcDeps): void {
  ipc.handle('learning-catalog', () => notImplemented('learning-catalog', deps));
  ipc.handle('learning-progress-get', () => notImplemented('learning-progress-get', deps));
  // Args: (records: ExerciseRecord[]).
  ipc.handle('learning-progress-save', () => notImplemented('learning-progress-save', deps));
  // Args: (request: LearningSubmitRequest) from types/learningApi.ts.
  ipc.handle('learning-check-submit', () => notImplemented('learning-check-submit', deps));
  // Args: (exerciseId: string).
  ipc.handle('learning-solution-unlock', () => notImplemented('learning-solution-unlock', deps));
}
