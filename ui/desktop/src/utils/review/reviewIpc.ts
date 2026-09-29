/**
 * Main-process IPC for mock review records (requirement 19, tasks 26.4, 26.5).
 *
 * - `review-paper-check(paper)`: the paper exists inside the project and can be read (19.5).
 * - `review-list(paper)`: completed reviews of the paper, oldest first (19.3, 19.4).
 * - `review-save(request)`: stores a review only when `validateReview` accepts it (19.6).
 *
 * The model call itself runs in the renderer over ACP (`reviewRunner.ts`). Every handler
 * returns `IpcResult`; error messages pass through `toIpcError`, which masks key values.
 */
import type { IpcMain } from 'electron';
import type { ReviewErrorCode, ReviewPaperInfo } from '../../types/reviewApi';
import type { FeatureIpcDeps } from '../featureIpc';
import { toIpcError, type IpcResult } from '../ipcResult';
import type { ReviewRecord } from './reviewModel';
import {
  checkPaper,
  listReviews,
  ReviewStoreError,
  saveReview,
  type ReviewStoreOptions,
} from './reviewStore';

async function respond<T>(
  deps: FeatureIpcDeps,
  fallbackCode: ReviewErrorCode,
  task: () => Promise<T>
): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await task() };
  } catch (error) {
    const code = error instanceof ReviewStoreError ? error.code : fallbackCode;
    return { ok: false, error: toIpcError(code, error, deps.sensitiveValues()) };
  }
}

export function registerReviewIpc(
  ipc: Pick<IpcMain, 'handle'>,
  deps: FeatureIpcDeps,
  options: ReviewStoreOptions = {}
): void {
  // Args: (paper: ReviewPaperRef) from types/reviewApi.ts.
  ipc.handle(
    'review-list',
    (_event: unknown, paper: unknown): Promise<IpcResult<ReviewRecord[]>> =>
      respond(deps, 'READ_FAILED', () => listReviews(paper))
  );
  // Args: (request: ReviewSaveRequest).
  ipc.handle(
    'review-save',
    (_event: unknown, request: unknown): Promise<IpcResult<ReviewRecord>> =>
      respond(deps, 'WRITE_FAILED', () => saveReview(request, options))
  );
  // Args: (paper: ReviewPaperRef).
  ipc.handle(
    'review-paper-check',
    (_event: unknown, paper: unknown): Promise<IpcResult<ReviewPaperInfo>> =>
      respond(deps, 'PAPER_UNREADABLE', () => checkPaper(paper))
  );
}
