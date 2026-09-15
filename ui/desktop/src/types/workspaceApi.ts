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
}

export interface WorkspaceFileReadResult {
  content: string;
  path: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  error: string | null;
}

export interface EnvironmentProbe {
  id: string;
  label: string;
  command: string;
  version: string | null;
  available: boolean;
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

export type TerminalMode = 'pty' | 'pipe';

export interface TerminalSessionInfo {
  id: string;
  mode: TerminalMode;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
}
