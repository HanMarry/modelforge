/**
 * Renderer API for mock review records (requirement 19, tasks 26.4, 26.5). Implemented by
 * `bridges/reviewBridge.ts`, served by `utils/review/reviewIpc.ts`; owned by `mp/s2-c1-review`.
 * The model call itself goes through the Kernel over ACP (`utils/review/reviewRunner.ts`); these
 * channels only check the paper file and read and write `.modelforge/reviews/`.
 */
import type { IpcResult } from '../utils/ipcResult';
import type { ReviewOutput, ReviewRecord } from '../utils/review/reviewModel';

export interface ReviewPaperRef {
  projectDir: string;
  /** Project-relative path of the reviewed paper, `/` or `\` separated. */
  paperPath: string;
}

export interface ReviewSaveRequest extends ReviewPaperRef {
  /** Id from `src/catalog/competitions.json`. */
  competitionId: string;
  /** Kernel output; saved only when `validateReview` accepts it (19.6). */
  output: ReviewOutput;
}

/** How suggestion locations are written (requirement 19.2): lines for sources, pages for PDF. */
export type ReviewPaperFormat = 'latex' | 'markdown' | 'pdf';

/** A paper that exists inside the project and can be read (requirement 19.5). */
export interface ReviewPaperInfo {
  /** Canonical project-relative path, `/` separated; use it for the other channels. */
  paperPath: string;
  format: ReviewPaperFormat;
  size: number;
}

/**
 * Stable `IpcError.code` values of the `review-*` channels; the panel maps them to localized
 * text. `REVIEW_INCOMPLETE` is the design's error for a result that failed validation.
 */
export type ReviewErrorCode =
  | 'INVALID_REQUEST'
  | 'PROJECT_NOT_FOUND'
  | 'OUTSIDE_PROJECT'
  | 'UNSUPPORTED_FORMAT'
  | 'PAPER_NOT_FOUND'
  | 'PAPER_UNREADABLE'
  | 'PAPER_EMPTY'
  | 'UNKNOWN_COMPETITION'
  | 'REVIEW_INCOMPLETE'
  | 'READ_FAILED'
  | 'WRITE_FAILED';

export interface ReviewApi {
  /** Earlier completed reviews of the paper, oldest first. Unreadable records are skipped. */
  reviewList: (paper: ReviewPaperRef) => Promise<IpcResult<ReviewRecord[]>>;
  /** Validates and stores a completed review; nothing is written when validation fails. */
  reviewSave: (request: ReviewSaveRequest) => Promise<IpcResult<ReviewRecord>>;
  /** Checks that the paper exists inside the project and can be read, before a review starts. */
  reviewPaperCheck: (paper: ReviewPaperRef) => Promise<IpcResult<ReviewPaperInfo>>;
}
