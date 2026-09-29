import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArtifactEntry, ArtifactIndex, ArtifactStatus } from '../../types/artifactStatus';
import { RUN_ID } from '../../test/runRecordFixtures';
import { createGalleryService, findExportablePaper } from './galleryService';

const PAPER = 'paper/main.pdf';
const tempDirs: string[] = [];

function entry(entryPath: string, status: ArtifactStatus): ArtifactEntry {
  const hasRun = status !== '未开始' && status !== '已发现文件';
  return {
    path: entryPath,
    status,
    runId: hasRun ? RUN_ID : null,
    failure: status === '执行失败' ? '非零退出码' : null,
    verification:
      status === '已验证' ? { verifiedAt: '2026-09-20T10:20:05+08:00', runId: RUN_ID } : null,
    staleReasons: status === '已过期' ? [{ kind: 'input-changed', path: 'data/in.csv' }] : [],
  };
}

function indexOf(...entries: ArtifactEntry[]): ArtifactIndex {
  const byPath = Object.fromEntries(entries.map((item) => [item.path, item]));
  return { schemaVersion: 1, entries: byPath };
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

async function paperProject(): Promise<string> {
  const root = await tempDir('modelforge-gallery-');
  await fs.mkdir(path.join(root, 'paper'));
  await fs.writeFile(path.join(root, 'paper', 'main.pdf'), '%PDF-1.4\n');
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('findExportablePaper', () => {
  it('takes a paper PDF that is generated or verified', () => {
    for (const status of ['未开始', '已发现文件', '执行中', '执行失败', '已过期'] as const) {
      expect(findExportablePaper(indexOf(entry(PAPER, status)))).toBeNull();
    }
    expect(findExportablePaper(indexOf(entry(PAPER, '已生成')))?.path).toBe(PAPER);
    expect(findExportablePaper(indexOf(entry(PAPER, '已验证')))?.path).toBe(PAPER);
    // Only a PDF the Project panel files under the paper stage counts.
    expect(findExportablePaper(indexOf(entry('results/table.pdf', '已生成')))).toBeNull();
    expect(findExportablePaper(indexOf(entry('paper/main.tex', '已生成')))).toBeNull();
  });

  it('prefers a verified paper', () => {
    const index = indexOf(entry('paper/a.pdf', '已生成'), entry('paper/b.pdf', '已验证'));

    expect(findExportablePaper(index)?.path).toBe('paper/b.pdf');
    expect(
      findExportablePaper(indexOf(entry('paper/b.pdf', '已生成'), entry('paper/a.pdf', '已生成')))
        ?.path
    ).toBe('paper/a.pdf');
  });
});

describe('gallery service', () => {
  it('lists a local Project only when its paper PDF is generated or verified', async () => {
    const generated = await paperProject();
    const stale = await paperProject();
    const userData = await tempDir('modelforge-user-data-');
    const indexes = new Map([
      [generated, indexOf(entry(PAPER, '已生成'))],
      [stale, indexOf(entry(PAPER, '已过期'))],
    ]);
    const service = createGalleryService({
      userDataDir: userData,
      recentDirs: () => [generated, stale],
      sensitiveValues: () => [],
      modelforgeVersion: () => '1.50.0',
      artifactIndex: async (projectDir) => indexes.get(projectDir) ?? indexOf(),
    });

    expect(await service.listLocal()).toEqual([
      {
        id: `local:${generated}`,
        source: 'local',
        pdfPath: path.join(generated, 'paper', 'main.pdf'),
        projectDir: generated,
      },
    ]);
  });

  it('refuses to export a Project without a generated or verified paper PDF', async () => {
    const root = await paperProject();
    const service = createGalleryService({
      userDataDir: await tempDir('modelforge-user-data-'),
      recentDirs: () => [],
      sensitiveValues: () => [],
      modelforgeVersion: () => '1.50.0',
      artifactIndex: async () => indexOf(entry(PAPER, '已发现文件')),
    });

    const result = await service.exportShare({
      projectDir: root,
      title: 'Paper',
      competition: 'CUMCM',
      category: 'Optimization',
      abstract: 'Abstract',
      checked: [],
      targetDir: root,
      modelforgeVersion: '1.50.0',
    });

    expect(result).toEqual({ ok: false, code: 'NO_PDF' });
    expect((await fs.readdir(root)).filter((name) => name.endsWith('.zip'))).toEqual([]);
  });
});
