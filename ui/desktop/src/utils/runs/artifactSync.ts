/**
 * Pure helpers of the Artifact_Status I/O layer (spec mathmodel-parity-and-beyond, task 22.8):
 * the `.modelforge/artifacts.json` format, applying the Run_Records an index has not taken in
 * yet, the file scan that sets 未开始 and 已发现文件, and the per-file comparison the Project
 * panel shows. The status transitions themselves are in `../artifactStatus.ts`; file access is in
 * `artifactStore.ts`.
 */

import type {
  ArtifactEntry,
  ArtifactIndex,
  ArtifactStatus,
  ArtifactVerification,
  StaleReason,
  StaleReasonKind,
} from '../../types/artifactStatus';
import type { FileHashSnapshot, RunFailure, RunRecord, RunRecordMap } from '../../types/runRecord';
import type { ArtifactFileCheck, ArtifactFileRole } from '../../types/runsApi';
import {
  ARTIFACT_INDEX_SCHEMA_VERSION,
  STALE_REASON_KINDS,
  applyRunFinished,
  emptyArtifactIndex,
  getArtifactEntry,
  isArtifactStatus,
} from '../artifactStatus';
import {
  FILE_HASH_MISSING,
  FILE_HASH_UNREADABLE,
  RUN_FAILURES,
  isProjectRelativePath,
  isRunId,
} from '../runRecord';

/** `YYYYMMDDTHHMMSSmmm`, the start time at the head of every run id. */
const RUN_ID_TIME_LENGTH = 18;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** Defines an own property; plain assignment to `__proto__` would replace the prototype. */
function defineEntry(entries: Record<string, ArtifactEntry>, path: string, entry: ArtifactEntry) {
  Object.defineProperty(entries, path, {
    value: entry,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function discovered(path: string): ArtifactEntry {
  return {
    path,
    status: '已发现文件',
    runId: null,
    failure: null,
    verification: null,
    staleReasons: [],
  };
}

function readVerification(value: unknown): ArtifactVerification | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isJsonObject(value) || typeof value.verifiedAt !== 'string' || !isRunId(value.runId)) {
    return undefined;
  }
  return { verifiedAt: value.verifiedAt as string, runId: value.runId as string };
}

function readStaleReasons(value: unknown): StaleReason[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const reasons: StaleReason[] = [];
  for (const item of value) {
    if (
      !isJsonObject(item) ||
      !(STALE_REASON_KINDS as readonly unknown[]).includes(item.kind) ||
      !isProjectRelativePath(item.path)
    ) {
      return undefined;
    }
    reasons.push({ kind: item.kind as StaleReasonKind, path: item.path as string });
  }
  return reasons;
}

/** One stored entry, or `undefined` when it does not have the shape of an `ArtifactEntry`. */
function readEntry(key: string, value: unknown): ArtifactEntry | undefined {
  if (!isJsonObject(value) || value.path !== key || !isProjectRelativePath(key)) {
    return undefined;
  }
  const runId = value.runId;
  const failure = value.failure;
  const verification = readVerification(value.verification);
  const staleReasons = readStaleReasons(value.staleReasons);
  if (
    !isArtifactStatus(value.status) ||
    !(runId === null || isRunId(runId)) ||
    !(failure === null || (RUN_FAILURES as readonly unknown[]).includes(failure)) ||
    verification === undefined ||
    staleReasons === undefined
  ) {
    return undefined;
  }
  return {
    path: key,
    status: value.status as ArtifactStatus,
    runId: runId as string | null,
    failure: failure as RunFailure | null,
    verification,
    staleReasons,
  };
}

/**
 * Reads `.modelforge/artifacts.json`. Returns `null` when the text is not JSON or not an index of
 * schema version 1; entries that do not have the shape of an `ArtifactEntry` are dropped and the
 * others kept.
 */
export function parseArtifactIndex(text: string): ArtifactIndex | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !isJsonObject(value) ||
    value.schemaVersion !== ARTIFACT_INDEX_SCHEMA_VERSION ||
    !isJsonObject(value.entries)
  ) {
    return null;
  }
  const stored = value.entries;
  const index = emptyArtifactIndex();
  for (const key of Object.keys(stored)) {
    const entry = readEntry(key, stored[key]);
    if (entry) {
      defineEntry(index.entries, key, entry);
    }
  }
  return index;
}

