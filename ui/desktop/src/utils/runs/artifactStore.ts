/**
 * Artifact_Status I/O layer of the main process (spec mathmodel-parity-and-beyond, tasks 21.8,
 * 22.8, 22.9; requirements 16, 17).
 *
 * One detection pass ("refresh") over a Project:
 * 1. reads `.modelforge/runs` and applies the Run_Records the index has not taken in yet;
 * 2. scans the Project for result, figure and paper files (未开始, 已发现文件);
 * 3. hashes the files the `已生成` and `已验证` Artifacts depend on, reusing hashes whose size and
 *    modification time did not change, and runs `detectStaleness`;
 * 4. writes `.modelforge/artifacts.json` atomically when the index changed and tells the
 *    subscribers.
 *
 * A pass runs when a Project is opened (`getIndex`), on a manual check, before "标记已验证", and
 * about half a second after a file in the Project changed (two seconds at most while changes keep
 * coming), which keeps detection within the five seconds of requirement 17.3. Run notifications
 * from the Kernel (`runs/started`, `runs/finished`) come in through `runStarted` and
 * `runFinished`. Work on one Project runs one step at a time.
 *
 * `artifacts.json` is only written into an existing `.modelforge/` directory, so opening a folder
 * that is not a ModelForge Project leaves no files behind; its index lives in memory. Every
 * Project with a Run_Record has that directory.
 */
import fs, { watch as fsWatch } from 'node:fs';
import path from 'node:path';
import type { ArtifactIndex, MarkVerifiedResult } from '../../types/artifactStatus';
import type { RunRecord, RunRecordMap } from '../../types/runRecord';
import type {
  ArtifactInspection,
  ArtifactsChangedEvent,
  ArtifactsRunFinishedEvent,
  ArtifactsRunStartedEvent,
} from '../../types/runsApi';
import {
  applyRunStarted,
  detectStaleness,
  emptyArtifactIndex,
  getArtifactEntry,
  markVerified,
} from '../artifactStatus';
import { writeFileAtomic } from '../atomicWrite';
import { describeError } from '../ipcResult';
import { scanProject } from '../projectInventory';
import {
  RUN_RECORD_MAX_FILES,
  isProjectRelativePath,
  isRunId,
  type LoadedRunRecords,
} from '../runRecord';
import {
  applyNewRuns,
  artifactFileChecks,
  fileOnlyPaths,
  inspectionPaths,
  parseArtifactIndex,
  sameArtifactIndex,
  serializeArtifactIndex,
  staleCheckPaths,
  syncDiscoveredFiles,
} from './artifactSync';
import {
  createFileHashCache,
  isMissingFileError,
  projectFilePath,
  type FileHashCache,
} from './fileHashSnapshot';
import {
  RUNS_DIR,
  createRunRecordReader,
  isInside,
  isRunRecordFileName,
  type RunRecordReader,
} from './runRecordFiles';

export const MODELFORGE_DIR = '.modelforge';
export const ARTIFACTS_FILE = '.modelforge/artifacts.json';

export type ArtifactStoreErrorCode =
  | 'INVALID_PROJECT'
  | 'INVALID_PATH'
  | 'INVALID_EVENT'
  | 'WRITE_FAILED';

/** A refusal with a stable code for the IPC result. */
export class ArtifactStoreError extends Error {
  readonly code: ArtifactStoreErrorCode;

  constructor(code: ArtifactStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ArtifactStoreError';
    this.code = code;
  }
}

export interface ProjectWatcher {
  close: () => void;
}

/**
 * Watches a Project directory recursively. `onChange` receives the changed path relative to
 * `root` (any separator), or `null` when the platform does not say.
 */
export type WatchProject = (
  root: string,
  onChange: (relativePath: string | null) => void,
  onError: () => void
) => ProjectWatcher | null;

