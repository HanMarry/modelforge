/**
 * Run_Record serialization and validation (spec mathmodel-parity-and-beyond, requirement 16.4,
 * 16.5). The contract is `schemas/run-record.schema.json`; the kernel side is
 * `crates/goose-mcp/src/modeling/run_record.rs`. Both implement the same checks and are tested
 * against `fixtures/run-record-vectors.json`.
 *
 * Pure functions without runtime imports and with erasable TypeScript syntax only, so Node scripts
 * can load this file directly.
 */

import type {
  ParseRunRecordResult,
  RunConfig,
  RunDependency,
  RunFailure,
  RunFileHash,
  RunRecord,
  RunRecordProblem,
} from '../types/runRecord';

export const RUN_RECORD_SCHEMA_VERSION = 1;
/** Inputs and outputs are each capped at this many entries (requirement 16.1). */
export const RUN_RECORD_MAX_FILES = 1000;
/** The seed value recorded when the code set no seed. */
export const SEED_UNSET = '未设置';
export const RUN_FAILURES: readonly RunFailure[] = ['非零退出码', '超时', '用户取消'];

/** `FileHashSnapshot` value for a file that does not exist. */
export const FILE_HASH_MISSING = 'missing';
/** `FileHashSnapshot` value for a file that exists but cannot be read. */
export const FILE_HASH_UNREADABLE = 'unreadable';

/** Top-level fields in the order writers emit them. `failure` is the only optional one. */
export const RUN_RECORD_FIELDS = [
  'schemaVersion',
  'runId',
  'inputs',
  'inputsTruncated',
  'code',
  'config',
  'command',
  'dependencies',
  'seed',
  'exitCode',
  'failure',
  'startedAt',
  'endedAt',
  'outputs',
  'outputsTruncated',
] as const;

export const RUN_RECORD_REQUIRED_FIELDS: readonly string[] = RUN_RECORD_FIELDS.filter(
  (field) => field !== 'failure'
);

const RUN_ID_PATTERN = /^[0-9]{8}T[0-9]{9}-[0-9a-z]{6}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})\.[0-9]{3}(?:Z|[+-]([0-9]{2}):([0-9]{2}))$/;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

type JsonObject = Record<string, unknown>;

interface Issues {
  missing: string[];
  invalid: string[];
}

export type RunRecordValidation =
  | { ok: true; record: RunRecord }
  | { ok: false; missing: string[]; invalid: string[] };

export interface RunRecordFile {
  /** Path reported back in problems, normally `.modelforge/runs/<runId>.json`. */
  path: string;
  text: string;
}

export interface LoadedRunRecords {
  /** Valid records in input order. */
  records: Array<{ path: string; record: RunRecord }>;
  /** Files that cannot back any Artifact, in input order. */
  problems: RunRecordProblem[];
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function has(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function isRunId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value);
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

/**
 * A path that stays inside the Project: not absolute, no drive letter, no NUL and no `..`
 * segment. Backslashes are legal file name characters on POSIX, so they are allowed, but they
 * count as separators when looking for `..`.
 */
export function isProjectRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    return false;
  }
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)) {
    return false;
  }
  return !value.split(/[\\/]/).includes('..');
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** ISO 8601 with exactly three fractional digits and an offset, checked field by field. */
export function isRunTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

function isExitCode(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= INT32_MIN &&
      value <= INT32_MAX)
  );
}

function isRunFailure(value: unknown): value is RunFailure {
  return typeof value === 'string' && (RUN_FAILURES as readonly string[]).includes(value);
}

function readString(object: JsonObject, key: string, where: string, issues: Issues) {
  if (!has(object, key)) {
    issues.missing.push(where);
    return undefined;
  }
  const value = object[key];
  if (typeof value !== 'string') {
    issues.invalid.push(where);
    return undefined;
  }
  return value;
}

