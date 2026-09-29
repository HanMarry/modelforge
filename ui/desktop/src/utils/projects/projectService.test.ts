import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../../test/pbt';
import type { Competition, ExampleManifest } from '../../types/catalog';
import {
  ProjectCreateError,
  ProjectService,
  type ProjectFileSystem,
  type ProjectFsStat,
} from './projectService';

// --- In-memory filesystem with fault injection -------------------------------------------

class MemProjectFs implements ProjectFileSystem {
  private entries = new Map<string, Buffer | 'dir'>();
  private renameFault: { code: string } | null = null;
  private copyFailAt: { call: number; code: string } | null = null;
  private copyCalls = 0;

  private key(p: string): string {
    return p.replace(/\\/g, '/').replace(/\/+$/, '');
  }

  setRenameFault(code: string): void {
    this.renameFault = { code };
  }

  failCopyAt(call: number, code: string): void {
    this.copyFailAt = { call, code };
  }

  async exists(p: string): Promise<boolean> {
    return this.entries.has(this.key(p));
  }

  async isDirectory(p: string): Promise<boolean> {
    return this.entries.get(this.key(p)) === 'dir';
  }

  async mkdir(p: string, options?: { recursive?: boolean }): Promise<void> {
    const key = this.key(p);
    if (options?.recursive) {
      const parts = key.split('/').filter(Boolean);
      let current = '';
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        const existing = this.entries.get(current);
        if (existing === undefined) this.entries.set(current, 'dir');
        else if (existing !== 'dir') throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' });
      }
    }
    this.entries.set(key, 'dir');
  }

  async readdir(p: string): Promise<string[]> {
    const prefix = this.key(p);
    const names = new Set<string>();
    for (const key of this.entries.keys()) {
      if (key === prefix) continue;
      if (prefix === '' || key.startsWith(`${prefix}/`)) {
        const rest = prefix === '' ? key : key.slice(prefix.length + 1);
        names.add(rest.split('/')[0]);
      }
    }
    return [...names];
  }

  async stat(p: string): Promise<ProjectFsStat> {
    const value = this.entries.get(this.key(p));
    if (value === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    if (value === 'dir') {
      return { size: 0, mtimeMs: 0, isFile: () => false, isDirectory: () => true };
    }
    return { size: value.length, mtimeMs: 0, isFile: () => true, isDirectory: () => false };
  }

  async readFile(p: string): Promise<Buffer> {
    const value = this.entries.get(this.key(p));
    if (value === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    if (value === 'dir') throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
    return value;
  }

  async writeFile(p: string, data: string | Buffer): Promise<void> {
    this.entries.set(this.key(p), Buffer.from(data));
  }

  async copyFile(source: string, destination: string): Promise<void> {
    this.copyCalls += 1;
    if (this.copyFailAt && this.copyCalls === this.copyFailAt.call) {
      throw Object.assign(new Error('no space'), { code: this.copyFailAt.code });
    }
    const value = this.entries.get(this.key(source));
    if (value === undefined || value === 'dir') {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    this.entries.set(this.key(destination), Buffer.from(value));
  }

  async rename(source: string, destination: string): Promise<void> {
    if (this.renameFault) {
      throw Object.assign(new Error('rename failed'), { code: this.renameFault.code });
    }
    const fromKey = this.key(source);
    const toKey = this.key(destination);
    const moved: Array<[string, Buffer | 'dir']> = [];
    for (const key of this.entries.keys()) {
      if (key === fromKey || key.startsWith(`${fromKey}/`)) {
        moved.push([key, this.entries.get(key) as Buffer | 'dir']);
      }
    }
    if (moved.length === 0) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    for (const [key] of moved) this.entries.delete(key);
    for (const [key, value] of moved) {
      this.entries.set(key === fromKey ? toKey : `${toKey}${key.slice(fromKey.length)}`, value);
    }
  }

  async rm(p: string, options: { recursive: boolean; force?: boolean }): Promise<void> {
    const key = this.key(p);
    if (options.recursive) {
      for (const existing of [...this.entries.keys()]) {
        if (existing === key || existing.startsWith(`${key}/`)) {
          this.entries.delete(existing);
        }
      }
    } else {
      this.entries.delete(key);
    }
  }

  topLevelNames(dir: string): string[] {
    const prefix = this.key(dir);
    const names = new Set<string>();
    for (const key of this.entries.keys()) {
      if (key === prefix) continue;
      if (prefix === '' || key.startsWith(`${prefix}/`)) {
        const rest = prefix === '' ? key : key.slice(prefix.length + 1);
        names.add(rest.split('/')[0]);
      }
    }
    return [...names].sort();
  }
}

function makeManifest(name: string, files: string[]): ExampleManifest {
  return {
    id: 'example-1',
    title: name,
    category: '优化类',
    source: '自编',
    license: { type: 'CC BY 4.0', redistributable: true, note: '可自由使用与再分发' },
    problemFile: files[0] ?? 'problem.md',
    attachments: files.slice(1),
    solution: [{ question: '问题一', file: 'solution/q1.md' }],
  };
}

function makeCompetition(name: string): Competition {
  return {
    id: 'cumcm',
    name,
    organizer: 'o',
    website: null,
    registration: { start: null, end: null },
    contest: { start: null, end: null },
    templateIds: ['cumcm'],
    exampleIds: [],
  };
}

// 文件名与项目名只取合法的单段目录名字符：含 `/`、`\` 或 `.`/`..` 的名字会被 validateProjectName
// 拒绝，并会让内存文件系统出现空路径段（readdir 返回 ''，递归复制停不下来）。
const safeNameArb = (maxLength: number) =>
  fc.string({
    unit: fc.constantFrom('a', 'b', 'Z', '0', '_', '-', '中', '文'),
    minLength: 1,
    maxLength,
  });

// Feature: mathmodel-parity-and-beyond, Property 18: Project 创建事务无残留
describe('Property 18: Project 创建事务无残留', () => {
  it('leaves the parent and sources untouched on a failed example copy (memfs)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          files: fc.dictionary(safeNameArb(8), fc.string({ maxLength: 20 }), {
            minKeys: 1,
            maxKeys: 4,
          }),
          fault: fc.constantFrom('none', 'eacces', 'enospc', 'source-missing'),
          name: safeNameArb(10),
        }),
        async ({ files, fault, name }) => {
          const fs = new MemProjectFs();
          await fs.mkdir('/parent', { recursive: true });
          await fs.mkdir('/src', { recursive: true });
          for (const [rel, content] of Object.entries(files)) {
            await fs.writeFile(`/src/${rel}`, content);
          }
          await fs.writeFile('/parent/existing.txt', 'keep');

          const manifest = makeManifest(name, Object.keys(files));
          if (fault === 'source-missing') {
            manifest.attachments = [...manifest.attachments, 'missing.csv'];
          }
          if (fault === 'eacces') fs.setRenameFault('EACCES');
          // 至少有 1 个文件，第 1 次复制失败才保证故障一定被触发
          if (fault === 'enospc') fs.failCopyAt(1, 'ENOSPC');

          const service = new ProjectService({ fs, random: () => 'rand', now: () => 't' });
          const before = fs.topLevelNames('/parent');

          let error: unknown = null;
          try {
            await service.createFromExample({ manifest, exampleDir: '/src', name, parentDir: '/parent' });
          } catch (caught) {
            error = caught;
          }

          if (fault === 'none') {
            expect(error).toBeNull();
            expect(fs.topLevelNames('/parent')).toEqual([...before, name].sort());
          } else {
            expect(error).toBeInstanceOf(ProjectCreateError);
            expect(fs.topLevelNames('/parent')).toEqual(before);
          }

          for (const [rel, content] of Object.entries(files)) {
            expect((await fs.readFile(`/src/${rel}`)).toString()).toBe(content);
          }
        }
      ),
      pbtParams
    );
  });

  it('leaves the parent untouched on a failed template creation (memfs)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          templateFiles: fc.dictionary(safeNameArb(8), fc.string({ maxLength: 20 }), {
            minKeys: 1,
            maxKeys: 4,
          }),
          fault: fc.constantFrom('none', 'exists', 'eacces', 'enospc'),
          name: safeNameArb(10),
        }),
        async ({ templateFiles, fault, name }) => {
          const fs = new MemProjectFs();
          await fs.mkdir('/parent', { recursive: true });
          await fs.mkdir('/tpl', { recursive: true });
          for (const [rel, content] of Object.entries(templateFiles)) {
            await fs.writeFile(`/tpl/${rel}`, content);
          }
          await fs.writeFile('/parent/existing.txt', 'keep');

          if (fault === 'exists') await fs.mkdir(`/parent/${name}`, { recursive: true });
          if (fault === 'eacces') fs.setRenameFault('EACCES');
          if (fault === 'enospc') fs.failCopyAt(1, 'ENOSPC');

          const service = new ProjectService({ fs, random: () => 'rand', now: () => 't' });
          const before = fs.topLevelNames('/parent');

          let error: unknown = null;
          try {
            await service.createFromTemplate({
              competition: makeCompetition(name),
              name,
              parentDir: '/parent',
              templateDirs: new Map([['cumcm', '/tpl']]),
            });
          } catch (caught) {
            error = caught;
          }

          if (fault === 'none') {
            expect(error).toBeNull();
          } else {
            expect(error).toBeInstanceOf(ProjectCreateError);
            if (fault === 'exists') expect((error as ProjectCreateError).code).toBe('PROJECT_EXISTS');
            expect(fs.topLevelNames('/parent')).toEqual(before);
          }
        }
      ),
      pbtParams
    );
  });

  it('leaves no residue on a real filesystem', async () => {
    for (let i = 0; i < 10; i += 1) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-proj-'));
      const parent = path.join(root, 'parent');
      const src = path.join(root, 'src');
      await fs.mkdir(parent, { recursive: true });
      await fs.mkdir(src, { recursive: true });
      await fs.writeFile(path.join(src, 'problem.md'), '# problem');
      await fs.writeFile(path.join(src, 'data.csv'), 'a,b\n1,2\n');
      await fs.writeFile(path.join(parent, 'existing.txt'), 'keep');

      const service = new ProjectService({ random: () => 'rand', now: () => 'now' });
      const manifest = makeManifest('proj', ['problem.md', 'data.csv']);

      const projectDir = await service.createFromExample({
        manifest,
        exampleDir: src,
        name: 'proj',
        parentDir: parent,
      });
      expect((await fs.readdir(projectDir)).sort()).toEqual(['.modelforge', 'data.csv', 'problem.md']);

      // A missing source fails and leaves no residue.
      const before = (await fs.readdir(parent)).sort();
      const missingManifest = makeManifest('proj2', ['problem.md', 'nope.csv']);
      await expect(
        service.createFromExample({ manifest: missingManifest, exampleDir: src, name: 'proj2', parentDir: parent })
      ).rejects.toThrow();
      expect((await fs.readdir(parent)).sort()).toEqual(before);

      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

// Feature: mathmodel-parity-and-beyond, Property 20: 示例题复制完整性
describe('Property 20: 示例题复制完整性', () => {
  it('copies files with Chinese and space names byte-for-byte', async () => {
    for (let i = 0; i < 10; i += 1) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-copy-'));
      const parent = path.join(root, 'parent');
      const src = path.join(root, 'src');
      await fs.mkdir(parent, { recursive: true });
      await fs.mkdir(src, { recursive: true });

      const fileNames = ['题面.md', '附件 数据.csv', '原始 结果.xlsx'];
      const contents = ['题目正文', 'id,值\n1,中文字符串\n', 'binary-ish-内容'];
      const sourceHashes = new Map<string, string>();
      for (let j = 0; j < fileNames.length; j += 1) {
        await fs.writeFile(path.join(src, fileNames[j]), contents[j]);
        sourceHashes.set(fileNames[j], sha256(contents[j]));
      }

      const service = new ProjectService({ random: () => 'rand', now: () => 'now' });
      const manifest: ExampleManifest = {
        id: 'example-2',
        title: '示例题',
        category: '预测/统计类',
        source: '自编',
        license: { type: 'CC BY 4.0', redistributable: true, note: 'n' },
        problemFile: fileNames[0],
        attachments: fileNames.slice(1),
        solution: [{ question: '问题一', file: 'solution/q1.md' }],
      };

      const projectDir = await service.createFromExample({
        manifest,
        exampleDir: src,
        name: '示例项目',
        parentDir: parent,
      });

      for (const name of fileNames) {
        const copied = await fs.readFile(path.join(projectDir, name));
        expect(sha256(copied.toString())).toBe(sourceHashes.get(name));
      }

      for (const name of fileNames) {
        const before = await fs.readFile(path.join(src, name));
        expect(sha256(before.toString())).toBe(sourceHashes.get(name));
      }

      const metadata = JSON.parse(
        await fs.readFile(path.join(projectDir, '.modelforge', 'project.json'), 'utf8')
      );
      expect(metadata.origin.kind).toBe('example');
      expect((metadata.origin.inputFiles as string[]).sort()).toEqual([...fileNames].sort());
      expect((metadata.origin.inputFiles as string[]).some((f) => f.includes('solution'))).toBe(false);

      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
