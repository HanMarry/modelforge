/**
 * Reads the Run_Records of a Project from `.modelforge/runs` (task 21.8, requirement 16.5).
 * Parsing and the report of broken files are `loadRunRecords` in `../runRecord.ts`; this module
 * picks the files and reads them. Files are parsed again only when their size or modification
 * time changed.
 *
 * Only `<name>.json` files count. Left out: the optional `<runId>.meta.json` next to a record
 * (design, "Project 元数据"), the `.run-*.tmp` files a writer leaves while it writes, and any other
 * hidden file.
 */
import fs, { type Stats } from 'node:fs';
import path from 'node:path';
import type { RunRecordProblem } from '../../types/runRecord';
import { loadRunRecords, type LoadedRunRecords } from '../runRecord';
import { isMissingFileError } from './fileHashSnapshot';

/** Project-relative directory of the records. */
export const RUNS_DIR = '.modelforge/runs';
/** Larger files are reported without being read; a full record is well under 1 MB. */
export const MAX_RUN_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_CACHED_FILES = 5000;

export function isRunRecordFileName(name: string): boolean {
  return name.endsWith('.json') && !name.endsWith('.meta.json') && !name.startsWith('.');
}

/** Whether the resolved path `target` lies strictly inside the resolved directory `root`. */
export function isInside(root: string, target: string): boolean {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(prefix) && target.length > prefix.length;
}

interface CachedLoad {
  size: number;
  mtimeMs: number;
  loaded: LoadedRunRecords;
}

export interface RunRecordReader {
  /** Every Run_Record file of the Project at the resolved `root`, in file name order. */
  load: (root: string) => Promise<LoadedRunRecords>;
}

function unreadable(recordPath: string): LoadedRunRecords {
  const problem: RunRecordProblem = { path: recordPath, missing: [], invalid: ['$'] };
  return { records: [], problems: [problem] };
}

export function createRunRecordReader(): RunRecordReader {
  const cache = new Map<string, CachedLoad>();

  const loadFile = async (file: string, recordPath: string): Promise<LoadedRunRecords> => {
    let stat: Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      cache.delete(file);
      return unreadable(recordPath);
    }
    const cached = cache.get(file);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return cached.loaded;
    }
    if (stat.size > MAX_RUN_RECORD_BYTES) {
      cache.delete(file);
      return unreadable(recordPath);
    }
    let text: string;
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch {
      cache.delete(file);
      return unreadable(recordPath);
    }
    const loaded = loadRunRecords([{ path: recordPath, text }]);
    cache.delete(file);
    cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, loaded });
    while (cache.size > MAX_CACHED_FILES) {
      const oldest = cache.keys().next();
      if (oldest.done) {
        break;
      }
      cache.delete(oldest.value);
    }
    return loaded;
  };

  const load = async (root: string): Promise<LoadedRunRecords> => {
    const directory = path.join(root, ...RUNS_DIR.split('/'));
    let names: string[];
    try {
      // The directory must not lead out of the Project, for example through a link.
      const real = await fs.promises.realpath(directory);
      if (!isInside(root, real)) {
        throw new Error(`${RUNS_DIR} resolves outside the Project`);
      }
      const entries = await fs.promises.readdir(real, { withFileTypes: true });
      names = entries
        .filter((entry) => entry.isFile() && isRunRecordFileName(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (isMissingFileError(error)) {
        return { records: [], problems: [] };
      }
      throw error;
    }
    const result: LoadedRunRecords = { records: [], problems: [] };
    for (const name of names) {
      const loaded = await loadFile(path.join(directory, name), `${RUNS_DIR}/${name}`);
      result.records.push(...loaded.records);
      result.problems.push(...loaded.problems);
    }
    return result;
  };

  return { load };
}
