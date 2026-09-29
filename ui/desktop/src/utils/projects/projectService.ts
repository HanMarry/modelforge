/**
 * Transactional Project creation (requirements 8.3/8.8 and 9.3/9.5).
 *
 * Every creation fills a `.<name>.creating-<rand>` directory next to the destination and
 * renames it into place only after every file is copied and verified; on any failure the
 * temporary directory is removed, so the parent never contains a half-written project.
 *
 * The filesystem is injectable (`ProjectFileSystem`) so the fault-injection tests can run
 * on an in-memory stand-in (Property 18) and on a real temporary directory.
 */
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import type {
  Competition,
  ExampleManifest,
  ProjectCreateErrorCode,
  ProjectOrigin,
} from '../../types/catalog';
import { resolveUniqueDirName } from './resolveUniqueDirName';

export interface ProjectFsStat {
  size: number;
  mtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

/** The subset of `node:fs/promises` project creation needs. */
export interface ProjectFileSystem {
  exists(p: string): Promise<boolean>;
  isDirectory(p: string): Promise<boolean>;
  mkdir(p: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(p: string): Promise<string[]>;
  stat(p: string): Promise<ProjectFsStat>;
  readFile(p: string): Promise<Buffer>;
  writeFile(p: string, data: string | Buffer): Promise<void>;
  copyFile(source: string, destination: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  rm(p: string, options: { recursive: boolean; force?: boolean }): Promise<void>;
}

export class ProjectCreateError extends Error {
  readonly code: ProjectCreateErrorCode;

  constructor(code: ProjectCreateErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ProjectCreateError';
    this.code = code;
  }
}

function errorCodeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function mapFsError(error: unknown): ProjectCreateError {
  const code = errorCodeOf(error);
  const detail = error instanceof Error ? error.message : String(error);
  if (code === 'EACCES' || code === 'EPERM') {
    return new ProjectCreateError('EACCES', `无写入权限：${detail}`, error);
  }
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return new ProjectCreateError('ENOSPC', `磁盘空间不足：${detail}`, error);
  }
  if (code === 'ENOENT') {
    return new ProjectCreateError('SOURCE_MISSING', `源文件缺失：${detail}`, error);
  }
  return new ProjectCreateError('EACCES', `创建项目失败：${detail}`, error);
}

const nodeFileSystem: ProjectFileSystem = {
  exists: async (p) => {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  },
  isDirectory: async (p) => {
    try {
      return (await fs.stat(p)).isDirectory();
    } catch {
      return false;
    }
  },
  mkdir: async (p, options) => {
    await fs.mkdir(p, options);
  },
  readdir: (p) => fs.readdir(p),
  stat: async (p) => {
    const s = await fs.stat(p);
    return { size: s.size, mtimeMs: s.mtimeMs, isFile: () => s.isFile(), isDirectory: () => s.isDirectory() };
  },
  readFile: (p) => fs.readFile(p),
  writeFile: (p, data) => fs.writeFile(p, data),
  copyFile: (source, destination) => fs.copyFile(source, destination),
  rename: (source, destination) => fs.rename(source, destination),
  rm: (p, options) => fs.rm(p, options),
};

function toPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}

export const MAX_PROJECT_NAME_LENGTH = 64;

// eslint-disable-next-line no-control-regex
const FORBIDDEN_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;

/**
 * Rejects a project name that is not a single, portable directory name: the name comes over IPC
 * from the renderer, so a separator or `..` must never let it escape the chosen parent directory.
 */
export function validateProjectName(name: string): void {
  const length = Array.from(name).length;
  if (!name.trim() || length > MAX_PROJECT_NAME_LENGTH) {
    throw new ProjectCreateError('INVALID_NAME', `项目名称需为 1–${MAX_PROJECT_NAME_LENGTH} 个字符`);
  }
  if (FORBIDDEN_NAME_CHARS.test(name) || name === '.' || name === '..') {
    throw new ProjectCreateError('INVALID_NAME', `项目名称不能包含路径分隔符或特殊字符：${name}`);
  }
  if (/[. ]$/.test(name)) {
    throw new ProjectCreateError('INVALID_NAME', `项目名称不能以空格或句点结尾：${name}`);
  }
}

/** Resolves a manifest-relative path, refusing anything that points outside `baseDir`. */
function resolveInside(baseDir: string, relative: string): string {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, relative);
  if (!relative || path.isAbsolute(relative) || !resolved.startsWith(base + path.sep)) {
    throw new ProjectCreateError('SOURCE_MISSING', `示例题清单中的文件路径无效：${relative}`);
  }
  return resolved;
}

interface CreateFromTemplateRequest {
  competition: Competition;
  name: string;
  parentDir: string;
  /** template id → absolute source directory; unresolved ids fall back to the generic template. */
  templateDirs: ReadonlyMap<string, string>;
}

interface CreateFromExampleRequest {
  manifest: ExampleManifest;
  /** Absolute directory holding the example's statement, attachments, and solution. */
  exampleDir: string;
  name: string;
  parentDir: string;
}

interface ProjectServiceOptions {
  fs?: ProjectFileSystem;
  random?: () => string;
  now?: () => string;
}

const GENERIC_TEMPLATE_README = [
  '# 论文模板',
  '',
  '本赛事没有随应用提供的专用论文模板，已使用通用论文结构初始化。',
  '',
  '请按以下结构完成论文，或让智能体套用 math-paper 技能中的通用模板：',
  '',
  '1. 摘要',
  '2. 问题重述',
  '3. 问题分析',
  '4. 模型假设与符号说明',
  '5. 模型建立与求解',
  '6. 模型检验',
  '7. 模型评价与推广',
  '8. 参考文献',
  '9. 附录',
  '',
].join('\n');

