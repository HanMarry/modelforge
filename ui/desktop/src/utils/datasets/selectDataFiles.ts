/**
 * Data-file discovery for the dataset library (requirement 10.1): walk the project tree to
 * at most five levels, keep the four whitelisted extensions (case-insensitive), sort by
 * last-modified time descending, and cap the visible list at 1000 while reporting the total.
 */
import path from 'node:path';
import type { DataFileEntry, DataFileListResult } from '../../types/datasets';

export const DATA_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.csv',
  '.xlsx',
  '.json',
  '.parquet',
]);

export const MAX_DATA_FILE_DEPTH = 5;
export const MAX_DATA_FILES = 1000;

/** Minimal filesystem surface, injectable for the property test. */
export interface DataFileFs {
  readdir(p: string): Promise<string[]>;
  stat(p: string): Promise<DataFileFsStat>;
}

export interface DataFileFsStat {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
  mtimeMs: number;
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}

function hasAllowedExtension(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return DATA_FILE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

async function walk(
  dir: string,
  relDir: string,
  depth: number,
  maxDepth: number,
  f: DataFileFs,
  acc: DataFileEntry[]
): Promise<void> {
  if (depth > maxDepth) return;
  const entries = await f.readdir(dir).catch(() => []);
  for (const name of entries) {
    const fullPath = path.join(dir, name);
    const stat = await f.stat(fullPath).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) {
      await walk(fullPath, path.join(relDir, name), depth + 1, maxDepth, f, acc);
    } else if (stat.isFile() && hasAllowedExtension(name)) {
      acc.push({
        relativePath: toPosixPath(path.join(relDir, name)),
        name,
        size: stat.size,
        modifiedAt: stat.mtimeMs,
      });
    }
  }
}

export interface SelectDataFilesOptions {
  maxDepth?: number;
  maxFiles?: number;
}

export async function selectDataFiles(
  root: string,
  f: DataFileFs,
  options: SelectDataFilesOptions = {}
): Promise<DataFileListResult> {
  const maxDepth = options.maxDepth ?? MAX_DATA_FILE_DEPTH;
  const maxFiles = options.maxFiles ?? MAX_DATA_FILES;

  const found: DataFileEntry[] = [];
  await walk(root, '', 0, maxDepth, f, found);

  found.sort((a, b) => b.modifiedAt - a.modifiedAt);
  const total = found.length;
  const files = found.slice(0, maxFiles);

  return { files, total, truncated: total > maxFiles };
}
