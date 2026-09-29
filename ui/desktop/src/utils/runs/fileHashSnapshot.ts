/**
 * Current SHA-256 of Project files (design C2 `FileHashSnapshot`, requirement 17.3), for staleness
 * detection and for run comparison and resume planning. A hash is kept together with the size and
 * modification time it was computed for, and reused while both are unchanged, so a detection pass
 * over an unchanged Project reads no file contents and stays within the five seconds.
 *
 * Paths are Project-relative with `/` separators, as in Run_Records. A path that does not exist
 * maps to `FILE_HASH_MISSING`; one that exists but cannot be read (a directory, no permission)
 * to `FILE_HASH_UNREADABLE`.
 */
import { createHash } from 'node:crypto';
import fs, { type Stats } from 'node:fs';
import path from 'node:path';
import type { FileHashSnapshot, FileHashValue } from '../../types/runRecord';
import { FILE_HASH_MISSING, FILE_HASH_UNREADABLE, isProjectRelativePath } from '../runRecord';

interface CachedHash {
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface FileHashCacheOptions {
  /** Hashes kept at most; the least recently used go first. */
  maxEntries?: number;
  /** Files hashed at the same time. */
  concurrency?: number;
  /** Computes the digest of a file; injectable so tests can count reads. */
  digest?: (file: string) => Promise<string>;
}

export interface FileHashCache {
  /** Hash of one file by absolute path. */
  hashFile: (file: string) => Promise<FileHashValue>;
  /** Hashes of `paths` inside `root`; an invalid relative path counts as unreadable. */
  snapshot: (root: string, paths: Iterable<string>) => Promise<FileHashSnapshot>;
  /** Drops every cached hash. */
  clear: () => void;
}

const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_CONCURRENCY = 8;

/** Streams the file, so large data files are not read into memory at once. */
export function sha256OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** `ENOENT` and `ENOTDIR` (a parent is a file) mean the path does not exist. */
export function isMissingFileError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Absolute path of a Project-relative `/` path, or `null` when it could leave the Project. */
export function projectFilePath(root: string, relative: string): string | null {
  if (!isProjectRelativePath(relative)) {
    return null;
  }
  return path.join(root, ...relative.split('/'));
}

export function createFileHashCache(options: FileHashCacheOptions = {}): FileHashCache {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const digest = options.digest ?? sha256OfFile;
  const cache = new Map<string, CachedHash>();

  const remember = (file: string, entry: CachedHash) => {
    cache.delete(file);
    cache.set(file, entry);
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done) {
        break;
      }
      cache.delete(oldest.value);
    }
  };

  const hashFile = async (file: string): Promise<FileHashValue> => {
    let before: Stats;
    try {
      before = await fs.promises.stat(file);
    } catch (error) {
      cache.delete(file);
      return isMissingFileError(error) ? FILE_HASH_MISSING : FILE_HASH_UNREADABLE;
    }
    if (!before.isFile()) {
      cache.delete(file);
      return FILE_HASH_UNREADABLE;
    }
    const cached = cache.get(file);
    if (cached && cached.size === before.size && cached.mtimeMs === before.mtimeMs) {
      remember(file, cached);
      return cached.sha256;
    }
    let sha256: string;
    try {
      sha256 = await digest(file);
    } catch (error) {
      cache.delete(file);
      return isMissingFileError(error) ? FILE_HASH_MISSING : FILE_HASH_UNREADABLE;
    }
    // Only cached when the file did not change while it was read.
    try {
      const after = await fs.promises.stat(file);
      if (after.size === before.size && after.mtimeMs === before.mtimeMs) {
        remember(file, { size: before.size, mtimeMs: before.mtimeMs, sha256 });
      } else {
        cache.delete(file);
      }
    } catch {
      cache.delete(file);
    }
    return sha256;
  };

  const snapshot = async (root: string, paths: Iterable<string>): Promise<FileHashSnapshot> => {
    const unique = [...new Set(paths)];
    const result = new Map<string, FileHashValue>();
    let next = 0;
    const worker = async () => {
      while (next < unique.length) {
        const relative = unique[next];
        next += 1;
        const file = projectFilePath(root, relative);
        result.set(relative, file === null ? FILE_HASH_UNREADABLE : await hashFile(file));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
    // Insertion order follows completion; rebuild it in request order.
    return new Map(
      unique.map((relative): [string, FileHashValue] => [
        relative,
        result.get(relative) ?? FILE_HASH_MISSING,
      ])
    );
  };

  return { hashFile, snapshot, clear: () => cache.clear() };
}