export class ProjectService {
  private readonly fs: ProjectFileSystem;
  private readonly random: () => string;
  private readonly now: () => string;

  constructor(options: ProjectServiceOptions = {}) {
    this.fs = options.fs ?? nodeFileSystem;
    this.random = options.random ?? (() => randomBytes(6).toString('hex'));
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async createFromTemplate(request: CreateFromTemplateRequest): Promise<string> {
    validateProjectName(request.name);
    const origin: ProjectOrigin = {
      kind: 'competition',
      competitionId: request.competition.id,
      templateIds: [...request.competition.templateIds],
    };

    return this.createProjectTransactional(request.parentDir, request.name, async (destDir) => {
      const sourceDir = this.resolveTemplateSource(request);
      if (sourceDir) {
        await this.copyDirectory(sourceDir, destDir);
      } else {
        await this.fs.writeFile(path.join(destDir, 'README.md'), GENERIC_TEMPLATE_README);
      }
      await this.writeProjectMetadata(destDir, request.name, origin);
    });
  }

  async createFromExample(request: CreateFromExampleRequest): Promise<string> {
    validateProjectName(request.name);
    const existing = await this.listDirectoryNames(request.parentDir);
    const finalName = resolveUniqueDirName(request.name, new Set(existing));
    validateProjectName(finalName);

    const inputFiles: string[] = [];
    const origin: ProjectOrigin = { kind: 'example', exampleId: request.manifest.id, inputFiles };

    return this.createProjectTransactional(request.parentDir, finalName, async (destDir) => {
      for (const relative of [request.manifest.problemFile, ...request.manifest.attachments]) {
        const source = resolveInside(request.exampleDir, relative);
        const destination = resolveInside(destDir, relative);
        // Attachments may live in a subdirectory (e.g. `attachments/data.csv`).
        await this.fs.mkdir(path.dirname(destination), { recursive: true });
        await this.copyFileVerified(source, destination);
        inputFiles.push(toPosixPath(path.normalize(relative)));
      }
      await this.writeProjectMetadata(destDir, finalName, origin);
    });
  }

  private resolveTemplateSource(request: CreateFromTemplateRequest): string | null {
    for (const id of request.competition.templateIds) {
      const dir = request.templateDirs.get(id);
      if (dir) return dir;
    }
    return null;
  }

  private async createProjectTransactional(
    parentDir: string,
    finalName: string,
    populate: (destDir: string) => Promise<void>
  ): Promise<string> {
    const finalPath = path.join(parentDir, finalName);
    if (await this.fs.exists(finalPath)) {
      throw new ProjectCreateError('PROJECT_EXISTS', `目标目录已存在同名项目：${finalPath}`);
    }

    const tempPath = path.join(parentDir, `.${finalName}.creating-${this.random()}`);
    let created = false;
    try {
      await this.fs.mkdir(tempPath, { recursive: true });
      created = true;
      await populate(tempPath);
      await this.fs.rename(tempPath, finalPath);
    } catch (error) {
      if (created) {
        await this.fs.rm(tempPath, { recursive: true, force: true }).catch(() => undefined);
      }
      if (error instanceof ProjectCreateError) {
        throw error;
      }
      throw mapFsError(error);
    }
    return finalPath;
  }

  private async listDirectoryNames(parentDir: string): Promise<string[]> {
    try {
      const entries = await this.fs.readdir(parentDir);
      const names: string[] = [];
      for (const name of entries) {
        if (await this.fs.isDirectory(path.join(parentDir, name))) {
          names.push(name);
        }
      }
      return names;
    } catch {
      return [];
    }
  }

  private async writeProjectMetadata(
    destDir: string,
    name: string,
    origin: ProjectOrigin
  ): Promise<void> {
    const metadata = {
      schemaVersion: 1,
      id: this.random(),
      name,
      createdAt: this.now(),
      origin,
    };
    const modelforgeDir = path.join(destDir, '.modelforge');
    await this.fs.mkdir(modelforgeDir, { recursive: true });
    await this.fs.writeFile(
      path.join(modelforgeDir, 'project.json'),
      `${JSON.stringify(metadata, null, 2)}\n`
    );
  }

  private async sha256(filePath: string): Promise<string> {
    const data = await this.fs.readFile(filePath);
    return createHash('sha256').update(data).digest('hex');
  }

  /** Copies one file and verifies the copy byte-for-byte (requirement 9.3). */
  private async copyFileVerified(source: string, destination: string): Promise<void> {
    let sourceSha: string;
    try {
      sourceSha = await this.sha256(source);
    } catch (error) {
      throw new ProjectCreateError('SOURCE_MISSING', `源文件缺失：${source}`, error);
    }
    await this.fs.copyFile(source, destination);
    const destinationSha = await this.sha256(destination);
    if (sourceSha !== destinationSha) {
      throw new ProjectCreateError('SOURCE_MISSING', `复制校验不一致：${destination}`);
    }
  }

  private async copyDirectory(sourceDir: string, destDir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await this.fs.readdir(sourceDir);
    } catch (error) {
      throw new ProjectCreateError('SOURCE_MISSING', `模板目录缺失：${sourceDir}`, error);
    }
    for (const entry of entries) {
      const source = path.join(sourceDir, entry);
      const destination = path.join(destDir, entry);
      const stat = await this.fs.stat(source).catch(() => null);
      if (!stat) continue;
      if (stat.isDirectory()) {
        await this.fs.mkdir(destination, { recursive: true });
        await this.copyDirectory(source, destination);
      } else {
        await this.fs.copyFile(source, destination);
      }
    }
  }
}
