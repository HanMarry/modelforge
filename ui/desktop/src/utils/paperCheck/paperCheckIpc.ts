/**
 * Main-process IPC for the paper delivery check (requirement 18, tasks 23.8, 23.10). C0 skeleton:
 * the channel is registered and answers `NOT_IMPLEMENTED` until `mp/s2-c1-paper` fills it in.
 * The checks run in the `utilityProcess` entry `paperCheckRunnerMain.ts`, which `forge.config.ts`
 * already builds next to `main.js`.
 */
import type { IpcMain } from 'electron';
import { notImplemented, type FeatureIpcDeps } from '../featureIpc';

export function registerPaperCheckIpc(ipc: Pick<IpcMain, 'handle'>, deps: FeatureIpcDeps): void {
  // Args: (request: PaperCheckRequest) from types/paperCheckApi.ts.
  ipc.handle('paper-check-run', () => notImplemented('paper-check-run', deps));
}
