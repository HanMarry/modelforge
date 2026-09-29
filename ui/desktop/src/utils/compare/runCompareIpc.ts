/**
 * Main-process IPC for comparing two runs (requirement 21, task 24.3).
 *
 * `runs-compare-list(projectDir)` lists the Run_Records of a Project so the compare tab can pick
 * two of them; `runs-compare({ projectDir, runIdA, runIdB })` reads both records, their optional
 * `<runId>.meta.json` and `.modelforge/artifacts.json`, and returns `compareRuns` together with
 * what each side needs for its header and markers (requirement 21.1, 21.2, 21.5).
 *
 * Everything here is read-only. The Project path comes from the renderer, so its real path is
 * resolved first and every directory read is checked to stay inside it; record and metadata
 * files must be regular files (symbolic links are not followed), and run ids must match the
 * Run_Record id format before they become part of a path.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { IpcMain } from 'electron';
import type { ArtifactStatus } from '../../types/artifactStatus';
import type { RunMeta, RunMetaProblem } from '../../types/runCompare';
import type {
  ArtifactIndexState,
  RunCompareCandidate,
  RunCompareCandidates,
  RunCompareFlag,
  RunCompareRequest,
  RunCompareResult,
  RunCompareSide,
} from '../../types/runCompareApi';
import type { RunFailure, RunRecord, RunRecordProblem } from '../../types/runRecord';
import { isArtifactStatus } from '../artifactStatus';
import type { FeatureIpcDeps } from '../featureIpc';
import { describeError, toIpcError, type IpcResult } from '../ipcResult';
import { compareRuns, parseRunMeta, RUN_META_SUFFIX, runMetaFileName } from '../runCompare';
import { loadRunRecords, parseRunRecord, RUN_FAILURES, type RunRecordFile } from '../runRecord';

export const RUNS_COMPARE_CHANNEL = 'runs-compare';
export const RUNS_COMPARE_LIST_CHANNEL = 'runs-compare-list';

/** Stable error codes; the renderer shows a localized message for each. */
export const RUN_COMPARE_ERROR = {
  invalidRequest: 'INVALID_REQUEST',
  projectUnavailable: 'PROJECT_UNAVAILABLE',
  outsideProject: 'OUTSIDE_PROJECT',
  sameRun: 'SAME_RUN',
  runNotFound: 'RUN_NOT_FOUND',
  runInvalid: 'RUN_INVALID',
  readFailed: 'READ_FAILED',
} as const;

/** Largest record, metadata or index file that is parsed; larger files are reported instead. */
export const RUN_COMPARE_MAX_FILE_BYTES = 16 * 1024 * 1024;

/** Same format as `runId` in `schemas/run-record.schema.json`. */
const RUN_ID_PATTERN = /^[0-9]{8}T[0-9]{9}-[0-9a-z]{6}$/;
const RUNS_DIR_RELATIVE = '.modelforge/runs';
const ARTIFACT_INDEX_FILE = 'artifacts.json';

class CompareFailure extends Error {
  readonly code: string;
  readonly detail: unknown;

  constructor(code: string, detail: unknown) {
    super(describeError(detail));
    this.name = 'CompareFailure';
    this.code = code;
    this.detail = detail;
  }
}

type JsonObject = Record<string, unknown>;

type FileRead =
  | { status: 'ok'; text: string }
  | { status: 'missing' }
  | { status: 'not-file' }
  | { status: 'too-large'; size: number }
  | { status: 'error'; error: unknown };

interface MetaRead {
  meta: RunMeta | null;
  problem: RunMetaProblem | null;
}

interface ArtifactFacts {
  runId: string | null;
  status: ArtifactStatus;
  failure: RunFailure | null;
  verification: { runId: string; verifiedAt: string } | null;
}

interface LoadedArtifactIndex {
  state: ArtifactIndexState;
  entries: ArtifactFacts[];
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  const code = isPlainObject(error) ? error.code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isRunFailure(value: unknown): value is RunFailure {
  return RUN_FAILURES.some((failure) => failure === value);
}

/** True when `target` is `root` itself or below it. */
function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Real path of the Project directory; the renderer passes the session's working directory. */
async function resolveProjectRoot(projectDir: unknown): Promise<string> {
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) {
    throw new CompareFailure(RUN_COMPARE_ERROR.invalidRequest, 'projectDir must be absolute');
  }
  try {
    const root = await fs.realpath(projectDir);
    if (!(await fs.stat(root)).isDirectory()) {
      throw new Error(`${projectDir} is not a directory`);
    }
    return root;
  } catch (error) {
    throw new CompareFailure(RUN_COMPARE_ERROR.projectUnavailable, error);
  }
}

