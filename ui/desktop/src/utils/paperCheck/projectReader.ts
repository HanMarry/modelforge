/**
 * Read-only access to a Project for the paper check (spec mathmodel-parity-and-beyond,
 * requirement 18.9): files are only ever opened with `O_RDONLY` (plus `O_NOFOLLOW` where the
 * platform has it) and nothing here writes, renames or calls `utimes`, so contents and
 * modification times stay as they were.
 *
 * Follows the pattern of `desktopFileAccess.ts`: the project root is resolved with `realpath`,
 * symbolic links are never followed (the listing skips them and a file whose identity changed
 * between listing and opening is refused), and only files from the listing can be read, so a
 * path from a paper source cannot reach outside the project.
 *
 * The listing skips dot directories except `.modelforge/runs`, and the usual tool directories
 * (`node_modules`, `__pycache__`, virtual environments).
 */

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';

export interface ProjectEntry {
  /** Project-relative path with `/` separators. */
  path: string;
  mtimeMs: number;
  size: number;
}

export interface ProjectReader {
  /** Regular files of the project, breadth first, symbolic links excluded. */
  list(): Promise<ProjectEntry[]>;
  /** UTF-8 (or GB18030 when not valid UTF-8) text; `null` if unlisted, gone or too large. */
  readText(relativePath: string, maxBytes?: number): Promise<string | null>;
  /** Raw bytes; `null` if unlisted, gone or too large. */
  readBytes(relativePath: string, maxBytes?: number): Promise<Uint8Array | null>;
  /** Lowercase hexadecimal SHA-256 of the content; `null` if unlisted, gone or too large. */
  sha256(relativePath: string, maxBytes?: number): Promise<string | null>;
}

export interface ProjectReaderLimits {
  maxFiles?: number;
  maxDepth?: number;
}

const DEFAULT_MAX_FILES = 20000;
const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '__pycache__',
  'venv',
  'env',
  'site-packages',
]);

const NO_FOLLOW = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;

interface ListedFile extends ProjectEntry {
  dev: number;
  ino: number;
}

interface PendingDirectory {
  dir: string;
  relative: string;
  depth: number;
}

/** `.modelforge` only at the root and only its `runs`; no other dot or tool directory. */
function isListedDirectory(parent: string, name: string): boolean {
  if (parent === '.modelforge') {
    return name === 'runs';
  }
  if (name === '.modelforge') {
    return parent === '';
  }
  return !name.startsWith('.') && !SKIPPED_DIRECTORIES.has(name.toLowerCase());
}

function decodeText(bytes: Uint8Array): string {
  const withoutBom =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(withoutBom);
  } catch {
    // Chinese LaTeX sources are sometimes saved in GBK.
    try {
      return new TextDecoder('gb18030').decode(withoutBom);
    } catch {
      return new TextDecoder('utf-8').decode(withoutBom);
    }
  }
}

/**
 * A reader for the project at `root`. Rejects when `root` is not a directory.
 */
export async function createProjectReader(
  root: string,
  limits: ProjectReaderLimits = {}
): Promise<ProjectReader> {
  const realRoot = await fs.realpath(root);
  if (!(await fs.stat(realRoot)).isDirectory()) {
    throw new Error('The project root is not a directory');
  }
  const maxFiles = limits.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = limits.maxDepth ?? DEFAULT_MAX_DEPTH;
  let listed: Map<string, ListedFile> | null = null;

  const walk = async (): Promise<Map<string, ListedFile>> => {
    const files = new Map<string, ListedFile>();
    const queue: PendingDirectory[] = [{ dir: realRoot, relative: '', depth: 0 }];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      if (files.size >= maxFiles) {
        break;
      }
      const { dir, relative, depth } = next;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
      if (entries === null) {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (files.size >= maxFiles) {
          break;
        }
        const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
        const childPath = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.isDirectory()) {
          if (isListedDirectory(relative, entry.name) && depth < maxDepth) {
            queue.push({ dir: childPath, relative: childRelative, depth: depth + 1 });
          }
          continue;
        }
        // Inside `.modelforge/` only the project metadata is read (and `runs/` below it).
        if (!entry.isFile() || (relative === '.modelforge' && entry.name !== 'project.json')) {
          continue;
        }
        try {
          const stat = await fs.lstat(childPath);
          if (stat.isFile()) {
            files.set(childRelative, {
              path: childRelative,
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              dev: stat.dev,
              ino: stat.ino,
            });
          }
        } catch {
          // The file disappeared while the project was being listed.
        }
      }
    }
    return files;
  };

  const ensureListed = async (): Promise<Map<string, ListedFile>> => {
    if (listed === null) {
      listed = await walk();
    }
    return listed;
  };

  /** Opens a listed file read-only and hands its content to `use`; `null` when refused. */
  const withContent = async <T>(
    relativePath: string,
    maxBytes: number,
    consume: (bytes: Uint8Array) => T
  ): Promise<T | null> => {
    const file = (await ensureListed()).get(relativePath);
    if (file === undefined || file.size > maxBytes) {
      return null;
    }
    const absolute = path.join(realRoot, ...relativePath.split('/'));
    let handle: FileHandle | null = null;
    try {
      handle = await fs.open(absolute, fsConstants.O_RDONLY | NO_FOLLOW);
      const stat = await handle.stat();
      const sameFile = stat.isFile() && stat.dev === file.dev && stat.ino === file.ino;
      if (!sameFile || stat.size > maxBytes) {
        return null;
      }
      return consume(await handle.readFile());
    } catch {
      return null;
    } finally {
      await handle?.close();
    }
  };

  return {
    list: async () =>
      [...(await ensureListed()).values()].map(({ path: file, mtimeMs, size }) => ({
        path: file,
        mtimeMs,
        size,
      })),
    readText: (relativePath, maxBytes = DEFAULT_MAX_BYTES) =>
      withContent(relativePath, maxBytes, decodeText),
    readBytes: (relativePath, maxBytes = DEFAULT_MAX_BYTES) =>
      withContent(relativePath, maxBytes, (bytes) => bytes),
    sha256: (relativePath, maxBytes = DEFAULT_MAX_BYTES) =>
      withContent(relativePath, maxBytes, (bytes) =>
        createHash('sha256').update(bytes).digest('hex')
      ),
  };
}
