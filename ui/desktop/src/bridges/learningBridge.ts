/**
 * Preload bridge for the learning path; spread into `window.electron` by `bridges/index.ts`.
 * Owned by `mp/s2-c1-learning`.
 */
import { ipcRenderer } from 'electron';
import type { LearningApi } from '../types/learningApi';

export const learningBridge: LearningApi = {
  learningCatalog: () => ipcRenderer.invoke('learning-catalog'),
  learningProgressGet: () => ipcRenderer.invoke('learning-progress-get'),
  learningProgressSave: (records) => ipcRenderer.invoke('learning-progress-save', records),
  learningCheckMaterials: (request) => ipcRenderer.invoke('learning-check-materials', request),
  learningCheckSubmit: (request) => ipcRenderer.invoke('learning-check-submit', request),
  learningSolutionUnlock: (exerciseId) =>
    ipcRenderer.invoke('learning-solution-unlock', exerciseId),
};