/**
 * Real path of a directory below the Project root, or `null` when it does not exist. A directory
 * that resolves outside the root (through a symbolic link, for example) is refused.
 */
async function resolveDirWithin(root: string, relative: string): Promise<string | null> {
  let real: string;
  try {
    real = await fs.realpath(path.join(root, ...relative.split('/')));
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw new CompareFailure(RUN_COMPARE_ERROR.readFailed, error);
  }
  if (!isWithin(root, real)) {
    throw new CompareFailure(
      RUN_COMPARE_ERROR.outsideProject,
      `${relative} is outside the Project`
    );
  }
  try {
    return (await fs.stat(real)).isDirectory() ? real : null;
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw new CompareFailure(RUN_COMPARE_ERROR.readFailed, error);
  }
}

/** Reads a regular file without following a symbolic link in its last component. */
async function readRegularFile(file: string): Promise<FileRead> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) {
      return { status: 'not-file' };
    }
    if (stat.size > RUN_COMPARE_MAX_FILE_BYTES) {
      return { status: 'too-large', size: stat.size };
    }
    return { status: 'ok', text: await fs.readFile(file, 'utf8') };
  } catch (error) {
    return isMissing(error) ? { status: 'missing' } : { status: 'error', error };
  }
}

function isRecordFileName(name: string): boolean {
  return name.endsWith('.json') && !name.endsWith(RUN_META_SUFFIX);
}

/** One line naming everything wrong with a record file. */
function describeRecordProblem(problem: RunRecordProblem): string {
  const parts: string[] = [];
  if (problem.parseErrorAt) {
    const { line, column } = problem.parseErrorAt;
    parts.push(`JSON syntax error at line ${line}, column ${column}`);
  }
  if (problem.missing.length > 0) {
    parts.push(`missing ${problem.missing.join(', ')}`);
  }
  if (problem.invalid.length > 0) {
    parts.push(`invalid ${problem.invalid.join(', ')}`);
  }
  return `${problem.path}: ${parts.join('; ') || 'unreadable'}`;
}

async function readMeta(runsDir: string, runId: string): Promise<MetaRead> {
  const name = runMetaFileName(runId);
  const relative = `${RUNS_DIR_RELATIVE}/${name}`;
  const read = await readRegularFile(path.join(runsDir, name));
  if (read.status === 'missing') {
    return { meta: null, problem: null };
  }
  if (read.status !== 'ok') {
    return { meta: null, problem: { path: relative, invalid: ['$'] } };
  }
  // Metadata is often written by the user's own script, possibly with a byte order mark.
  const parsed = parseRunMeta(stripBom(read.text), relative);
  if (parsed.ok) {
    return { meta: parsed.meta, problem: null };
  }
  const problem: RunMetaProblem = { path: parsed.path, invalid: parsed.invalid };
  if (parsed.parseErrorAt) {
    problem.parseErrorAt = parsed.parseErrorAt;
  }
  return { meta: null, problem };
}

async function readRecord(runsDir: string, runId: string): Promise<RunRecord> {
  const relative = `${RUNS_DIR_RELATIVE}/${runId}.json`;
  const read = await readRegularFile(path.join(runsDir, `${runId}.json`));
  if (read.status === 'missing' || read.status === 'not-file') {
    throw new CompareFailure(RUN_COMPARE_ERROR.runNotFound, `${relative} does not exist`);
  }
  if (read.status === 'error') {
    throw new CompareFailure(RUN_COMPARE_ERROR.readFailed, read.error);
  }
  if (read.status === 'too-large') {
    throw new CompareFailure(
      RUN_COMPARE_ERROR.runInvalid,
      `${relative} is larger than ${RUN_COMPARE_MAX_FILE_BYTES} bytes`
    );
  }
  const parsed = parseRunRecord(read.text, relative);
  if (!parsed.ok) {
    throw new CompareFailure(RUN_COMPARE_ERROR.runInvalid, describeRecordProblem(parsed));
  }
  if (parsed.record.runId !== runId) {
    throw new CompareFailure(
      RUN_COMPARE_ERROR.runInvalid,
      `${relative}: runId does not match the file name`
    );
  }
  return parsed.record;
}

