export interface WorkspaceEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
}

export type ProjectStage = 'inputs' | 'plan' | 'code' | 'results' | 'figures' | 'paper';

export interface ProjectArtifact extends WorkspaceEntry {
  relativePath: string;
  stage: ProjectStage;
}

export interface ProjectSnapshot {
  root: string;
  scannedAt: number;
  artifacts: ProjectArtifact[];
  limited: boolean;
  unreadableDirectories: number;
  /** Example the Project was created from (`.modelforge/project.json`), for its reference approach. */
  exampleId?: string | null;
}

export interface WorkspaceFileReadResult {
  content: string;
  path: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  error: string | null;
}

/**
 * `timeout`: the tool was found but did not answer in time, so whether it works is unknown;
 * it is neither available nor reported as missing.
 */
export type EnvironmentProbeStatus = 'available' | 'missing' | 'timeout';

export interface EnvironmentProbe {
  id: string;
  label: string;
  /** The file that was started, or the command name when none was found. */
  command: string;
  version: string | null;
  available: boolean;
  status: EnvironmentProbeStatus;
}

export interface GitVersionStatus {
  isRepo: boolean;
  branch: string | null;
  changedFiles: number;
  insertions: number;
  deletions: number;
}

export interface GitCheckpoint {
  hash: string;
  shortHash: string;
  author: string;
  timestamp: number;
  subject: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface GitCheckpointFile {
  status: string;
  path: string;
}

export type GitVersionError =
  'not-a-repo' | 'nothing-to-commit' | 'missing-identity' | 'git-missing' | 'failed';

export interface GitVersionResult {
  ok: boolean;
  reason?: GitVersionError;
  error?: string;
}

export type AutoCheckpointKind = 'auto' | 'pre-restore';

export interface AutoCheckpoint {
  id: string;
  shortId: string;
  createdAt: number;
  sessionId: string;
  turn: number;
  kind: AutoCheckpointKind;
  filesChanged: number;
}

export interface AutoCheckpointFileChange {
  status: 'A' | 'D' | 'M';
  path: string;
  binary: boolean;
}

export interface AutoCheckpointDiff {
  files: AutoCheckpointFileChange[];
  textByPath: Record<string, string>;
}

export type AutoCheckpointErrorCode = 'GIT_UNAVAILABLE' | 'CHECKPOINT_FAILED' | 'INVALID_PATH' | 'NOT_FOUND';

export interface AutoCheckpointError {
  code: AutoCheckpointErrorCode;
  message: string;
}

export interface AutoCheckpointEnsureResult {
  checkpointId: string;
  created: boolean;
}

export interface AutoCheckpointRestoreResult {
  changedFiles: number;
}

export type AutoCheckpointResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AutoCheckpointError };

export type TerminalMode = 'pty' | 'pipe';

export interface TerminalSessionInfo {
  id: string;
  mode: TerminalMode;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
}
