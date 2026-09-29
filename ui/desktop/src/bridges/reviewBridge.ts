/**
 * Preload bridge for mock review records; spread into `window.electron` by `bridges/index.ts`.
 * Owned by `mp/s2-c1-review`.
 */
import { ipcRenderer } from 'electron';
import type { ReviewApi } from '../types/reviewApi';

export const reviewBridge: ReviewApi = {
  reviewList: (paper) => ipcRenderer.invoke('review-list', paper),
  reviewSave: (request) => ipcRenderer.invoke('review-save', request),
  reviewPaperCheck: (paper) => ipcRenderer.invoke('review-paper-check', paper),
};