function readVerification(value: unknown): ArtifactFacts['verification'] {
  if (!isPlainObject(value)) {
    return null;
  }
  const { runId, verifiedAt } = value;
  if (typeof runId !== 'string' || typeof verifiedAt !== 'string') {
    return null;
  }
  return { runId, verifiedAt };
}

/**
 * Lenient reader of `artifacts.json`, which the runs I/O layer writes (task 22.8). Entries this
 * view cannot read are skipped rather than failing the comparison.
 */
function parseArtifactIndex(value: unknown): LoadedArtifactIndex {
  const stored = isPlainObject(value) && value.schemaVersion === 1 ? value.entries : undefined;
  if (!isPlainObject(stored)) {
    return { state: 'invalid', entries: [] };
  }
  const entries: ArtifactFacts[] = [];
  for (const entry of Object.values(stored)) {
    if (!isPlainObject(entry)) {
      continue;
    }
    const { runId, status, failure, verification } = entry;
    if (!isArtifactStatus(status)) {
      continue;
    }
    entries.push({
      runId: typeof runId === 'string' ? runId : null,
      status,
      failure: isRunFailure(failure) ? failure : null,
      verification: readVerification(verification),
    });
  }
  return { state: 'present', entries };
}

async function readArtifactIndex(root: string): Promise<LoadedArtifactIndex> {
  let dir: string | null;
  try {
    dir = await resolveDirWithin(root, '.modelforge');
  } catch {
    return { state: 'invalid', entries: [] };
  }
  if (!dir) {
    return { state: 'missing', entries: [] };
  }
  const read = await readRegularFile(path.join(dir, ARTIFACT_INDEX_FILE));
  if (read.status === 'missing') {
    return { state: 'missing', entries: [] };
  }
  if (read.status !== 'ok') {
    return { state: 'invalid', entries: [] };
  }
  try {
    return parseArtifactIndex(JSON.parse(stripBom(read.text)));
  } catch {
    return { state: 'invalid', entries: [] };
  }
}

/** The latest of ISO 8601 timestamps with offsets; unparsable ones are ignored. */
function latestTimestamp(timestamps: string[]): string | null {
  let latest: string | null = null;
  let latestMs = -Infinity;
  for (const timestamp of timestamps) {
    const ms = Date.parse(timestamp);
    if (Number.isFinite(ms) && ms > latestMs) {
      latest = timestamp;
      latestMs = ms;
    }
  }
  return latest;
}

/** Markers and verdict of one side (requirement 21.1 "验证结论", 21.5). */
function describeSide(
  record: RunRecord,
  meta: MetaRead,
  index: LoadedArtifactIndex
): RunCompareSide {
  const own = index.entries.filter((entry) => entry.runId === record.runId);
  const failedArtifact = own.find((entry) => entry.status === '执行失败');
  const flags: RunCompareFlag[] = [];
  if (record.exitCode !== 0 || record.failure !== null || failedArtifact) {
    flags.push('failed');
  }
  if (own.some((entry) => entry.status === '已过期')) {
    flags.push('stale');
  }
  const verifiedAt = latestTimestamp(
    index.entries.flatMap(({ verification }) =>
      verification !== null && verification.runId === record.runId ? [verification.verifiedAt] : []
    )
  );
  return {
    record,
    meta: meta.meta,
    metaProblem: meta.problem,
    flags,
    failure: record.failure ?? failedArtifact?.failure ?? null,
    verifiedAt,
  };
}

function isCompareRequest(value: unknown): value is RunCompareRequest {
  return (
    isPlainObject(value) &&
    typeof value.projectDir === 'string' &&
    typeof value.runIdA === 'string' &&
    typeof value.runIdB === 'string'
  );
}

