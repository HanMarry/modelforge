/**
 * Renderer API for the paper delivery check (requirement 18, tasks 23.3–23.10). Implemented by
 * `bridges/paperCheckBridge.ts`, served by `utils/paperCheck/paperCheckIpc.ts`; owned by
 * `mp/s2-c1-paper`.
 */
import type { IpcResult } from '../utils/ipcResult';
import type { PaperCheckVerdict } from '../utils/paperCheck/common';

export type PaperCheckItemId =
  | 'question-coverage'
  | 'number-consistency'
  | 'figure-labels'
  | 'references'
  | 'pdf-freshness'
  | 'anonymity';

export interface PaperCheckRequest {
  /** Project root; every path below is resolved inside it. */
  projectDir: string;
  /** Project-relative path of the paper's main source file. */
  paperPath: string;
  /** Verify references online through Crossref (18.4); the 60 s limit of 18.8 excludes it. */
  online: boolean;
}

/** One problem found by a check; the location lets the panel jump to the file (18.8). */
export interface PaperCheckIssue {
  message: string;
  /** Project-relative path. */
  file?: string;
  /** 1-based line in a source file. */
  line?: number;
  /** 1-based page in a PDF. */
  page?: number;
}

export interface PaperCheckItem {
  id: PaperCheckItemId;
  verdict: PaperCheckVerdict;
  issues: PaperCheckIssue[];
  /** Why the check could not run, when `verdict` is `无法执行` (18.7). */
  reason?: string;
}

export interface PaperCheckReport {
  items: PaperCheckItem[];
  /** ISO 8601 time the report was produced. */
  finishedAt: string;
}

export interface PaperCheckApi {
  paperCheckRun: (request: PaperCheckRequest) => Promise<IpcResult<PaperCheckReport>>;
}
