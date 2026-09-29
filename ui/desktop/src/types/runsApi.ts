/**
 * Renderer API for Run_Records and Artifact_Status (requirements 16, 17). Implemented by
 * `bridges/runsBridge.ts`, served by `utils/runs/runsIpc.ts`; owned by `mp/s2-c1-runs`.
 */
import type { IpcResult } from '../utils/ipcResult';
import type { LoadedRunRecords } from '../utils/runRecord';
import type { ArtifactEntry, ArtifactIndex, MarkVerifiedResult } from './artifactStatus';
import type { FileHashValue, RunRecord } from './runRecord';

/** Payload of the `artifacts-changed` push event. */
export interface ArtifactsChangedEvent {
  /** Project root whose `.modelforge/artifacts.json` changed, as resolved by `fs.realpath`. */
  projectDir: string;
  index: ArtifactIndex;
}

/** A `_goose/unstable/runs/started` notification the renderer passes on to the main process. */
export interface ArtifactsRunStartedEvent {
  /** Project root, the session working directory. */
  workingDir: string;
  runId: string;
  /** Project-relative, `/`-separated; the run's other outputs are only known when it ends. */
  declaredOutputs: string[];
}

/** A `_goose/unstable/runs/finished` notification the renderer passes on to the main process. */
export interface ArtifactsRunFinishedEvent {
  workingDir: string;
  runId: string;
  /** `.modelforge/runs/<runId>.json`, relative to `workingDir`. */
  recordPath: string;
}

export type ArtifactFileRole = 'code' | 'input' | 'artifact';

/**
 * How a file of the run compares with the Run_Record: `unrecorded` is an Artifact whose output
 * hash is not in the record (the list stops at 1000 entries).
 */
export type ArtifactFileState = 'match' | 'changed' | 'missing' | 'unreadable' | 'unrecorded';

export interface ArtifactFileCheck {
  /** Project-relative path with `/` separators. */
  path: string;
  role: ArtifactFileRole;
  /** The hash the record holds for the file (its output hash if the run also wrote it). */
  recorded: string | null;
  /** Current SHA-256, or `FILE_HASH_MISSING` / `FILE_HASH_UNREADABLE` from `utils/runRecord.ts`. */
  current: FileHashValue;
  state: ArtifactFileState;
}

/** What the Project panel shows for a selected Artifact (requirements 16.7, 17.5). */
export interface ArtifactInspection {
  path: string;
  entry: ArtifactEntry | null;
  /**
   * The Run_Record the entry names; `null` when it names none or the record is missing or cannot
   * be parsed, which the panel shows as "无运行记录".
   */
  record: RunRecord | null;
  /** The code, the inputs in record order, then the Artifact; empty without a record. */
  files: ArtifactFileCheck[];
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
  /** The Run_Record behind one Artifact and whether its files still match it (16.7, 17.5). */
  artifactsInspect: (
    projectDir: string,
    artifactPath: string
  ) => Promise<IpcResult<ArtifactInspection>>;
  /** Marks the declared outputs of a run that just started as `执行中`. */
  artifactsRunStarted: (event: ArtifactsRunStartedEvent) => Promise<IpcResult<ArtifactIndex>>;
  /** Applies the Run_Record of a run that just ended. */
  artifactsRunFinished: (event: ArtifactsRunFinishedEvent) => Promise<IpcResult<ArtifactIndex>>;
  /** Subscribes to `artifacts-changed`; returns the unsubscribe function. */
  onArtifactsChanged: (callback: (event: ArtifactsChangedEvent) => void) => () => void;
}
