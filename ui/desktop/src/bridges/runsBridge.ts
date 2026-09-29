/**
 * Preload bridge for Run_Records and Artifact_Status; spread into `window.electron` by
 * `bridges/index.ts`. Owned by `mp/s2-c1-runs`.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ArtifactsChangedEvent, RunsApi } from '../types/runsApi';

export const runsBridge: RunsApi = {
  runsList: (projectDir) => ipcRenderer.invoke('runs-list', projectDir),
  artifactsGet: (projectDir) => ipcRenderer.invoke('artifacts-get', projectDir),
  artifactsVerify: (projectDir, artifactPath) =>
    ipcRenderer.invoke('artifacts-verify', projectDir, artifactPath),
  artifactsCheckStale: (projectDir) => ipcRenderer.invoke('artifacts-check-stale', projectDir),
  onArtifactsChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: ArtifactsChangedEvent) =>
      callback(payload);
    ipcRenderer.on('artifacts-changed', listener);
    return () => ipcRenderer.removeListener('artifacts-changed', listener);
  },
};
