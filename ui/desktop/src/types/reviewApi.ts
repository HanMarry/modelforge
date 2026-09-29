/**
 * Renderer API for mock review records (requirement 19, tasks 26.4, 26.5). Implemented by
 * `bridges/reviewBridge.ts`, served by `utils/review/reviewIpc.ts`; owned by `mp/s2-c1-review`.
 * The model call itself goes through the Kernel over ACP; these channels only read and write
 * `.modelforge/reviews/`.
 */
import type { IpcResult } from '../utils/ipcResult';
import type { ReviewOutput, ReviewRecord } from '../utils/review/reviewModel';

export interface ReviewPaperRef {
  projectDir: string;
  /** Project-relative path of the reviewed paper. */
  paperPath: string;
}

export interface ReviewSaveRequest extends ReviewPaperRef {
  /** Id from `src/catalog/competitions.json`. */
  competitionId: string;
  /** Kernel output; saved only when `validateReview` accepts it (19.6). */
  output: ReviewOutput;
}

export interface ReviewApi {
  /** Earlier completed reviews of the paper, oldest first. */
  reviewList: (paper: ReviewPaperRef) => Promise<IpcResult<ReviewRecord[]>>;
  reviewSave: (request: ReviewSaveRequest) => Promise<IpcResult<ReviewRecord>>;
}