export interface ArtifactStore {
  /** All Run_Records of the Project; broken files are reported, the rest load (16.5). */
  listRuns: (projectDir: string) => Promise<LoadedRunRecords>;
  /** The current index; runs a detection pass unless a watcher vouches nothing changed. */
  getIndex: (projectDir: string) => Promise<ArtifactIndex>;
  /** A detection pass now (17.3). */
  checkStale: (projectDir: string) => Promise<ArtifactIndex>;
  /** "标记已验证" after a detection pass, so an outdated file cannot be verified (17.2, 17.7). */
  verify: (projectDir: string, artifactPath: string) => Promise<MarkVerifiedResult>;
  inspect: (projectDir: string, artifactPath: string) => Promise<ArtifactInspection>;
  runStarted: (event: unknown) => Promise<ArtifactIndex>;
  runFinished: (event: unknown) => Promise<ArtifactIndex>;
  /** Called with the new index whenever one changes; returns the unsubscribe function. */
  subscribe: (listener: (event: ArtifactsChangedEvent) => void) => () => void;
  /** Stops every watcher and pending pass. */
  close: () => void;
}

export interface ArtifactStoreOptions {
  hashes?: FileHashCache;
  records?: RunRecordReader;
  /** Project-relative result, figure and paper files of the Project at `root`. */
  scanArtifactFiles?: (root: string) => Promise<string[]>;
  /** `null` turns watching off. */
  watch?: WatchProject | null;
  now?: () => Date;
  log?: (message: string) => void;
  /** Quiet time after a change before the pass runs. */
  debounceMs?: number;
  /** Longest wait after the first change while changes keep coming. */
  maxWaitMs?: number;
  /** Projects watched at the same time; the least recently used stops first. */
  maxWatchers?: number;
}

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_MAX_WAIT_MS = 2000;
const DEFAULT_MAX_WATCHERS = 8;
/** Projects whose index stays in memory. */
const MAX_PROJECTS = 32;
const ARTIFACT_STAGES = new Set(['results', 'figures', 'paper']);
/** Changes below these top-level directories never affect an Artifact. */
const IGNORED_TOP_LEVEL = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv']);

/** The result, figure and paper files the Project panel lists (`workspace-scan-project`). */
export async function scanArtifactFiles(root: string): Promise<string[]> {
  const snapshot = await scanProject(root);
  return snapshot.artifacts
    .filter((file) => ARTIFACT_STAGES.has(file.stage))
    .map((file) => file.relativePath);
}

const watchRecursively: WatchProject = (root, onChange, onError) => {
  try {
    const watcher = fsWatch(root, { recursive: true }, (_event, filename) =>
      onChange(filename === null ? null : String(filename))
    );
    watcher.on('error', onError);
    return watcher;
  } catch {
    return null;
  }
};

/**
 * Whether a change can affect an Artifact. Inside `.modelforge/` only new or changed Run_Records
 * count; in particular the index's own writes do not.
 */
export function isRelevantChange(relativePath: string | null): boolean {
  if (relativePath === null) {
    return true;
  }
  const parts = relativePath.replace(/\\/g, '/').split('/');
  if (parts[0] === MODELFORGE_DIR) {
    return parts.length === 3 && parts[1] === 'runs' && isRunRecordFileName(parts[2]);
  }
  return !IGNORED_TOP_LEVEL.has(parts[0]);
}

