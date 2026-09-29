/**
 * Run comparison (spec mathmodel-parity-and-beyond, requirement 21.1, 21.2): reads the optional
 * `.modelforge/runs/<runId>.meta.json` of a Run_Record and builds the side-by-side table of two
 * records: parameters and metrics merged by name, a `—` cell for an entry only one run has, a
 * highlight where both have it with different values, and the input files the runs disagree on.
 *
 * Pure functions with erasable TypeScript syntax only.
 */

import type {
  CompareCell,
  CompareRow,
  CompareRowKind,
  ComparedRun,
  ParseRunMetaResult,
  RunMeta,
  RunMetaJson,
  RunMetric,
  RunParam,
  RunComparison,
} from '../types/runCompare';
import type { RunFileHash } from '../types/runRecord';
import { lineColumnAt, locateJsonSyntaxError } from './runRecord';

/** Shown in place of an entry that only the other run has (requirement 21.1). */
export const COMPARE_MISSING = '—';
/** Suffix of the metadata file next to `<runId>.json`. */
export const RUN_META_SUFFIX = '.meta.json';
/** Deepest nesting of arrays and objects accepted in a parameter value. */
export const RUN_META_MAX_DEPTH = 32;

export type RunMetaValidation = { ok: true; meta: RunMeta } | { ok: false; invalid: string[] };

type JsonObject = Record<string, unknown>;

interface NamedValue {
  name: string;
  value: RunMetaJson;
}

/** File name of the metadata of `runId`, inside `.modelforge/runs/`. */
export function runMetaFileName(runId: string): string {
  return `${runId}${RUN_META_SUFFIX}`;
}

function has(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** A JSON object: not null, not an array, not a Date, Map or other built-in. */
function isPlainObject(value: unknown): value is JsonObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]'
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A value `JSON.stringify` writes and `JSON.parse` reads back, nested at most the limit. */
function isJsonValue(value: unknown, depth: number): value is RunMetaJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (depth >= RUN_META_MAX_DEPTH) {
    return false;
  }
  if (Array.isArray(value)) {
    // Indexed loop so that holes in sparse arrays read as `undefined` and are rejected.
    for (let i = 0; i < value.length; i += 1) {
      if (!isJsonValue(value[i], depth + 1)) {
        return false;
      }
    }
    return true;
  }
  if (isPlainObject(value)) {
    return Object.keys(value).every((key) => isJsonValue(value[key], depth + 1));
  }
  return false;
}

/** Deep copy of a checked value. `Object.fromEntries` keeps a `__proto__` key as own data. */
function copyJson(value: RunMetaJson): RunMetaJson {
  if (Array.isArray(value)) {
    return value.map(copyJson);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).map((key) => [key, copyJson(value[key])]));
  }
  return value;
}

/**
 * Compact JSON with object keys sorted, so equal values give equal text whatever the key order.
 * `-0` and `0` both give `0`; any other two finite numbers give different text.
 */
function canonicalJson(value: RunMetaJson): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const members = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Display text of a parameter or metric value: strings as they are, anything else as JSON. */
export function formatMetaValue(value: RunMetaJson): string {
  return typeof value === 'string' ? value : canonicalJson(value);
}

function readMethod(object: JsonObject, invalid: string[]): string | null | undefined {
  const value = has(object, 'method') ? object.method : null;
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    invalid.push('method');
    return undefined;
  }
  return value;
}

function readEntries<T>(
  object: JsonObject,
  field: 'params' | 'metrics',
  read: (value: unknown) => T | undefined,
  invalid: string[]
): Array<{ name: string; value: T }> | undefined {
  const value = has(object, field) ? object[field] : null;
  if (value === null || value === undefined) {
    return [];
  }
  if (!isPlainObject(value)) {
    invalid.push(field);
    return undefined;
  }
  const entries: Array<{ name: string; value: T }> = [];
  let complete = true;
  for (const name of Object.keys(value)) {
    const entry = read(value[name]);
    if (entry === undefined) {
      invalid.push(`${field}.${name}`);
      complete = false;
    } else {
      entries.push({ name, value: entry });
    }
  }
  return complete ? entries : undefined;
}

const readParamValue = (value: unknown): RunMetaJson | undefined =>
  isJsonValue(value, 0) ? copyJson(value) : undefined;

const readMetricValue = (value: unknown): number | undefined =>
  isFiniteNumber(value) ? value : undefined;

