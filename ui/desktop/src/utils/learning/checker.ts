/**
 * Deterministic learning-path checks (task 27.2, requirements 20.2 and 20.6), run in the main
 * process against the exercise's Project. `file-exists` and `number-in-range` items get a verdict
 * here; `subjective` items are judged by the Kernel from {@link readReviewMaterials}. The check
 * items come from `src/catalog/learning-path.json`, which `scripts/check-skills.js` validates.
 *
 * Every path stays inside the Project: it must be Project-relative, and after resolving links
 * (`fs.realpath`) it must still lie under the Project's real path. Failure reasons are shown to
 * the learner, so they say what is wrong without revealing the expected value.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  FileExistsCheck,
  LearningCheck,
  LearningExercise,
  LearningFileExcerpt,
  LearningReviewMaterials,
  NumberInRangeCheck,
  SubjectiveCheck,
} from '../../types/learningApi';
import type { CheckResult } from './progress';

/** JSON files read by `number-in-range` items are capped at this size. */
export const MAX_JSON_BYTES = 1024 * 1024;
/** Each file handed to the Kernel is cut to this many bytes. */
export const MAX_EXCERPT_BYTES = 24 * 1024;

/** The Project directory itself is missing or not a directory: the check cannot run (20.6). */
export class ProjectDirError extends Error {
  constructor(projectDir: string, cause?: unknown) {
    super(`Project directory ${projectDir} is not an accessible directory`, { cause });
    this.name = 'ProjectDirError';
  }
}

/** A `/`-separated path inside the Project: not absolute, no empty, `.` or `..` segment. */
export function isProjectRelativePath(value: string): boolean {
  if (value.trim() === '' || value.includes('\\') || value.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Real path of the Project directory; throws {@link ProjectDirError} when it is unusable. */
export async function resolveProjectDir(projectDir: string): Promise<string> {
  if (!path.isAbsolute(projectDir)) throw new ProjectDirError(projectDir);
  try {
    const real = await fs.realpath(projectDir);
    if (!(await fs.stat(real)).isDirectory()) throw new ProjectDirError(projectDir);
    return real;
  } catch (error) {
    if (error instanceof ProjectDirError) throw error;
    throw new ProjectDirError(projectDir, error);
  }
}

type ResolvedFile = { ok: true; file: string; size: number } | { ok: false; reason: string };

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;

/** Resolves a Project-relative file under `root` (the Project's real path). */
async function resolveProjectFile(root: string, relative: string): Promise<ResolvedFile> {
  if (!isProjectRelativePath(relative)) {
    return { ok: false, reason: `路径 ${relative} 不是项目内的相对路径` };
  }
  let real: string;
  try {
    real = await fs.realpath(path.join(root, ...relative.split('/')));
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, reason: `找不到文件 ${relative}` };
    }
    return { ok: false, reason: `无法读取 ${relative}（${code ?? 'unknown error'}）` };
  }
  if (!real.startsWith(root + path.sep)) {
    return { ok: false, reason: `${relative} 指向项目目录之外` };
  }
  try {
    const stat = await fs.stat(real);
    if (!stat.isFile()) return { ok: false, reason: `${relative} 不是文件` };
    return { ok: true, file: real, size: stat.size };
  } catch (error) {
    return { ok: false, reason: `无法读取 ${relative}（${errorCode(error) ?? 'unknown error'}）` };
  }
}

async function checkFileExists(root: string, check: FileExistsCheck): Promise<CheckResult> {
  const resolved = await resolveProjectFile(root, check.path);
  return resolved.ok
    ? { checkId: check.id, passed: true, reason: `已找到 ${check.path}` }
    : { checkId: check.id, passed: false, reason: resolved.reason };
}

async function checkNumberInRange(root: string, check: NumberInRangeCheck): Promise<CheckResult> {
  const fail = (reason: string): CheckResult => ({ checkId: check.id, passed: false, reason });
  const resolved = await resolveProjectFile(root, check.path);
  if (!resolved.ok) return fail(resolved.reason);
  if (resolved.size > MAX_JSON_BYTES) return fail(`${check.path} 超过 1 MB，没有读取`);

  let data: unknown;
  try {
    const text = await fs.readFile(resolved.file, 'utf8');
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    return error instanceof SyntaxError
      ? fail(`${check.path} 不是合法的 JSON`)
      : fail(`无法读取 ${check.path}（${errorCode(error) ?? 'unknown error'}）`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return fail(`${check.path} 的顶层不是 JSON 对象`);
  }
  if (!Object.prototype.hasOwnProperty.call(data, check.field)) {
    return fail(`${check.path} 里没有 ${check.field} 字段`);
  }
  const value = (data as Record<string, unknown>)[check.field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail(`${check.path} 里 ${check.field} 的值不是数字`);
  }
  if (value < check.min || value > check.max) {
    return fail(`${check.field} = ${value}，结果不正确`);
  }
  return { checkId: check.id, passed: true, reason: `${check.field} = ${value}` };
}

/**
 * Verdicts on the deterministic items of `exercise`, in catalogue order; subjective items are
 * skipped. Throws {@link ProjectDirError} when the Project directory is unusable.
 */
export async function runDeterministicChecks(
  projectDir: string,
  exercise: Pick<LearningExercise, 'checks'>
): Promise<CheckResult[]> {
  const root = await resolveProjectDir(projectDir);
  const results: CheckResult[] = [];
  for (const check of exercise.checks) {
    if (check.kind === 'file-exists') results.push(await checkFileExists(root, check));
    if (check.kind === 'number-in-range') results.push(await checkNumberInRange(root, check));
  }
  return results;
}

export const isSubjectiveCheck = (check: LearningCheck): check is SubjectiveCheck =>
  check.kind === 'subjective';

async function readExcerpt(root: string, relative: string): Promise<LearningFileExcerpt> {
  const resolved = await resolveProjectFile(root, relative);
  if (!resolved.ok) return { path: relative, content: null, truncated: false };
  try {
    const handle = await fs.open(resolved.file, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(resolved.size, MAX_EXCERPT_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      // A multi-byte character cut at the limit decodes as U+FFFD; that is fine for a review.
      const content = buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '');
      return { path: relative, content, truncated: resolved.size > bytesRead };
    } finally {
      await handle.close();
    }
  } catch {
    return { path: relative, content: null, truncated: false };
  }
}

/**
 * The subjective items of `exercise` and the Project files they name (each file once, in
 * catalogue order), for the Kernel to judge. Throws {@link ProjectDirError} when the Project
 * directory is unusable.
 */
export async function readReviewMaterials(
  projectDir: string,
  exercise: Pick<LearningExercise, 'id' | 'checks'>
): Promise<LearningReviewMaterials> {
  const root = await resolveProjectDir(projectDir);
  const checks = exercise.checks.filter(isSubjectiveCheck);
  const paths = [...new Set(checks.flatMap((check) => check.files ?? []))];
  const files: LearningFileExcerpt[] = [];
  for (const relative of paths) {
    files.push(await readExcerpt(root, relative));
  }
  return { exerciseId: exercise.id, checks, files };
}
