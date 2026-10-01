/**
 * Artifact_Status (spec mathmodel-parity-and-beyond, requirement 17): the evidence state of each
 * result file of a Project, stored as `<project>/.modelforge/artifacts.json`.
 *
 * The transitions are pure functions in `utils/artifactStatus.ts`; they read Run_Records
 * (`types/runRecord.ts`) and never write them.
 */

import type { RunFailure } from './runRecord';

/** The seven values of the glossary (requirement 17.1). */
export type ArtifactStatus =
  | '未开始'
  | '已发现文件'
  | '执行中'
  | '执行失败'
  | '已生成'
  | '已验证'
  | '已过期';

/**
 * Why an Artifact is out of date (requirement 16.8, 17.4, 17.8, 22.5). `output-modified` means
 * the Artifact file itself no longer matches the hash its run recorded, that is, it was changed
 * outside ModelForge. `record-missing` names the Run_Record of the Artifact's run,
 * `.modelforge/runs/<runId>.json`, when that run left no usable record: the record is absent or
 * cannot be parsed, so nothing traces what the run wrote. When that record turns up, it is
 * applied to the Artifact like the record of a run that just ended.
 */
export type StaleReasonKind =
  | 'input-changed'
  | 'code-changed'
  | 'output-modified'
  | 'missing'
  | 'unreadable'
  | 'record-missing';

export interface StaleReason {
  kind: StaleReasonKind;
  /** Project-relative path of the file that caused it. */
  path: string;
}

export interface ArtifactVerification {
  /** ISO 8601 with second precision and offset, for example `2026-09-20T10:20:05+08:00`. */
  verifiedAt: string;
  /** The run whose output the user checked. */
  runId: string;
}

export interface ArtifactEntry {
  /** Project-relative path with `/` separators; equals the key in `ArtifactIndex.entries`. */
  path: string;
  status: ArtifactStatus;
  /**
   * The run that produced the current status: the generating run for `已生成`, `已验证` and
   * `已过期`, the failed run for `执行失败`, the pending run for `执行中`, otherwise `null`.
   */
  runId: string | null;
  /** Failure kind of that run; set exactly for `执行失败` (requirement 16.3). */
  failure: RunFailure | null;
  /** Kept when the Artifact goes out of date, cleared by the next run (requirement 17.9). */
  verification: ArtifactVerification | null;
  /** Non-empty only for `已过期`. */
  staleReasons: StaleReason[];
}

export interface ArtifactIndex {
  schemaVersion: 1;
  /** Keyed by Project-relative path. */
  entries: Record<string, ArtifactEntry>;
}

/** Why `markVerified` refused (requirement 17.7). */
export type VerifyRejectReason =
  /** The index has no entry for the path. */
  | 'not-tracked'
  /** The status is not `已生成`. */
  | 'not-generated'
  /** The entry names no run, or its Run_Record is missing or could not be parsed. */
  | 'run-record-missing'
  /** The associated Run_Record's exit code is not 0. */
  | 'run-failed';

/** On rejection `index` is the input index itself, unchanged. */
export type MarkVerifiedResult =
  | { ok: true; index: ArtifactIndex }
  | { ok: false; index: ArtifactIndex; reason: VerifyRejectReason };