function readFileHash(value: unknown, where: string, issues: Issues): RunFileHash | undefined {
  if (!isJsonObject(value)) {
    issues.invalid.push(where);
    return undefined;
  }
  let path: string | undefined;
  if (!has(value, 'path')) {
    issues.missing.push(`${where}.path`);
  } else if (isProjectRelativePath(value.path)) {
    path = value.path;
  } else {
    issues.invalid.push(`${where}.path`);
  }
  let sha256: string | undefined;
  if (!has(value, 'sha256')) {
    issues.missing.push(`${where}.sha256`);
  } else if (isSha256(value.sha256)) {
    sha256 = value.sha256;
  } else {
    issues.invalid.push(`${where}.sha256`);
  }
  return path !== undefined && sha256 !== undefined ? { path, sha256 } : undefined;
}

function readFileList(value: unknown, where: string, issues: Issues): RunFileHash[] | undefined {
  if (!Array.isArray(value) || value.length > RUN_RECORD_MAX_FILES) {
    issues.invalid.push(where);
    return undefined;
  }
  const entries: RunFileHash[] = [];
  let complete = true;
  value.forEach((item, index) => {
    const entry = readFileHash(item, `${where}[${index}]`, issues);
    if (entry) {
      entries.push(entry);
    } else {
      complete = false;
    }
  });
  return complete ? entries : undefined;
}

function readConfig(value: unknown, issues: Issues): RunConfig | undefined {
  if (!isJsonObject(value)) {
    issues.invalid.push('config');
    return undefined;
  }
  const provider = readString(value, 'provider', 'config.provider', issues);
  const model = readString(value, 'model', 'config.model', issues);
  const runtime = readString(value, 'runtime', 'config.runtime', issues);
  return provider !== undefined && model !== undefined && runtime !== undefined
    ? { provider, model, runtime }
    : undefined;
}

function readDependencies(value: unknown, issues: Issues): RunDependency[] | undefined {
  if (!Array.isArray(value)) {
    issues.invalid.push('dependencies');
    return undefined;
  }
  const dependencies: RunDependency[] = [];
  let complete = true;
  value.forEach((item, index) => {
    const where = `dependencies[${index}]`;
    if (!isJsonObject(item)) {
      issues.invalid.push(where);
      complete = false;
      return;
    }
    const name = readString(item, 'name', `${where}.name`, issues);
    const version = readString(item, 'version', `${where}.version`, issues);
    if (name !== undefined && version !== undefined) {
      dependencies.push({ name, version });
    } else {
      complete = false;
    }
  });
  return complete ? dependencies : undefined;
}

/**
 * Checks a parsed value against the Run_Record contract. Reports every absent required field in
 * `missing` and every present field with a wrong type or value in `invalid`; on success returns a
 * copy that holds exactly the known fields, with a missing `failure` read as `null`.
 */
