/**
 * Main-process IPC for Run_Records and Artifact_Status (requirements 16, 17; tasks 21.8,
 * 22.8–22.10). C0 skeleton: every channel is registered and answers `NOT_IMPLEMENTED` until the
 * `mp/s2-c1-runs` branch fills it in. The renderer API lives in `bridges/runsBridge.ts` and
 * `types/runsApi.ts`.
 */
import type { IpcMain } from 'electron';
import type { ArtifactsChangedEvent } from '../../types/runsApi';
import { notImplemented, type FeatureIpcDeps } from '../featureIpc';

/** Push event sent whenever a Project's `.modelforge/artifacts.json` changes. */
export const ARTIFACTS_CHANGED_CHANNEL = 'artifacts-changed';

/** Tells every renderer window that the Artifact_Status index of a Project changed. */
export function broadcastArtifactsChanged(
  deps: FeatureIpcDeps,
  event: ArtifactsChangedEvent
): void {
  deps.broadcast(ARTIFACTS_CHANGED_CHANNEL, event);
}

export function registerRunsIpc(ipc: Pick<IpcMain, 'handle'>, deps: FeatureIpcDeps): void {
  // Args: (projectDir: string). Invalid record files are reported and the rest still load (16.5).
  ipc.handle('runs-list', () => notImplemented('runs-list', deps));
  // Args: (projectDir: string).
  ipc.handle('artifacts-get', () => notImplemented('artifacts-get', deps));
  // Args: (projectDir: string, artifactPath: string).
  ipc.handle('artifacts-verify', () => notImplemented('artifacts-verify', deps));
  // Args: (projectDir: string).
  ipc.handle('artifacts-check-stale', () => notImplemented('artifacts-check-stale', deps));
}