/**
 * Checks a parsed `.meta.json` value. `method` must be a string, `params` an object of JSON
 * values and `metrics` an object of finite numbers; each may be absent or `null`. Unknown fields
 * are ignored. Reports every bad field; on success returns a copy in `Object.keys` order.
 */
export function validateRunMeta(value: unknown): RunMetaValidation {
  if (!isPlainObject(value)) {
    return { ok: false, invalid: ['$'] };
  }
  const invalid: string[] = [];
  const method = readMethod(value, invalid);
  const params: RunParam[] | undefined = readEntries(value, 'params', readParamValue, invalid);
  const metrics: RunMetric[] | undefined = readEntries(value, 'metrics', readMetricValue, invalid);
  if (invalid.length > 0 || method === undefined || !params || !metrics) {
    return { ok: false, invalid };
  }
  return { ok: true, meta: { method, params, metrics } };
}

/**
 * Parses one `.meta.json` file. Invalid JSON reports the position of the first syntax error, a
 * valid document with bad fields lists them. Never throws.
 */
export function parseRunMeta(text: string, path = ''): ParseRunMetaResult {
  const errorAt = locateJsonSyntaxError(text);
  if (errorAt !== null) {
    return { ok: false, path, invalid: [], parseErrorAt: lineColumnAt(text, errorAt) };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Only reachable for input nested deeper than the engine's parser allows.
    return { ok: false, path, invalid: ['$'] };
  }
  const result = validateRunMeta(value);
  if (result.ok) {
    return result;
  }
  return { ok: false, path, invalid: result.invalid };
}

function indexByName(entries: ReadonlyArray<NamedValue>): Map<string, RunMetaJson> {
  const byName = new Map<string, RunMetaJson>();
  for (const { name, value } of entries) {
    if (!byName.has(name)) {
      byName.set(name, value);
    }
  }
  return byName;
}

function cellOf(byName: Map<string, RunMetaJson>, name: string): CompareCell {
  return byName.has(name)
    ? { present: true, text: formatMetaValue(byName.get(name) as RunMetaJson) }
    : { present: false, text: COMPARE_MISSING };
}

/** Names of `left` in order, then the names only `right` has, in their order. */
function mergedNames<V>(left: Map<string, V>, right: Map<string, V>): string[] {
  return [...left.keys(), ...[...right.keys()].filter((name) => !left.has(name))];
}

function mergeEntries(
  kind: CompareRowKind,
  a: ReadonlyArray<NamedValue>,
  b: ReadonlyArray<NamedValue>
): CompareRow[] {
  const left = indexByName(a);
  const right = indexByName(b);
  return mergedNames(left, right).map((name) => ({
    kind,
    name,
    a: cellOf(left, name),
    b: cellOf(right, name),
    highlight:
      left.has(name) &&
      right.has(name) &&
      canonicalJson(left.get(name) as RunMetaJson) !==
        canonicalJson(right.get(name) as RunMetaJson),
  }));
}

/** Recorded hashes of each input path; a path listed twice keeps every hash. */
function hashesByPath(inputs: ReadonlyArray<RunFileHash>): Map<string, Set<string>> {
  const byPath = new Map<string, Set<string>>();
  for (const { path, sha256 } of inputs) {
    const hashes = byPath.get(path);
    if (hashes) {
      hashes.add(sha256);
    } else {
      byPath.set(path, new Set([sha256]));
    }
  }
  return byPath;
}

function sameHashes(left: Set<string> | undefined, right: Set<string> | undefined): boolean {
  if (!left || !right || left.size !== right.size) {
    return false;
  }
  for (const hash of left) {
    if (!right.has(hash)) {
      return false;
    }
  }
  return true;
}

/**
 * Side-by-side table of two runs (requirement 21.1, 21.2). Rows are the union of parameter names
 * and the union of metric names; a run without metadata has every cell absent. Values compare as
 * JSON, so `1` and `1.0` or objects with reordered keys are equal, while `1` and `"1"` differ.
 * `inputMismatch` compares input files by path only; the code file is not an input.
 */
export function compareRuns(a: ComparedRun, b: ComparedRun): RunComparison {
  const rows = [
    ...mergeEntries('param', a.meta?.params ?? [], b.meta?.params ?? []),
    ...mergeEntries('metric', a.meta?.metrics ?? [], b.meta?.metrics ?? []),
  ];
  const inputsA = hashesByPath(a.record.inputs);
  const inputsB = hashesByPath(b.record.inputs);
  const inputMismatch = mergedNames(inputsA, inputsB).filter(
    (path) => !sameHashes(inputsA.get(path), inputsB.get(path))
  );
  return { rows, inputMismatch };
}
