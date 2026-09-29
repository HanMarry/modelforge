/**
 * Run_Record (spec mathmodel-parity-and-beyond, requirement 16): one execution of computation
 * code inside a Project, stored as `<project>/.modelforge/runs/<runId>.json`.
 *
 * The contract is `schemas/run-record.schema.json`. The kernel writes records through
 * `crates/goose-run-record/src/run_record.rs` (same field names); the desktop reads them with
 * `utils/runRecord.ts`.
 */

export type RunFailure = '非零退出码' | '超时' | '用户取消';

export interface RunFileHash {
  /** Project-relative path with `/` separators. */
  path: string;
  /** Lowercase hexadecimal SHA-256, 64 characters. */
  sha256: string;
}

export interface RunConfig {
  provider: string;
  model: string;
  runtime: string;
}

export interface RunDependency {
  name: string;
  version: string;
}

export interface RunRecord {
  schemaVersion: 1;
  /** `YYYYMMDDTHHMMSSmmm-<6 random [0-9a-z]>`, unique inside the Project. */
  runId: string;
  /** At most 1000, in discovery order. */
  inputs: RunFileHash[];
  /** True when more than 1000 inputs were found; `inputs` then holds exactly 1000. */
  inputsTruncated: boolean;
  code: RunFileHash;
  config: RunConfig;
  command: string;
  dependencies: RunDependency[];
  /** The seed as given, or `未设置`. */
  seed: string;
  /** `null` after a timeout or a user cancellation. */
  exitCode: number | null;
  /** `null` exactly when `exitCode` is 0. */
  failure: RunFailure | null;
  /** ISO 8601 with milliseconds and offset, for example `2026-09-20T10:15:30.123+08:00`. */
  startedAt: string;
  endedAt: string;
  /** At most 1000. */
  outputs: RunFileHash[];
  outputsTruncated: boolean;
}

/** Why a Run_Record file cannot be used as evidence for any Artifact (requirement 16.5). */
export interface RunRecordProblem {
  path: string;
  /** Required fields that are absent, as dotted paths (`code.sha256`, `inputs[3].path`). */
  missing: string[];
  /** Fields that are present but have the wrong type or value. */
  invalid: string[];
  /** 1-based position of the first JSON syntax error; `column` counts UTF-16 code units. */
  parseErrorAt?: { line: number; column: number };
}

/** Valid Run_Records of one Project, keyed by `runId`. */
export type RunRecordMap = ReadonlyMap<string, RunRecord>;

/**
 * Current state of one Project file: its lowercase hexadecimal SHA-256, or `FILE_HASH_MISSING` /
 * `FILE_HASH_UNREADABLE` from `utils/runRecord.ts`. A SHA-256 never equals either marker.
 */
export type FileHashValue = string;

/**
 * Current hashes of Project files, keyed by Project-relative path (design C2). Computed by the
 * I/O layer and shared by staleness detection, run comparison and resume planning.
 */
export type FileHashSnapshot = ReadonlyMap<string, FileHashValue>;

export type ParseRunRecordResult =
  | { ok: true; record: RunRecord }
  | ({ ok: false } & RunRecordProblem);
