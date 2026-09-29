/**
 * Preload bridge for the paper delivery check; spread into `window.electron` by
 * `bridges/index.ts`. Owned by `mp/s2-c1-paper`.
 */
import { ipcRenderer } from 'electron';
import type { PaperCheckApi } from '../types/paperCheckApi';

export const paperCheckBridge: PaperCheckApi = {
  paperCheckRun: (request) => ipcRenderer.invoke('paper-check-run', request),
};
