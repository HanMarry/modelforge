/**
 * Artifact_Status transitions (spec mathmodel-parity-and-beyond, design C2, requirements 16.3,
 * 16.6, 16.8 and 17). Pure functions: they never mutate their arguments and never touch
 * Run_Records. Hashing, `artifacts.json` and file watching belong to the I/O layer (task 22.8).
 *
 * Transitions (design, "ArtifactIndex" state diagram):
 *   applyRunStarted   listed files                     -> 执行中
 *   applyRunFinished  outputs and 执行中 of the run     -> 已生成 (exit 0) or 执行失败
 *   markVerified      已生成                            -> 已验证
 *   detectStaleness   已生成, 已验证                     -> 已过期
 * Otherwise the file scan of the I/O layer sets 未开始 and 已发现文件.
 */

import type {
  ArtifactEntry,
  ArtifactIndex,
  ArtifactStatus,
  MarkVerifiedResult,
  StaleReason,
  StaleReasonKind,
} from '../types/artifactStatus';
import type { FileHashSnapshot, RunFailure, RunRecord, RunRecordMap } from '../types/runRecord';
import { FILE_HASH_MISSING, FILE_HASH_UNREADABLE } from './runRecord';

export const ARTIFACT_INDEX_SCHEMA_VERSION = 1;

export const ARTIFACT_STATUSES: readonly ArtifactStatus[] = [
  '未开始',
  '已发现文件',
  '执行中',
  '执行失败',
  '已生成',
  '已验证',
  '已过期',
];

export const STALE_REASON_KINDS: readonly StaleReasonKind[] = [
  'input-changed',
  'code-changed',
  'output-modified',
  'missing',
  'unreadable',
];

export function isArtifactStatus(value: unknown): value is ArtifactStatus {
  return typeof value === 'string' && (ARTIFACT_STATUSES as readonly string[]).includes(value);
}

export function emptyArtifactIndex(): ArtifactIndex {
  return { schemaVersion: ARTIFACT_INDEX_SCHEMA_VERSION, entries: {} };
}

/**
 * The entry for `path`, looked up as an own property so that file names such as `__proto__` or
 * `constructor` never resolve to `Object.prototype` members.
 */
export function getArtifactEntry(index: ArtifactIndex, path: string): ArtifactEntry | undefined {
  return Object.prototype.hasOwnProperty.call(index.entries, path)
    ? index.entries[path]
    : undefined;
}