/** Pretty-printed JSON with a trailing newline and the entries in path order. */
export function serializeArtifactIndex(index: ArtifactIndex): string {
  const entries: Record<string, ArtifactEntry> = {};
  for (const key of Object.keys(index.entries).sort()) {
    const entry = index.entries[key];
    defineEntry(entries, key, {
      path: entry.path,
      status: entry.status,
      runId: entry.runId,
      failure: entry.failure,
      verification: entry.verification
        ? { verifiedAt: entry.verification.verifiedAt, runId: entry.verification.runId }
        : null,
      staleReasons: entry.staleReasons.map(({ kind, path }) => ({ kind, path })),
    });
  }
  return `${JSON.stringify({ schemaVersion: index.schemaVersion, entries }, null, 2)}\n`;
}

export function sameArtifactIndex(a: ArtifactIndex, b: ArtifactIndex): boolean {
  return a === b || serializeArtifactIndex(a) === serializeArtifactIndex(b);
}

/**
 * Whether `runId` is newer evidence for `entry` than what it holds. Run ids begin with their
 * start time, so they sort in the order the runs started.
 *
 * - No entry, or one without a run: yes.
 * - The run the entry already names: only while it is `执行中` (the run has just ended).
 * - An entry `执行中` for another run: yes when `runId` started no earlier. A record whose id got
 *   a new suffix on a write collision keeps the start time, so it still ends the pending run.
 * - Otherwise: yes when `runId` started later.
 */
function isNewerRun(entry: ArtifactEntry | undefined, runId: string): boolean {
  if (!entry || entry.runId === null) {
    return true;
  }
  if (entry.runId === runId) {
    return entry.status === '执行中';
  }
  if (entry.status === '执行中') {
    return runId.slice(0, RUN_ID_TIME_LENGTH) >= entry.runId.slice(0, RUN_ID_TIME_LENGTH);
  }
  return runId > entry.runId;
}

/**
 * Applies with `applyRunFinished`, oldest first, every Run_Record the index has not taken in yet
 * (requirements 16.3, 16.6, 17.9). A record only reaches the Artifacts for which it is newer
 * evidence (see `isNewerRun`), so applying the same records again changes nothing and an old
 * record found late does not overwrite the result of a later run. This is how the desktop catches
 * up on runs it heard nothing about (code mode, a separate `goose mcp modeling`, runs while it was
 * closed) and on a `runs/finished` that arrives after the rescan.
 */
export function applyNewRuns(state: ArtifactIndex, records: readonly RunRecord[]): ArtifactIndex {
  const ordered = [...records].sort((a, b) =>
    a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0
  );
  let next = state;
  for (const record of ordered) {
    const outputs = record.outputs.filter((file) =>
      isNewerRun(getArtifactEntry(next, file.path), record.runId)
    );
    const pending = Object.keys(next.entries).some((path) => {
      const entry = next.entries[path];
      return entry.status === '执行中' && entry.runId === record.runId;
    });
    if (outputs.length === 0 && !pending) {
      continue;
    }
    next = applyRunFinished(
      next,
      outputs.length === record.outputs.length ? record : { ...record, outputs }
    );
  }
  return next;
}

/**
 * The file scan (design C2: "扫描到文件"). `artifactFiles` are the result, figure and paper files
 * the scan found; `present` holds every tracked path that exists, including those. An Artifact
 * file without an entry becomes `已发现文件`, a `未开始` entry whose file appeared too, and a
 * `已发现文件` entry whose file is gone is dropped, since the file was all it stood for. Entries
 * with run evidence are left to the run transitions and to `detectStaleness`.
 */