export async function compareProjectRuns(request: unknown): Promise<RunCompareResult> {
  if (!isCompareRequest(request)) {
    throw new CompareFailure(
      RUN_COMPARE_ERROR.invalidRequest,
      'expected { projectDir, runIdA, runIdB }'
    );
  }
  const { runIdA, runIdB } = request;
  if (!RUN_ID_PATTERN.test(runIdA) || !RUN_ID_PATTERN.test(runIdB)) {
    throw new CompareFailure(RUN_COMPARE_ERROR.invalidRequest, 'run ids have the wrong format');
  }
  if (runIdA === runIdB) {
    throw new CompareFailure(RUN_COMPARE_ERROR.sameRun, 'select two different runs');
  }
  const root = await resolveProjectRoot(request.projectDir);
  const runsDir = await resolveDirWithin(root, RUNS_DIR_RELATIVE);
  if (!runsDir) {
    throw new CompareFailure(RUN_COMPARE_ERROR.runNotFound, `${RUNS_DIR_RELATIVE} does not exist`);
  }
  const recordA = await readRecord(runsDir, runIdA);
  const recordB = await readRecord(runsDir, runIdB);
  const metaA = await readMeta(runsDir, runIdA);
  const metaB = await readMeta(runsDir, runIdB);
  const index = await readArtifactIndex(root);
  const comparison = compareRuns(
    { record: recordA, meta: metaA.meta },
    { record: recordB, meta: metaB.meta }
  );
  return {
    ...comparison,
    a: describeSide(recordA, metaA, index),
    b: describeSide(recordB, metaB, index),
    artifactIndex: index.state,
  };
}

function candidateOf(record: RunRecord, meta: MetaRead): RunCompareCandidate {
  return {
    runId: record.runId,
    command: record.command,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    exitCode: record.exitCode,
    failure: record.failure,
    method: meta.meta?.method ?? null,
  };
}

export async function listProjectRuns(projectDir: unknown): Promise<RunCompareCandidates> {
  const root = await resolveProjectRoot(projectDir);
  const runsDir = await resolveDirWithin(root, RUNS_DIR_RELATIVE);
  if (!runsDir) {
    return { runs: [], problems: [] };
  }
  let names: string[];
  try {
    const entries = await fs.readdir(runsDir, { withFileTypes: true });
    // Symbolic links are not regular files here and are skipped like any other entry.
    names = entries
      .filter((entry) => entry.isFile() && isRecordFileName(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    throw new CompareFailure(RUN_COMPARE_ERROR.readFailed, error);
  }

  const files: RunRecordFile[] = [];
  const unreadable: RunRecordProblem[] = [];
  for (const name of names) {
    const relative = `${RUNS_DIR_RELATIVE}/${name}`;
    const read = await readRegularFile(path.join(runsDir, name));
    if (read.status === 'ok') {
      files.push({ path: relative, text: read.text });
    } else if (read.status === 'too-large' || read.status === 'error') {
      unreadable.push({ path: relative, missing: [], invalid: ['$'] });
    }
    // `missing` and `not-file`: the file went away after `readdir`; nothing to report.
  }

  const loaded = loadRunRecords(files);
  const runs: RunCompareCandidate[] = [];
  for (const { record } of loaded.records) {
    runs.push(candidateOf(record, await readMeta(runsDir, record.runId)));
  }
  runs.sort((x, y) => (x.runId < y.runId ? 1 : x.runId > y.runId ? -1 : 0));
  return { runs, problems: [...unreadable, ...loaded.problems] };
}

async function settle<T>(work: () => Promise<T>, deps: FeatureIpcDeps): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    const failure =
      error instanceof CompareFailure
        ? error
        : new CompareFailure(RUN_COMPARE_ERROR.readFailed, error);
    return {
      ok: false,
      error: toIpcError(failure.code, failure.detail, deps.sensitiveValues()),
    };
  }
}

export function registerRunCompareIpc(ipc: Pick<IpcMain, 'handle'>, deps: FeatureIpcDeps): void {
  ipc.handle(RUNS_COMPARE_CHANNEL, (_event, request: unknown) =>
    settle(() => compareProjectRuns(request), deps)
  );
  ipc.handle(RUNS_COMPARE_LIST_CHANNEL, (_event, projectDir: unknown) =>
    settle(() => listProjectRuns(projectDir), deps)
  );
}