interface ProjectState {
  root: string;
  /** `null` until read from `artifacts.json`. */
  index: ArtifactIndex | null;
  /** The valid Run_Records of the last pass. */
  runs: RunRecordMap;
  /** True while the watcher saw no change since the last pass. */
  fresh: boolean;
  /** Counts the changes the watcher reported. */
  changes: number;
  queue: Promise<unknown>;
  watcher: ProjectWatcher | null;
  timer: ReturnType<typeof setTimeout> | null;
  dirtySince: number | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidEvent(message: string): ArtifactStoreError {
  return new ArtifactStoreError('INVALID_EVENT', message);
}

/** A `runs/started` from the renderer; declared outputs that cannot be Artifacts are dropped. */
function readRunStarted(value: unknown): ArtifactsRunStartedEvent {
  if (!isObject(value) || typeof value.workingDir !== 'string' || !isRunId(value.runId)) {
    throw invalidEvent('A run start needs workingDir and a valid runId');
  }
  const outputs: unknown = value.declaredOutputs;
  if (!Array.isArray(outputs)) {
    throw invalidEvent('A run start needs declaredOutputs');
  }
  const declaredOutputs: string[] = [];
  for (const output of outputs as unknown[]) {
    if (declaredOutputs.length === RUN_RECORD_MAX_FILES) {
      break;
    }
    if (
      isProjectRelativePath(output) &&
      !output.startsWith(`${MODELFORGE_DIR}/`) &&
      !declaredOutputs.includes(output)
    ) {
      declaredOutputs.push(output);
    }
  }
  return {
    workingDir: value.workingDir as string,
    runId: value.runId as string,
    declaredOutputs,
  };
}

/** A `runs/finished` from the renderer; `recordPath` must be the record of `runId`. */
function readRunFinished(value: unknown): ArtifactsRunFinishedEvent {
  if (!isObject(value) || typeof value.workingDir !== 'string' || !isRunId(value.runId)) {
    throw invalidEvent('A run end needs workingDir and a valid runId');
  }
  const runId = value.runId as string;
  const recordPath = `${RUNS_DIR}/${runId}.json`;
  if (value.recordPath !== recordPath) {
    throw invalidEvent(`recordPath is not the Run_Record of ${runId}`);
  }
  return { workingDir: value.workingDir as string, runId, recordPath };
}

function toRunMap(loaded: LoadedRunRecords): Map<string, RunRecord> {
  return new Map(loaded.records.map(({ record }): [string, RunRecord] => [record.runId, record]));
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Resolves the Project root the way every channel sees it: real path of a directory. */
export async function resolveProject(projectDir: unknown): Promise<string> {
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) {
    throw new ArtifactStoreError('INVALID_PROJECT', 'The Project must be an absolute directory');
  }
  let root: string;
  try {
    root = await fs.promises.realpath(projectDir);
    if (!(await fs.promises.stat(root)).isDirectory()) {
      throw new Error('not a directory');
    }
  } catch (cause) {
    throw new ArtifactStoreError('INVALID_PROJECT', `${projectDir} is not a directory`, { cause });
  }
  return root;
}

/**
 * An Artifact path from the renderer: Project-relative, and when the file exists its real path
 * must stay inside the Project.
 */
async function resolveArtifactPath(root: string, artifactPath: unknown): Promise<string> {
  const file = typeof artifactPath === 'string' ? projectFilePath(root, artifactPath) : null;
  if (typeof artifactPath !== 'string' || file === null) {
    throw new ArtifactStoreError('INVALID_PATH', 'The Artifact path must be Project-relative');
  }
  let real: string | null = null;
  try {
    real = await fs.promises.realpath(file);
  } catch {
    // A tracked Artifact may have lost its file; that is for the detection to report.
  }
  if (real !== null && !isInside(root, real)) {
    throw new ArtifactStoreError('INVALID_PATH', `${artifactPath} resolves outside the Project`);
  }
  return artifactPath;
}

export function createArtifactStore(options: ArtifactStoreOptions = {}): ArtifactStore {
  const hashes = options.hashes ?? createFileHashCache();
  const records = options.records ?? createRunRecordReader();
  const scanFiles = options.scanArtifactFiles ?? scanArtifactFiles;
  const watchProject = options.watch === undefined ? watchRecursively : options.watch;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((message: string) => console.warn(`[artifacts] ${message}`));
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const maxWatchers = options.maxWatchers ?? DEFAULT_MAX_WATCHERS;

  const states = new Map<string, ProjectState>();
  const listeners = new Set<(event: ArtifactsChangedEvent) => void>();

  const emit = (root: string, index: ArtifactIndex) => {
    for (const listener of [...listeners]) {
      try {
        listener({ projectDir: root, index });
      } catch (error) {
        log(`a listener failed: ${describeError(error)}`);
      }
    }
  };

  const stopWatching = (state: ProjectState) => {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
      state.dirtySince = null;
    }
    if (state.watcher) {
      try {
        state.watcher.close();
      } catch {
        // Already closed.
      }
      state.watcher = null;
    }
    state.fresh = false;
  };

  const stateFor = (root: string): ProjectState => {
    const known = states.get(root);
    if (known) {
      // Most recently used last.
      states.delete(root);
      states.set(root, known);
      return known;
    }
    const state: ProjectState = {
      root,
      index: null,
      runs: new Map(),
      fresh: false,
      changes: 0,
      queue: Promise.resolve(),
      watcher: null,
      timer: null,
      dirtySince: null,
    };
    states.set(root, state);
    while (states.size > MAX_PROJECTS) {
      const [oldest] = states.values();
      stopWatching(oldest);
      states.delete(oldest.root);
    }
    return state;
  };