export function syncDiscoveredFiles(
  state: ArtifactIndex,
  artifactFiles: readonly string[],
  present: ReadonlySet<string>
): ArtifactIndex {
  const entries = { ...state.entries };
  let changed = false;
  for (const path of Object.keys(state.entries)) {
    const entry = state.entries[path];
    if (entry.status === '已发现文件' && !present.has(path)) {
      delete entries[path];
      changed = true;
    } else if (entry.status === '未开始' && present.has(path)) {
      defineEntry(entries, path, discovered(path));
      changed = true;
    }
  }
  for (const path of artifactFiles) {
    if (isProjectRelativePath(path) && !hasOwn(entries, path)) {
      defineEntry(entries, path, discovered(path));
      changed = true;
    }
  }
  return changed ? { ...state, entries } : state;
}

/** Entries with only a file behind them, whose existence the scan decides. */
export function fileOnlyPaths(state: ArtifactIndex): string[] {
  return Object.keys(state.entries).filter((path) => {
    const status = state.entries[path].status;
    return status === '未开始' || status === '已发现文件';
  });
}

/**
 * The files `detectStaleness` compares: every `已生成` or `已验证` Artifact whose Run_Record is
 * in `runs`, with the code and inputs of that record.
 */
export function staleCheckPaths(state: ArtifactIndex, runs: RunRecordMap): string[] {
  const paths = new Set<string>();
  const covered = new Set<string>();
  for (const path of Object.keys(state.entries)) {
    const entry = state.entries[path];
    if (entry.status !== '已生成' && entry.status !== '已验证') {
      continue;
    }
    const run = entry.runId === null ? undefined : runs.get(entry.runId);
    if (!run) {
      continue;
    }
    paths.add(path);
    if (!covered.has(run.runId)) {
      covered.add(run.runId);
      paths.add(run.code.path);
      for (const input of run.inputs) {
        paths.add(input.path);
      }
    }
  }
  return [...paths];
}

/** The files `artifactFileChecks` needs hashed. */
export function inspectionPaths(path: string, run: RunRecord): string[] {
  return [...new Set([run.code.path, ...run.inputs.map((input) => input.path), path])];
}

/**
 * The code, the inputs and the Artifact at `path`, each with its recorded and current hash
 * (requirement 17.5). The comparison is the one `findStaleReasons` in `../artifactStatus.ts`
 * makes: a file the run also wrote is compared with its output hash, and a path listed twice
 * appears once (as the Artifact, then as the code, then as its first input).
 */
export function artifactFileChecks(
  path: string,
  run: RunRecord,
  hashes: FileHashSnapshot
): ArtifactFileCheck[] {
  const written = new Map<string, string>();
  for (const file of run.outputs) {
    if (!written.has(file.path)) {
      written.set(file.path, file.sha256);
    }
  }
  const checks: ArtifactFileCheck[] = [];
  const check = (file: string, role: ArtifactFileRole, recorded: string | null) => {
    const current = hashes.get(file) ?? FILE_HASH_MISSING;
    let state: ArtifactFileCheck['state'];
    if (current === FILE_HASH_MISSING) {
      state = 'missing';
    } else if (current === FILE_HASH_UNREADABLE) {
      state = 'unreadable';
    } else if (recorded === null) {
      state = 'unrecorded';
    } else {
      state = current === recorded ? 'match' : 'changed';
    }
    checks.push({ path: file, role, recorded, current, state });
  };

  const seen = new Set<string>([path]);
  if (run.code.path !== path) {
    seen.add(run.code.path);
    check(run.code.path, 'code', written.get(run.code.path) ?? run.code.sha256);
  }
  for (const input of run.inputs) {
    if (!seen.has(input.path)) {
      seen.add(input.path);
      check(input.path, 'input', written.get(input.path) ?? input.sha256);
    }
  }
  check(path, 'artifact', written.get(path) ?? null);
  return checks;
}
