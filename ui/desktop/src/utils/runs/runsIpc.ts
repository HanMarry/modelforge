/**
 * Main-process IPC for Run_Records and Artifact_Status (spec mathmodel-parity-and-beyond,
 * requirements 16, 17; tasks 21.8, 22.8, 22.9). The work is done by the Artifact store in
 * `artifactStore.ts`; this module checks nothing itself beyond wrapping results and errors. The
 * renderer API lives in `bridges/runsBridge.ts` and `types/runsApi.ts`.
 *
 * Channels (all return `IpcResult`):
 * - `runs-list(projectDir)`: `LoadedRunRecords`; broken record files are reported (16.5).
 * - `artifacts-get(projectDir)`: the `ArtifactIndex`, after a detection pass when needed.
 * - `artifacts-verify(projectDir, artifactPath)`: `MarkVerifiedResult`; a refusal is
 *   `{ ok: true, data: { ok: false, reason } }`.
 * - `artifacts-check-stale(projectDir)`: a detection pass now.
 * - `artifacts-inspect(projectDir, artifactPath)`: `ArtifactInspection` for the Project panel.
 * - `artifacts-run-started(event)`, `artifacts-run-finished(event)`: the Kernel's run
 *   notifications, passed on by the renderer (`acp/runNotifications.ts`).
 * Push event `artifacts-changed` (`ArtifactsChangedEvent`) whenever an index changes.
 */
import type { IpcMain } from 'electron';
import type { ArtifactsChangedEvent } from '../../types/runsApi';
import type { FeatureIpcDeps } from '../featureIpc';
import { toIpcError, type IpcResult } from '../ipcResult';
import { ArtifactStoreError, sharedArtifactStore, type ArtifactStore } from './artifactStore';

/** Push event sent whenever a Project's `.modelforge/artifacts.json` changes. */
export const ARTIFACTS_CHANGED_CHANNEL = 'artifacts-changed';

export const RUNS_IPC_CHANNELS = [
  'runs-list',
  'artifacts-get',
  'artifacts-verify',
  'artifacts-check-stale',
  'artifacts-inspect',
  'artifacts-run-started',
  'artifacts-run-finished',
] as const;

/** Error code of a failure that is not one of the store's refusals. */
export const READ_FAILED = 'READ_FAILED';

/** Tells every renderer window that the Artifact_Status index of a Project changed. */
export function broadcastArtifactsChanged(
  deps: FeatureIpcDeps,
  event: ArtifactsChangedEvent
): void {
  deps.broadcast(ARTIFACTS_CHANGED_CHANNEL, event);
}

export function registerRunsIpc(
  ipc: Pick<IpcMain, 'handle'>,
  deps: FeatureIpcDeps,
  store: ArtifactStore = sharedArtifactStore()
): void {
  store.subscribe((event) => broadcastArtifactsChanged(deps, event));

  const handle = <T>(
    channel: (typeof RUNS_IPC_CHANNELS)[number],
    work: (...args: unknown[]) => Promise<T>
  ) => {
    ipc.handle(channel, async (_event, ...args: unknown[]): Promise<IpcResult<T>> => {
      try {
        return { ok: true, data: await work(...args) };
      } catch (error) {
        const code = error instanceof ArtifactStoreError ? error.code : READ_FAILED;
        return { ok: false, error: toIpcError(code, error, deps.sensitiveValues()) };
      }
    });
  };

  handle('runs-list', (projectDir) => store.listRuns(projectDir as string));
  handle('artifacts-get', (projectDir) => store.getIndex(projectDir as string));
  handle('artifacts-verify', (projectDir, artifactPath) =>
    store.verify(projectDir as string, artifactPath as string)
  );
  handle('artifacts-check-stale', (projectDir) => store.checkStale(projectDir as string));
  handle('artifacts-inspect', (projectDir, artifactPath) =>
    store.inspect(projectDir as string, artifactPath as string)
  );
  handle('artifacts-run-started', (event) => store.runStarted(event));
  handle('artifacts-run-finished', (event) => store.runFinished(event));
}
