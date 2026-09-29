/**
 * Renderer API for Run_Records and Artifact_Status (requirements 16, 17). Implemented by
 * `bridges/runsBridge.ts`, served by `utils/runs/runsIpc.ts`; owned by `mp/s2-c1-runs`.
 */
import type { IpcResult } from '../utils/ipcResult';
import type { LoadedRunRecords } from '../utils/runRecord';
import type { ArtifactIndex, MarkVerifiedResult } from './artifactStatus';

/** Payload of the `artifacts-changed` push event. */
export interface ArtifactsChangedEvent {
  /** Project root whose `.modelforge/artifacts.json` changed. */
  projectDir: string;
  index: ArtifactIndex;
}

export interface RunsApi {
  /** `.modelforge/runs/*.json`; invalid files are listed with their problems (16.5). */
  runsList: (projectDir: string) => Promise<IpcResult<LoadedRunRecords>>;
  artifactsGet: (projectDir: string) => Promise<IpcResult<ArtifactIndex>>;
  /** "标记已验证"; a refusal comes back as `{ ok: false, reason }` inside `data` (17.7). */
  artifactsVerify: (
    projectDir: string,
    artifactPath: string
  ) => Promise<IpcResult<MarkVerifiedResult>>;
  /** Manual staleness check (17.3); the result is also pushed through `onArtifactsChanged`. */
  artifactsCheckStale: (projectDir: string) => Promise<IpcResult<ArtifactIndex>>;
  /** Subscribes to `artifacts-changed`; returns the unsubscribe function. */
  onArtifactsChanged: (callback: (event: ArtifactsChangedEvent) => void) => () => void;
}
