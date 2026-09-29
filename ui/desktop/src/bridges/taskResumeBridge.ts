/**
 * Preload bridge for resuming interrupted tasks; spread into `window.electron` by
 * `bridges/index.ts`. Owned by `mp/s2-c1-resume`.
 */
import { ipcRenderer } from 'electron';
import type { TaskResumeApi } from '../types/taskResumeApi';

export const taskResumeBridge: TaskResumeApi = {
  taskResumeList: (request) => ipcRenderer.invoke('task-resume-list', request),
  taskResumeContinue: (target) => ipcRenderer.invoke('task-resume-continue', target),
  taskResumeDismiss: (target) => ipcRenderer.invoke('task-resume-dismiss', target),
};