  /** Runs `task` after everything already queued for the Project. */
  const serialize = <T>(state: ProjectState, task: () => Promise<T>): Promise<T> => {
    const result = state.queue.then(task, task);
    state.queue = result.catch(() => undefined);
    return result;
  };

  const loadIndex = async (state: ProjectState): Promise<ArtifactIndex> => {
    if (state.index) {
      return state.index;
    }
    const file = path.join(state.root, ...ARTIFACTS_FILE.split('/'));
    let text: string | null = null;
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
    let index = emptyArtifactIndex();
    if (text !== null) {
      const parsed = parseArtifactIndex(text);
      if (parsed) {
        index = parsed;
      } else {
        log(`${file} is not a valid Artifact index; a copy is kept as artifacts.json.invalid`);
        await fs.promises.copyFile(file, `${file}.invalid`).catch(() => undefined);
      }
    }
    state.index = index;
    return index;
  };

  const hasModelforgeDir = async (root: string): Promise<boolean> => {
    try {
      return (await fs.promises.lstat(path.join(root, MODELFORGE_DIR))).isDirectory();
    } catch {
      return false;
    }
  };

  const persist = async (state: ProjectState, index: ArtifactIndex) => {
    if (!(await hasModelforgeDir(state.root))) {
      return;
    }
    await writeFileAtomic(
      path.join(state.root, ...ARTIFACTS_FILE.split('/')),
      serializeArtifactIndex(index)
    );
  };

  /**
   * Makes `next` the Project's index and returns the index kept (`previous` when nothing
   * changed). When `required`, a failed write is an error and the index stays as it was;
   * otherwise it is logged and the index lives on in memory.
   */
  const commit = async (
    state: ProjectState,
    previous: ArtifactIndex,
    next: ArtifactIndex,
    required: boolean
  ): Promise<ArtifactIndex> => {
    if (sameArtifactIndex(previous, next)) {
      state.index = previous;
      return previous;
    }
    try {
      await persist(state, next);
    } catch (error) {
      if (required) {
        throw new ArtifactStoreError('WRITE_FAILED', `Could not write ${ARTIFACTS_FILE}`, {
          cause: error,
        });
      }
      log(`could not write ${ARTIFACTS_FILE} of ${state.root}: ${describeError(error)}`);
    }
    state.index = next;
    emit(state.root, next);
    return next;
  };

  const existingFiles = async (root: string, paths: readonly string[]): Promise<string[]> => {
    const found: string[] = [];
    for (const relative of paths) {
      const file = projectFilePath(root, relative);
      if (file !== null && (await isFile(file))) {
        found.push(relative);
      }
    }
    return found;
  };

  /** One detection pass; call it through `serialize`. */
  const refreshLocked = async (
    state: ProjectState
  ): Promise<{ index: ArtifactIndex; runs: RunRecordMap }> => {
    const generation = state.changes;
    const previous = await loadIndex(state);
    const loaded = await records.load(state.root);
    const runs = toRunMap(loaded);
    // Broken record files (`loaded.problems`) back no Artifact (16.5); `runs-list` reports them.
    let next = applyNewRuns(previous, loaded.records.map(({ record }) => record));

    const artifactFiles = await scanFiles(state.root);
    const present = new Set(artifactFiles);
    const unlisted = fileOnlyPaths(next).filter((relative) => !present.has(relative));
    for (const relative of await existingFiles(state.root, unlisted)) {
      present.add(relative);
    }
    next = syncDiscoveredFiles(next, artifactFiles, present);

    const current = await hashes.snapshot(state.root, staleCheckPaths(next, runs));
    next = detectStaleness(next, runs, current);

    state.runs = runs;
    const kept = await commit(state, previous, next, false);
    state.fresh = state.watcher !== null && state.changes === generation;
    return { index: kept, runs };
  };

  const schedule = (state: ProjectState) => {
    const at = Date.now();
    if (state.dirtySince === null) {
      state.dirtySince = at;
    }
    if (state.timer) {
      clearTimeout(state.timer);
    }
    const wait = Math.max(0, Math.min(debounceMs, state.dirtySince + maxWaitMs - at));
    state.timer = setTimeout(() => {
      state.timer = null;
      state.dirtySince = null;
      serialize(state, () => refreshLocked(state)).catch((error) =>
        log(`detection in ${state.root} failed: ${describeError(error)}`)
      );
    }, wait);
  };