export function validateRunRecord(value: unknown): RunRecordValidation {
  if (!isJsonObject(value)) {
    return { ok: false, missing: [], invalid: ['$'] };
  }
  const object: JsonObject = value;
  const issues: Issues = { missing: [], invalid: [] };
  for (const field of RUN_RECORD_REQUIRED_FIELDS) {
    if (!has(object, field)) {
      issues.missing.push(field);
    }
  }
  const present = (field: string) => has(object, field);
  const reject = (field: string) => {
    issues.invalid.push(field);
  };

  if (present('schemaVersion') && value.schemaVersion !== RUN_RECORD_SCHEMA_VERSION) {
    reject('schemaVersion');
  }
  if (present('runId') && !isRunId(value.runId)) {
    reject('runId');
  }
  const inputs = present('inputs') ? readFileList(value.inputs, 'inputs', issues) : undefined;
  if (present('inputsTruncated') && typeof value.inputsTruncated !== 'boolean') {
    reject('inputsTruncated');
  }
  const code = present('code') ? readFileHash(value.code, 'code', issues) : undefined;
  const config = present('config') ? readConfig(value.config, issues) : undefined;
  if (present('command') && typeof value.command !== 'string') {
    reject('command');
  }
  const dependencies = present('dependencies')
    ? readDependencies(value.dependencies, issues)
    : undefined;
  if (present('seed') && typeof value.seed !== 'string') {
    reject('seed');
  }
  const exitCodeValid = present('exitCode') && isExitCode(value.exitCode);
  if (present('exitCode') && !exitCodeValid) {
    reject('exitCode');
  }
  const failure = present('failure') ? value.failure : null;
  const failureValid = failure === null || isRunFailure(failure);
  if (!failureValid) {
    reject('failure');
  }
  if (present('startedAt') && !isRunTimestamp(value.startedAt)) {
    reject('startedAt');
  }
  if (present('endedAt') && !isRunTimestamp(value.endedAt)) {
    reject('endedAt');
  }
  const outputs = present('outputs') ? readFileList(value.outputs, 'outputs', issues) : undefined;
  if (present('outputsTruncated') && typeof value.outputsTruncated !== 'boolean') {
    reject('outputsTruncated');
  }

  // A truncated list holds exactly the cap (design C1: "截断到 1000 项并记录 truncated").
  if (inputs && value.inputsTruncated === true && inputs.length !== RUN_RECORD_MAX_FILES) {
    reject('inputsTruncated');
  }
  if (outputs && value.outputsTruncated === true && outputs.length !== RUN_RECORD_MAX_FILES) {
    reject('outputsTruncated');
  }
  // The exit code and the failure kind describe the same outcome and must agree.
  if (exitCodeValid && failureValid) {
    const exitCode = value.exitCode as number | null;
    if (failure === null && exitCode !== 0) {
      reject('failure');
    } else if (failure === '非零退出码' && (exitCode === null || exitCode === 0)) {
      reject('exitCode');
    } else if ((failure === '超时' || failure === '用户取消') && exitCode !== null) {
      reject('exitCode');
    }
  }

  if (
    issues.missing.length > 0 ||
    issues.invalid.length > 0 ||
    !inputs ||
    !code ||
    !config ||
    !dependencies ||
    !outputs
  ) {
    return { ok: false, missing: issues.missing, invalid: issues.invalid };
  }
  return {
    ok: true,
    record: {
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      runId: value.runId as string,
      inputs,
      inputsTruncated: value.inputsTruncated as boolean,
      code,
      config,
      command: value.command as string,
      dependencies,
      seed: value.seed as string,
      exitCode: value.exitCode as number | null,
      failure: failure as RunFailure | null,
      startedAt: value.startedAt as string,
      endedAt: value.endedAt as string,
      outputs,
      outputsTruncated: value.outputsTruncated as boolean,
    },
  };
}

/**
 * Pretty-printed JSON with a trailing newline and the fields in schema order, the same layout
 * the kernel writes with `serde_json::to_string_pretty`. Unknown properties are dropped.
 */
export function serializeRunRecord(record: RunRecord): string {
  const fileHash = ({ path, sha256 }: RunFileHash) => ({ path, sha256 });
  const ordered = {
    schemaVersion: record.schemaVersion,
    runId: record.runId,
    inputs: record.inputs.map(fileHash),
    inputsTruncated: record.inputsTruncated,
    code: fileHash(record.code),
    config: {
      provider: record.config.provider,
      model: record.config.model,
      runtime: record.config.runtime,
    },
    command: record.command,
    dependencies: record.dependencies.map(({ name, version }) => ({ name, version })),
    seed: record.seed,
    exitCode: record.exitCode,
    failure: record.failure ?? null,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    outputs: record.outputs.map(fileHash),
    outputsTruncated: record.outputsTruncated,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

// --- JSON syntax error location --------------------------------------------------------------

type ScanResult = { ok: true; end: number } | { ok: false; at: number };

const JSON_WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
const SIMPLE_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);

function isDigit(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0x30 && code <= 0x39;
}

function isHexDigit(text: string, index: number): boolean {
  return /^[0-9a-fA-F]$/.test(text.charAt(index));
}

function skipWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length && JSON_WHITESPACE.has(text.charCodeAt(i))) {
    i += 1;
  }
  return i;
}