/** Defines an own property; plain assignment to `__proto__` would replace the prototype. */
function setEntry(
  entries: Record<string, ArtifactEntry>,
  path: string,
  entry: ArtifactEntry
): void {
  Object.defineProperty(entries, path, {
    value: entry,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function withEntries(state: ArtifactIndex, entries: Record<string, ArtifactEntry>): ArtifactIndex {
  return { ...state, entries };
}

/** An entry that carries no verification and no stale reasons. */
function freshEntry(
  path: string,
  status: ArtifactStatus,
  runId: string | null,
  failure: RunFailure | null
): ArtifactEntry {
  return { path, status, runId, failure, verification: null, staleReasons: [] };
}

/**
 * Marks `paths` as `执行中` for the run `runId` that is about to start (design: "run begin").
 * Earlier evidence is dropped: the run is about to rewrite these files, and it ends either in
 * `已生成` or `执行失败`, which both clear the verification anyway.
 *
 * `applyRunFinished` finds these entries again by `runId`, so the caller must pass the id the
 * finished Run_Record will carry. The kernel allocates it when the run starts
 * (`allocate_run_id`) but may draw a new suffix on a write collision; entries left behind by
 * such a run stay `执行中` until the next run of the same files.
 */
export function applyRunStarted(
  state: ArtifactIndex,
  runId: string,
  paths: readonly string[]
): ArtifactIndex {
  const entries = { ...state.entries };
  for (const path of paths) {
    setEntry(entries, path, freshEntry(path, '执行中', runId, null));
  }
  return withEntries(state, entries);
}

/**
 * Applies a finished run (requirements 16.3, 16.6, 17.9). The Artifacts of the run are the files
 * in `run.outputs` plus the entries `applyRunStarted` marked `执行中` for `run.runId`.
 *
 * - Exit code 0: every output becomes `已生成`, linked to `run.runId`, with the previous
 *   verification and stale reasons cleared (a `已过期` Artifact regenerated this way needs a new
 *   verification). An entry marked for this run that the run did not write has no evidence left
 *   and falls back to `未开始`; the file scan promotes it to `已发现文件` when the file exists.
 * - Otherwise every Artifact of the run becomes `执行失败` with the run's failure kind, and none
 *   becomes `已生成`.
 *
 * All other entries are returned unchanged. Records loaded through `loadRunRecords` always pair
 * a non-zero or missing exit code with a failure kind; `非零退出码` is only a fallback that keeps
 * the entry well-formed for records built by hand.
 */
export function applyRunFinished(state: ArtifactIndex, run: RunRecord): ArtifactIndex {
  const outputs = new Set(run.outputs.map((file) => file.path));
  const pending = Object.keys(state.entries).filter((path) => {
    const entry = state.entries[path];
    return entry.status === '执行中' && entry.runId === run.runId;
  });
  const entries = { ...state.entries };

  if (run.exitCode === 0) {
    for (const path of pending) {
      if (!outputs.has(path)) {
        setEntry(entries, path, freshEntry(path, '未开始', null, null));
      }
    }
    for (const path of outputs) {
      setEntry(entries, path, freshEntry(path, '已生成', run.runId, null));
    }
    return withEntries(state, entries);
  }

  const failure = run.failure ?? '非零退出码';
  for (const path of new Set([...pending, ...outputs])) {
    setEntry(entries, path, freshEntry(path, '执行失败', run.runId, failure));
  }
  return withEntries(state, entries);
}

const pad = (value: number, width: number) => String(value).padStart(width, '0');

/** Local time with second precision and offset, `YYYY-MM-DDTHH:MM:SS±HH:MM` (UTC is `+00:00`). */
export function formatVerifiedAt(now: Date): string {
  const offset = -now.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const absolute = Math.abs(offset);
  return (
    `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1, 2)}-${pad(now.getDate(), 2)}` +
    `T${pad(now.getHours(), 2)}:${pad(now.getMinutes(), 2)}:${pad(now.getSeconds(), 2)}` +
    `${sign}${pad(Math.floor(absolute / 60), 2)}:${pad(absolute % 60, 2)}`
  );
}

/**
 * Marks the Artifact at `path` as `已验证` (requirements 17.2, 17.7). Succeeds exactly when its
 * status is `已生成` and the Run_Record it links to is in `runs` with exit code 0; then records
 * `now` truncated to the second and that run id.
 *
 * `runs` is not in the design signature; it is needed to check the exit code, and holds only
 * records that parsed (requirement 16.5), so an unparsable record also rejects. On rejection the
 * input index itself is returned.
 */
export function markVerified(
  state: ArtifactIndex,
  runs: RunRecordMap,
  path: string,
  now: Date
): MarkVerifiedResult {
  const entry = getArtifactEntry(state, path);
  if (!entry) {
    return { ok: false, index: state, reason: 'not-tracked' };
  }
  if (entry.status !== '已生成') {
    return { ok: false, index: state, reason: 'not-generated' };
  }
  const runId = entry.runId;
  const run = runId === null ? undefined : runs.get(runId);
  if (runId === null || !run) {
    return { ok: false, index: state, reason: 'run-record-missing' };
  }
  if (run.exitCode !== 0) {
    return { ok: false, index: state, reason: 'run-failed' };
  }
  const entries = { ...state.entries };
  setEntry(entries, path, {
    ...entry,
    status: '已验证',
    verification: { verifiedAt: formatVerifiedAt(now), runId },
  });
  return { ok: true, index: withEntries(state, entries) };
}

/**
 * Why the Artifact at `path`, generated by `run`, is out of date: one reason per file, inputs in
 * record order first, then the code, then the Artifact itself (requirements 16.8, 17.3, 17.4,
 * 17.8). An empty list means it is current.
 *
 * - A file absent from `hashes` counts as missing, like `FILE_HASH_MISSING`.
 * - A file that the run also wrote is compared with its output hash, not its input hash: a script
 *   that rewrites a file it reads, or overwrites last run's result, does not outdate its own
 *   Artifacts.
 * - The Artifact is compared with its output hash when the run recorded one (the list may be
 *   truncated at 1000); it is always reported when missing or unreadable.
 * - A path listed several times is checked once, as the Artifact, then as the code, then as the
 *   first input that names it.
 */
export function findStaleReasons(
  path: string,
  run: RunRecord,
  hashes: FileHashSnapshot
): StaleReason[] {
  const written = new Map<string, string>();
  for (const file of run.outputs) {
    if (!written.has(file.path)) {
      written.set(file.path, file.sha256);
    }
  }
  const reasons: StaleReason[] = [];
  const check = (file: string, recorded: string | undefined, changed: StaleReasonKind) => {
    const current = hashes.get(file);
    if (current === undefined || current === FILE_HASH_MISSING) {
      reasons.push({ kind: 'missing', path: file });
    } else if (current === FILE_HASH_UNREADABLE) {
      reasons.push({ kind: 'unreadable', path: file });
    } else if (recorded !== undefined && current !== recorded) {
      reasons.push({ kind: changed, path: file });
    }
  };

  const checked = new Set<string>([path, run.code.path]);
  for (const input of run.inputs) {
    if (!checked.has(input.path)) {
      checked.add(input.path);
      check(input.path, written.get(input.path) ?? input.sha256, 'input-changed');
    }
  }
  if (run.code.path !== path) {
    check(run.code.path, written.get(run.code.path) ?? run.code.sha256, 'code-changed');
  }
  check(path, written.get(path), 'output-modified');
  return reasons;
}

/**
 * Staleness check (requirements 16.8, 17.1, 17.3, 17.4, 17.6, 17.8). Every `已生成` or `已验证`
 * entry whose Run_Record is in `runs` and for which `findStaleReasons` reports anything becomes
 * `已过期` with exactly those reasons; its run id and verification stay as they were. All other
 * entries, including `已过期` ones whose files have been restored, are returned unchanged, and an
 * entry whose record is missing has nothing to compare against. Neither `runs` nor `hashes` is
 * modified, and running the check again with the same arguments changes nothing (17.6).
 */
export function detectStaleness(
  state: ArtifactIndex,
  runs: RunRecordMap,
  hashes: FileHashSnapshot
): ArtifactIndex {
  const entries = { ...state.entries };
  for (const path of Object.keys(state.entries)) {
    const entry = state.entries[path];
    if (entry.status !== '已生成' && entry.status !== '已验证') {
      continue;
    }
    const run = entry.runId === null ? undefined : runs.get(entry.runId);
    if (!run) {
      continue;
    }
    const staleReasons = findStaleReasons(path, run, hashes);
    if (staleReasons.length > 0) {
      setEntry(entries, path, { ...entry, status: '已过期', staleReasons });
    }
  }
  return withEntries(state, entries);
}
