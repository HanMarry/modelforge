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

/** Search terms of the anonymity check (18.6), as entered by the user. */
export interface AnonymityTerms {
  /** Member names, one per entry. */
  names: string[];
  school: string;
  team: string;
}

export interface PaperCheckRequest {
  /** Project root; every path below is resolved inside it. */
  projectDir: string;
  /** Project-relative path of the paper's main source file. */
  paperPath: string;
  /** Verify references online through Crossref (18.4); the 60 s limit of 18.8 excludes it. */
  online: boolean;
  /**
   * Present when the competition requires anonymity (18.6); the report then has an `anonymity`
   * item. Absent means the rules do not require it and the item is left out.
   */
  anonymity?: AnonymityTerms;
}

/** Stable code of one finding; the panel turns it and `params` into localized text. */
export type PaperCheckIssueCode =
  /** params: `number`. */
  | 'question-uncovered'
  /** params: `paperValue`, `tableValue`, `runId`, `table`. */
  | 'number-mismatch'
  /** params: `missing`, a comma-separated list of `x-label`, `y-label`, `x-unit`, `y-unit`. */
  | 'figure-missing'
  /** params: `reason`, one of `FigureUnreadableReason` (listed as "无法检查", 18.3). */
  | 'figure-unreadable'
  /** params: `index`, `title`, `reason`, one of `ReferenceUnverifiedReason`. */
  | 'reference-unverified'
  /** params: `index`, `title` ("未核实（网络原因）", 18.4). */
  | 'reference-network'
  /** params: none; `file` is the source that is newer than the PDF. */
  | 'pdf-stale'
  /** params: `pdf`. */
  | 'pdf-missing'
  /** params: `term`, `field` (`name`, `school` or `team`). */
  | 'anonymity-hit'
  /** params: none; `file` is a PDF whose text layer could not be read. */
  | 'pdf-unreadable';

/** One problem found by a check; the location lets the panel jump to the file (18.8). */
export interface PaperCheckIssue {
  code: PaperCheckIssueCode;
  params: Record<string, string | number>;
  /** Plain Chinese description, for logs and as a fallback when the code is unknown. */
  message: string;
  /** Project-relative path. */
  file?: string;
  /** 1-based line in a source file. */
  line?: number;
  /** 1-based page in a PDF. */
  page?: number;
}

/** Why a check could not run or could not finish (18.7). */
export type PaperCheckReason =
  | 'missing-problem-statement'
  | 'missing-paper-source'
  | 'missing-question-numbers'
  | 'missing-run-records'
  | 'no-result-tables'
  | 'no-linked-values'
  | 'no-figures'
  | 'figures-unreadable'
  | 'offline'
  | 'no-references'
  | 'network-unavailable'
  | 'missing-profile'
  | 'timed-out'
  | 'check-failed';

export interface PaperCheckItem {
  id: PaperCheckItemId;
  verdict: PaperCheckVerdict;
  issues: PaperCheckIssue[];
  /** Set when `verdict` is `无法执行`: the missing input or what stopped the check (18.7). */
  reason?: PaperCheckReason;
  /** Extra English detail for `check-failed`, already free of secrets. */
  reasonDetail?: string;
  /** Issues left out because the list was capped. */
  omittedIssues?: number;
}

export interface PaperCheckReport {
  items: PaperCheckItem[];
  /** ISO 8601 time the report was produced. */
  finishedAt: string;
}

export interface PaperCheckApi {
  paperCheckRun: (request: PaperCheckRequest) => Promise<IpcResult<PaperCheckReport>>;
}