function scanString(text: string, start: number): ScanResult {
  let i = start + 1;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 0x22) {
      return { ok: true, end: i + 1 };
    }
    if (code < 0x20) {
      return { ok: false, at: i };
    }
    if (code === 0x5c) {
      i += 1;
      if (i >= text.length) {
        break;
      }
      const escape = text.charAt(i);
      if (escape === 'u') {
        for (let k = 1; k <= 4; k += 1) {
          if (i + k >= text.length) {
            return { ok: false, at: text.length };
          }
          if (!isHexDigit(text, i + k)) {
            return { ok: false, at: i + k };
          }
        }
        i += 5;
        continue;
      }
      if (!SIMPLE_ESCAPES.has(escape)) {
        return { ok: false, at: i };
      }
    }
    i += 1;
  }
  return { ok: false, at: text.length };
}

function scanDigits(text: string, start: number): ScanResult {
  if (start >= text.length) {
    return { ok: false, at: text.length };
  }
  if (!isDigit(text, start)) {
    return { ok: false, at: start };
  }
  let i = start;
  while (i < text.length && isDigit(text, i)) {
    i += 1;
  }
  return { ok: true, end: i };
}

function scanNumber(text: string, start: number): ScanResult {
  let i = start;
  if (text.charAt(i) === '-') {
    i += 1;
  }
  if (text.charAt(i) === '0') {
    i += 1;
  } else {
    const integer = scanDigits(text, i);
    if (!integer.ok) {
      return integer;
    }
    i = integer.end;
  }
  if (text.charAt(i) === '.') {
    const fraction = scanDigits(text, i + 1);
    if (!fraction.ok) {
      return fraction;
    }
    i = fraction.end;
  }
  if (text.charAt(i) === 'e' || text.charAt(i) === 'E') {
    i += 1;
    if (text.charAt(i) === '+' || text.charAt(i) === '-') {
      i += 1;
    }
    const exponent = scanDigits(text, i);
    if (!exponent.ok) {
      return exponent;
    }
    i = exponent.end;
  }
  return { ok: true, end: i };
}

function scanLiteral(text: string, start: number, literal: string): ScanResult {
  for (let k = 0; k < literal.length; k += 1) {
    if (start + k >= text.length) {
      return { ok: false, at: text.length };
    }
    if (text.charAt(start + k) !== literal.charAt(k)) {
      return { ok: false, at: start + k };
    }
  }
  return { ok: true, end: start + literal.length };
}

function scanScalar(text: string, start: number): ScanResult {
  const char = text.charAt(start);
  if (char === '"') {
    return scanString(text, start);
  }
  if (char === 't') {
    return scanLiteral(text, start, 'true');
  }
  if (char === 'f') {
    return scanLiteral(text, start, 'false');
  }
  if (char === 'n') {
    return scanLiteral(text, start, 'null');
  }
  if (char === '-' || isDigit(text, start)) {
    return scanNumber(text, start);
  }
  return { ok: false, at: start };
}

/**
 * UTF-16 offset of the first RFC 8259 syntax error in `text`, or `null` when it is valid JSON.
 * Error messages of `JSON.parse` differ between engines, so the position is computed here.
 * Iterative, so deeply nested input cannot overflow the stack.
 */
