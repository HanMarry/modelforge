/**
 * Preload bridge for comparing two runs; spread into `window.electron` by `bridges/index.ts`.
 * Owned by `mp/s2-c1-compare`.
 */
import { ipcRenderer } from 'electron';
import type { RunCompareApi } from '../types/runCompareApi';

export const runCompareBridge: RunCompareApi = {
  runsCompare: (request) => ipcRenderer.invoke('runs-compare', request),
  runsCompareList: (projectDir) => ipcRenderer.invoke('runs-compare-list', projectDir),
};
