import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from './atomicWrite';

/**
 * Enable/disable for filesystem skills, done by moving the skill's folder out of the
 * directory the agent scans.
 *
 * Why a move: the kernel discovers skills by walking fixed roots (`~/.agents/skills`,
 * `<project>/.agents/skills`, `.goose/skills`, `.claude/skills`). There is no "disabled"
 * flag in the skill frontmatter and no filter in the discovery code, so the only way to
 * make a skill invisible to the agent without patching Rust is to take it out of those
 * roots. Disabled skills are moved into the app's own data directory together with an
 * index, so re-enabling restores them exactly where they came from.
 *
 * Built-in skills cannot be disabled: they are compiled into the binary and have
 * synthetic `builtin://skills/<name>` paths, not directories.
 *
 * The logic here is deliberately free of Electron imports so it can be unit tested
 * against a temporary directory.
 */

export const SKILL_FILE = 'SKILL.md';
export const DISABLED_DIR = 'skills-disabled';
const INDEX_FILE = 'index.json';

export interface DisabledSkillRecord {
  /** Skill name from its frontmatter; also the folder name in the disabled store. */
  name: string;
  /** Where the folder came from, so enabling can put it back. */
  originalPath: string;
  /** ISO 8601 timestamp when the skill was disabled; index entries are sorted by name. */
  disabledAt: string;
}

export function isSafeFolderName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    path.basename(name) === name
  );
}

export function disabledSkillsRoot(appDataDir: string): string {
  return path.join(appDataDir, DISABLED_DIR);
}

export function isSkillDirectory(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, SKILL_FILE)).isFile();
  } catch {
    return false;
  }
}

export function readDisabledIndex(appDataDir: string): DisabledSkillRecord[] {
  const file = path.join(disabledSkillsRoot(appDataDir), INDEX_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is DisabledSkillRecord =>
          typeof entry?.name === 'string' &&
          isSafeFolderName(entry.name) &&
          typeof entry?.originalPath === 'string'
      )
      .map((entry) => ({
        name: entry.name,
        originalPath: entry.originalPath,
        disabledAt: typeof entry.disabledAt === 'string' ? entry.disabledAt : '',
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    // Missing or unreadable index: report nothing rather than guessing at folder contents,
    // which would offer "enable" actions that cannot be honoured.
    return [];
  }
}

function writeDisabledIndex(appDataDir: string, records: DisabledSkillRecord[]): void {
  const root = disabledSkillsRoot(appDataDir);
  fs.mkdirSync(root, { recursive: true });
  writeFileAtomicSync(path.join(root, INDEX_FILE), `${JSON.stringify(records, null, 2)}\n`);
}

export interface MoveDirectoryOps {
  renameSync?: (oldPath: fs.PathLike, newPath: fs.PathLike) => void;
  cpSync?: typeof fs.cpSync;
  rmSync?: typeof fs.rmSync;
}

/**
 * Moves a skill directory, falling back to recursive copy + remove when `renameSync`
 * fails with `EXDEV` (for example when a project workspace lives on `E:` while
 * `appDataDir` lives on `C:`).
 */
export function moveDirectorySync(from: string, to: string, ops: MoveDirectoryOps = {}): void {
  const rename = ops.renameSync ?? fs.renameSync;
  const cp = ops.cpSync ?? fs.cpSync;
  const rm = ops.rmSync ?? fs.rmSync;
  try {
    rename(from, to);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'EXDEV'
    ) {
      cp(from, to, { recursive: true });
      rm(from, { recursive: true, force: true });
      return;
    }
    throw error;
  }
}

/** A folder name inside the disabled store that is not taken yet. */
function availableFolderName(root: string, preferred: string, taken: Set<string>): string {
  let candidate = preferred;
  let suffix = 2;
  while (taken.has(candidate) || fs.existsSync(path.join(root, candidate))) {
    candidate = `${preferred}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export interface SetSkillEnabledResult {
  records: DisabledSkillRecord[];
  /** Folder name the skill now lives under, for messages. */
  location: string;
}

/**
 * Moves a skill folder into (or out of) the disabled store.
 *
 * `record.name` is what the app passes back to re-enable, so it must stay stable even if
 * the folder on disk had to be renamed to avoid a collision.
 */
export function setSkillEnabled(
  appDataDir: string,
  request: { name: string; path: string; enabled: boolean },
  moveOps?: MoveDirectoryOps
): SetSkillEnabledResult {
  const root = disabledSkillsRoot(appDataDir);
  fs.mkdirSync(root, { recursive: true });
  const records = readDisabledIndex(appDataDir);
  const { name, path: originalPath, enabled } = request;

  if (!enabled) {
    if (originalPath.startsWith('builtin://')) {
      throw new Error('内置技能随应用更新，不能停用');
    }
    if (!isSkillDirectory(originalPath)) {
      throw new Error(`不是技能目录（缺少 ${SKILL_FILE}）：${originalPath}`);
    }

    const baseName = isSafeFolderName(name)
      ? name
      : isSafeFolderName(path.basename(originalPath))
        ? path.basename(originalPath)
        : 'skill';
    const folder = availableFolderName(root, baseName, new Set(records.map((r) => r.name)));
    moveDirectorySync(originalPath, path.join(root, folder), moveOps);
    const next = [
      ...records.filter((record) => record.name !== folder),
      { name: folder, originalPath, disabledAt: new Date().toISOString() },
    ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    writeDisabledIndex(appDataDir, next);
    return { records: next, location: path.join(root, folder) };
  }

  const record = records.find((entry) => entry.name === name);
  if (!record) {
    throw new Error(`停用记录里没有「${name}」`);
  }
  const stored = path.join(root, record.name);
  if (!isSkillDirectory(stored)) {
    throw new Error(`停用的技能目录已不存在：${stored}`);
  }

  fs.mkdirSync(path.dirname(record.originalPath), { recursive: true });
  if (fs.existsSync(record.originalPath)) {
    throw new Error(`原位置已被占用，未覆盖：${record.originalPath}`);
  }
  moveDirectorySync(stored, record.originalPath, moveOps);
  const next = records.filter((entry) => entry.name !== record.name);
  writeDisabledIndex(appDataDir, next);
  return { records: next, location: record.originalPath };
}