export function locateJsonSyntaxError(text: string): number | null {
  const stack: Array<'{' | '['> = [];
  let state: 'value' | 'valueOrEnd' | 'key' | 'keyOrEnd' | 'after' = 'value';
  let i = 0;
  for (;;) {
    i = skipWhitespace(text, i);
    if (state === 'value' || state === 'valueOrEnd') {
      if (i >= text.length) {
        return text.length;
      }
      const char = text.charAt(i);
      if (state === 'valueOrEnd' && char === ']') {
        stack.pop();
        i += 1;
        state = 'after';
      } else if (char === '{') {
        stack.push('{');
        i += 1;
        state = 'keyOrEnd';
      } else if (char === '[') {
        stack.push('[');
        i += 1;
        state = 'valueOrEnd';
      } else {
        const scalar = scanScalar(text, i);
        if (!scalar.ok) {
          return scalar.at;
        }
        i = scalar.end;
        state = 'after';
      }
      continue;
    }
    if (state === 'key' || state === 'keyOrEnd') {
      if (i >= text.length) {
        return text.length;
      }
      const char = text.charAt(i);
      if (state === 'keyOrEnd' && char === '}') {
        stack.pop();
        i += 1;
        state = 'after';
        continue;
      }
      if (char !== '"') {
        return i;
      }
      const key = scanString(text, i);
      if (!key.ok) {
        return key.at;
      }
      i = skipWhitespace(text, key.end);
      if (i >= text.length) {
        return text.length;
      }
      if (text.charAt(i) !== ':') {
        return i;
      }
      i += 1;
      state = 'value';
      continue;
    }
    // state === 'after': a complete value was just read.
    if (stack.length === 0) {
      return i >= text.length ? null : i;
    }
    if (i >= text.length) {
      return text.length;
    }
    const char = text.charAt(i);
    const open = stack[stack.length - 1];
    if (char === ',') {
      i += 1;
      state = open === '{' ? 'key' : 'value';
    } else if ((char === '}' && open === '{') || (char === ']' && open === '[')) {
      stack.pop();
      i += 1;
    } else {
      return i;
    }
  }
}

/** 1-based line and column of a UTF-16 offset; lines end at `\n`. */
export function lineColumnAt(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i += 1) {
    if (text.charCodeAt(i) === 0x0a) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/**
 * Parses one Run_Record file (requirement 16.5). Invalid JSON reports the position of the first
 * syntax error; valid JSON that breaks the contract reports every missing and invalid field.
 * Never throws and never touches the file itself.
 */
export function parseRunRecord(text: string, path = ''): ParseRunRecordResult {
  const errorAt = locateJsonSyntaxError(text);
  if (errorAt !== null) {
    return { ok: false, path, missing: [], invalid: [], parseErrorAt: lineColumnAt(text, errorAt) };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Unreachable when the scanner above is correct; still report a position.
    return { ok: false, path, missing: [], invalid: [], parseErrorAt: { line: 1, column: 1 } };
  }
  const result = validateRunRecord(value);
  if (result.ok) {
    return result;
  }
  return { ok: false, path, missing: result.missing, invalid: result.invalid };
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/**
 * Parses every Run_Record file of a Project. A bad file becomes a problem and the rest still
 * load (requirement 16.5). A record whose file name is not `<runId>.json` is reported as an
 * invalid `runId`, which also rules out two files claiming the same run.
 */
export function loadRunRecords(files: ReadonlyArray<RunRecordFile>): LoadedRunRecords {
  const loaded: LoadedRunRecords = { records: [], problems: [] };
  for (const file of files) {
    const result = parseRunRecord(file.text, file.path);
    if (!result.ok) {
      const problem: RunRecordProblem = {
        path: result.path,
        missing: result.missing,
        invalid: result.invalid,
      };
      if (result.parseErrorAt) {
        problem.parseErrorAt = result.parseErrorAt;
      }
      loaded.problems.push(problem);
    } else if (baseName(file.path) !== `${result.record.runId}.json`) {
      loaded.problems.push({ path: file.path, missing: [], invalid: ['runId'] });
    } else {
      loaded.records.push({ path: file.path, record: result.record });
    }
  }
  return loaded;
}
