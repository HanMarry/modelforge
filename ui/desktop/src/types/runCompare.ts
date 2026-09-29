/**
 * Run comparison (spec mathmodel-parity-and-beyond, requirement 21): the optional method,
 * parameters and metrics of a Run_Record, and the side-by-side table built from two records.
 *
 * A run's metadata lives next to its record as `<project>/.modelforge/runs/<runId>.meta.json`,
 * written by the execution tool or by the user's script, for example
 *
 *   { "method": "遗传算法", "params": { "population": 200 }, "metrics": { "rmse": 0.012 } }
 *
 * Every field is optional and `null` reads as absent. Parameter values are any JSON value;
 * metric values are numbers. Parsed by `utils/runCompare.ts`.
 */

import type { RunRecord } from './runRecord';

/** A JSON value as `JSON.parse` returns it. */
export type RunMetaJson =
  | null
  | boolean
  | number
  | string
  | RunMetaJson[]
  | { [key: string]: RunMetaJson };

export interface RunParam {
  name: string;
  value: RunMetaJson;
}

export interface RunMetric {
  name: string;
  /** Always finite. */
  value: number;
}

export interface RunMeta {
  /** Method name shown in the comparison header; `null` when not given. */
  method: string | null;
  /**
   * In file order, except that integer-like names come first in ascending order, as JavaScript
   * objects keep them; names are unique.
   */
  params: RunParam[];
  /** Same order as `params`; names are unique. */
  metrics: RunMetric[];
}

/** Why a `.meta.json` file cannot be used. Every field of the file is optional. */
export interface RunMetaProblem {
  path: string;
  /** Fields with the wrong type or value, as dotted paths (`params`, `metrics.rmse`). */
  invalid: string[];
  /** 1-based position of the first JSON syntax error; `column` counts UTF-16 code units. */
  parseErrorAt?: { line: number; column: number };
}

export type ParseRunMetaResult = { ok: true; meta: RunMeta } | ({ ok: false } & RunMetaProblem);

/** One side of a comparison. */
export interface ComparedRun {
  record: RunRecord;
  /** From `parseRunMeta`; `null` when the file is absent or invalid. */
  meta: RunMeta | null;
}

export type CompareRowKind = 'param' | 'metric';

export interface CompareCell {
  /** False when this run has no entry of the row's name. */
  present: boolean;
  /** Display text of the value, or `—` when the entry is absent. */
  text: string;
}

export interface CompareRow {
  kind: CompareRowKind;
  name: string;
  a: CompareCell;
  b: CompareCell;
  /** True exactly when both runs have the entry and the values differ (requirement 21.1). */
  highlight: boolean;
}

export interface RunComparison {
  /** Parameters first, then metrics; within each, names of `a` in order, then those only in `b`. */
  rows: CompareRow[];
  /**
   * Input paths whose hashes differ or that only one run read (requirement 21.2), in the input
   * order of `a`, then those only in `b`. Empty when the inputs agree.
   */
  inputMismatch: string[];
}