  const ensureWatching = async (state: ProjectState) => {
    if (state.watcher || !watchProject || !(await hasModelforgeDir(state.root))) {
      return;
    }
    // Checked again: another call may have started one, or the state been evicted, meanwhile.
    if (state.watcher || states.get(state.root) !== state) {
      return;
    }
    const watcher = watchProject(
      state.root,
      (relativePath) => {
        if (state.watcher && isRelevantChange(relativePath)) {
          state.changes += 1;
          state.fresh = false;
          schedule(state);
        }
      },
      () => stopWatching(state)
    );
    if (!watcher) {
      return;
    }
    state.watcher = watcher;
    const watched = [...states.values()].filter((known) => known.watcher !== null);
    for (const known of watched.slice(0, Math.max(0, watched.length - maxWatchers))) {
      if (known !== state) {
        stopWatching(known);
      }
    }
  };

  /** A detection pass for the Project at `projectDir`, with its watcher running first. */
  const refreshProject = async (root: string) => {
    const state = stateFor(root);
    await ensureWatching(state);
    return serialize(state, () => refreshLocked(state));
  };

  return {
    listRuns: async (projectDir) => records.load(await resolveProject(projectDir)),

    getIndex: async (projectDir) => {
      const root = await resolveProject(projectDir);
      const state = stateFor(root);
      if (state.fresh && state.index) {
        return state.index;
      }
      return (await refreshProject(root)).index;
    },

    checkStale: async (projectDir) =>
      (await refreshProject(await resolveProject(projectDir))).index,

    verify: async (projectDir, artifactPath) => {
      const root = await resolveProject(projectDir);
      const target = await resolveArtifactPath(root, artifactPath);
      const state = stateFor(root);
      await ensureWatching(state);
      return serialize(state, async (): Promise<MarkVerifiedResult> => {
        const { index, runs } = await refreshLocked(state);
        const result = markVerified(index, runs, target, now());
        if (result.ok) {
          return { ok: true, index: await commit(state, index, result.index, true) };
        }
        return result;
      });
    },

    inspect: async (projectDir, artifactPath) => {
      const root = await resolveProject(projectDir);
      const target = await resolveArtifactPath(root, artifactPath);
      const state = stateFor(root);
      await ensureWatching(state);
      return serialize(state, async () => {
        const known =
          state.fresh && state.index
            ? { index: state.index, runs: state.runs }
            : await refreshLocked(state);
        const entry = getArtifactEntry(known.index, target) ?? null;
        const record = entry?.runId ? (known.runs.get(entry.runId) ?? null) : null;
        const files = record
          ? artifactFileChecks(
              target,
              record,
              await hashes.snapshot(root, inspectionPaths(target, record))
            )
          : [];
        return { path: target, entry, record, files };
      });
    },

    runStarted: async (event) => {
      const started = readRunStarted(event);
      const root = await resolveProject(started.workingDir);
      const state = stateFor(root);
      await ensureWatching(state);
      return serialize(state, async () => {
        const previous = await loadIndex(state);
        // A start that arrives after its Run_Record was written is already over.
        const record = path.join(root, ...RUNS_DIR.split('/'), `${started.runId}.json`);
        if (await isFile(record)) {
          return previous;
        }
        return commit(
          state,
          previous,
          applyRunStarted(previous, started.runId, started.declaredOutputs),
          false
        );
      });
    },

    runFinished: async (event) => {
      // The pass reads the record at recordPath with the others and applies it through
      // `applyNewRuns`, which also keeps a record the watcher found first from applying twice.
      const finished = readRunFinished(event);
      return (await refreshProject(await resolveProject(finished.workingDir))).index;
    },

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    close: () => {
      for (const state of states.values()) {
        stopWatching(state);
      }
    },
  };
}

let shared: ArtifactStore | null = null;

/** The store of the main process, shared by the runs IPC and the gallery. */
export function sharedArtifactStore(): ArtifactStore {
  if (!shared) {
    shared = createArtifactStore();
  }
  return shared;
}
