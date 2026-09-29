/**
 * Host-side file selection for a LAN collab session (requirement 14.2, 14.5).
 *
 * The host picks files from the open Project; only text files inside the Project root that no
 * forced exclusion rule rejects (credentials, session logs, env files, content embedding a known
 * secret) can be shared, and guest edits are written back only to those files inside that root.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { forcedExclusionReason } from '../gallery/shareFilter';
import type { SharedFile } from './collabService';

/** Extensions of plain-text files a collaborator can meaningfully edit line by line. */
export const COLLAB_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.tex',
  '.bib',
  '.typ',
  '.md',
  '.txt',
  '.py',
  '.r',
  '.m',
  '.jl',
  '.csv',
  '.json',
  '.yaml',
  '.yml',
]);

export const MAX_COLLAB_FILE_BYTES = 1024 * 1024;
export const MAX_COLLAB_CANDIDATES = 500;
const MAX_DEPTH = 5;
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__']);

export type CollabSkipReason = 'excluded' | 'sensitive-content' | 'too-large' | 'unreadable';

export interface CollabSkippedFile {
  path: string;
  reason: CollabSkipReason;
}

export interface LoadedShareFiles {
  files: SharedFile[];
  skipped: CollabSkippedFile[];
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Resolves a Project-relative path, refusing anything that leaves the Project root (absolute
 * paths, `..` segments) so a guest can never make the host write outside the shared Project.
 */
export function resolveInsideProject(projectRoot: string, relativePath: string): string | null {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) {
    return null;
  }
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, relativePath);
  return resolved.startsWith(root + path.sep) ? resolved : null;
}

/** Lists the Project's text files a host may offer, forced exclusions already removed. */
export async function listShareCandidates(projectRoot: string): Promise<string[]> {
  const root = path.resolve(projectRoot);
  const result: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || result.length >= MAX_COLLAB_CANDIDATES) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (result.length >= MAX_COLLAB_CANDIDATES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) {
          await walk(full, depth + 1);
        }
      } else if (entry.isFile()) {
        const relative = toPosix(path.relative(root, full));
        if (
          COLLAB_TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
          forcedExclusionReason(relative) === null
        ) {
          result.push(relative);
        }
      }
    }
  };

  await walk(root, 0);
  return result;
}

/**
 * Reads the chosen files for sharing. A file is skipped (and reported) when a forced rule
 * excludes it, it embeds one of `secretValues`, it exceeds the size cap, or it cannot be read.
 */
export async function loadShareFiles(
  projectRoot: string,
  relativePaths: readonly string[],
  secretValues: readonly string[]
): Promise<LoadedShareFiles> {
  const files: SharedFile[] = [];
  const skipped: CollabSkippedFile[] = [];
  const secrets = secretValues.filter((value) => value.length > 4);
  const seen = new Set<string>();

  for (const raw of relativePaths) {
    const relative = toPosix(path.normalize(raw));
    if (seen.has(relative)) continue;
    seen.add(relative);

    const absolute = resolveInsideProject(projectRoot, relative);
    if (!absolute || forcedExclusionReason(relative) !== null) {
      skipped.push({ path: relative, reason: 'excluded' });
      continue;
    }
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) {
        skipped.push({ path: relative, reason: 'unreadable' });
        continue;
      }
      if (stat.size > MAX_COLLAB_FILE_BYTES) {
        skipped.push({ path: relative, reason: 'too-large' });
        continue;
      }
      const content = await fs.readFile(absolute, 'utf8');
      if (secrets.some((secret) => content.includes(secret))) {
        skipped.push({ path: relative, reason: 'sensitive-content' });
        continue;
      }
      files.push({ path: relative, content });
    } catch {
      skipped.push({ path: relative, reason: 'unreadable' });
    }
  }

  return { files, skipped };
}
