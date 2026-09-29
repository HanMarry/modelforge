/**
 * Main-process IPC for resuming interrupted tasks (requirement 22, tasks 25.4, 25.5). C0
 * skeleton: every channel is registered and answers `NOT_IMPLEMENTED` until `mp/s2-c1-resume`
 * fills it in with `utils/resumePlanner.ts`.
 */
import type { IpcMain } from 'electron';
import { notImplemented, type FeatureIpcDeps } from '../featureIpc';

export function registerTaskResumeIpc(ipc: Pick<IpcMain, 'handle'>, deps: FeatureIpcDeps): void {
  // Args: (request: TaskResumeListRequest) from types/taskResumeApi.ts.
  ipc.handle('task-resume-list', () => notImplemented('task-resume-list', deps));
  // Args: (target: TaskResumeTarget).
  ipc.handle('task-resume-continue', () => notImplemented('task-resume-continue', deps));
  // Args: (target: TaskResumeTarget).
  ipc.handle('task-resume-dismiss', () => notImplemented('task-resume-dismiss', deps));
}
