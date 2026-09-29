/**
 * Main-process IPC for comparing two runs (requirement 21, task 24.3). C0 skeleton: the channel is
 * registered and answers `NOT_IMPLEMENTED` until `mp/s2-c1-compare` fills it in with
 * `compareRuns` from `utils/runCompare.ts`.
 */
import type { IpcMain } from 'electron';
import { notImplemented, type FeatureIpcDeps } from '../featureIpc';

export function registerRunCompareIpc(ipc: Pick<IpcMain, 'handle'>, deps: FeatureIpcDeps): void {
  // Args: (request: RunCompareRequest) from types/runCompareApi.ts.
  ipc.handle('runs-compare', () => notImplemented('runs-compare', deps));
}
