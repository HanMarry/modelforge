/**
 * Main-process IPC for mock review records (requirement 19, tasks 26.4, 26.5). C0 skeleton: every
 * channel is registered and answers `NOT_IMPLEMENTED` until `mp/s2-c1-review` fills it in with
 * `validateReview` from `reviewModel.ts`.
 */
import type { IpcMain } from 'electron';
import { notImplemented, type FeatureIpcDeps } from '../featureIpc';

export function registerReviewIpc(ipc: Pick<IpcMain, 'handle'>, deps: FeatureIpcDeps): void {
  // Args: (paper: ReviewPaperRef) from types/reviewApi.ts.
  ipc.handle('review-list', () => notImplemented('review-list', deps));
  // Args: (request: ReviewSaveRequest).
  ipc.handle('review-save', () => notImplemented('review-save', deps));
}
