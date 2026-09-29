import { app, ipcMain } from 'electron';
import path from 'node:path';
import { isAbsoluteGoosePath } from '../pathUtils';
import { CheckpointService, resolveGit } from './checkpointService';
import type {
  AutoCheckpoint,
  CheckpointDiff,
  CheckpointDiffTarget,
  CheckpointEnsureResult,
  CheckpointRestoreResult,
  CheckpointResult,
} from './checkpointService';

export type {
  AutoCheckpoint,
  CheckpointDiff,
  CheckpointFileChange,
  CheckpointKind,
  CheckpointResult,
  CheckpointError,
} from './checkpointService';

let service: CheckpointService | null = null;

function checkpointService(): CheckpointService {
  if (!service) {
    service = new CheckpointService({ userDataDir: app.getPath('userData') });
  }
  return service;
}

function invalidPath(): { ok: false; error: { code: 'INVALID_PATH'; message: string } } {
  return { ok: false, error: { code: 'INVALID_PATH', message: 'Invalid working directory' } };
}

function validateWorkingDir(workingDir: unknown): workingDir is string {
  return (
    typeof workingDir === 'string' &&
    workingDir.trim().length > 0 &&
    isAbsoluteGoosePath(workingDir.trim())
  );
}

export interface CheckpointGitSource {
  /** `bundled` (MinGit shipped with the app) or `system` (git on PATH); null when unavailable. */
  source: 'bundled' | 'system' | null;
  path: string | null;
  /** `GIT_UNAVAILABLE` when neither git could be run. */
  errorCode: string | null;
  message: string | null;
}

export function registerCheckpointIpc(): void {
  // Diagnostics centre shows which git automatic snapshots use (requirement 11.2, task 15.1).
  ipcMain.handle('checkpoint-git-source', async (): Promise<CheckpointGitSource> => {
    const resolved = await resolveGit({});
    return resolved.ok
      ? { source: resolved.value.source, path: resolved.value.git, errorCode: null, message: null }
      : {
          source: null,
          path: null,
          errorCode: resolved.error.code,
          message: resolved.error.message,
        };
  });

  ipcMain.handle(
    'checkpoint-ensure',
    async (
      _event,
      workingDir: string,
      sessionId: string,
      turn: number
    ): Promise<CheckpointResult<CheckpointEnsureResult>> => {
      if (!validateWorkingDir(workingDir) || typeof sessionId !== 'string' || typeof turn !== 'number') {
        return invalidPath();
      }
      return checkpointService().ensureForTurn(path.normalize(workingDir.trim()), sessionId, Math.trunc(turn));
    }
  );

  ipcMain.handle(
    'checkpoint-list',
    async (_event, workingDir: string, limit = 100): Promise<CheckpointResult<AutoCheckpoint[]>> => {
      if (!validateWorkingDir(workingDir)) return invalidPath();
      return checkpointService().listCheckpoints(path.normalize(workingDir.trim()), limit);
    }
  );

  ipcMain.handle(
    'checkpoint-diff',
    async (
      _event,
      workingDir: string,
      a: string,
      b: string | CheckpointDiffTarget
    ): Promise<CheckpointResult<CheckpointDiff>> => {
      if (!validateWorkingDir(workingDir) || typeof a !== 'string' || typeof b !== 'string') {
        return invalidPath();
      }
      return checkpointService().diff(path.normalize(workingDir.trim()), a, b as string | CheckpointDiffTarget);
    }
  );

  ipcMain.handle(
    'checkpoint-restore',
    async (_event, workingDir: string, checkpointId: string): Promise<CheckpointResult<CheckpointRestoreResult>> => {
      if (!validateWorkingDir(workingDir) || typeof checkpointId !== 'string' || !checkpointId.trim()) {
        return invalidPath();
      }
      return checkpointService().restore(path.normalize(workingDir.trim()), checkpointId);
    }
  );
}
