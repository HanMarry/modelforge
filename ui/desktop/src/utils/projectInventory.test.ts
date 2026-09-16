import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyProjectFile, scanProject } from './projectInventory';

const tempDirs: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelforge-project-'));
  tempDirs.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('project inventory', () => {
  it('finds actual materials and ignores hidden files and dependencies', async () => {
    const root = await fixture();
    const files = [
      'data/source.csv',
      'model_plan.md',
      'code/solve.py',
      'results/summary.json',
      'figures/convergence.pdf',
      'paper/paper.tex',
      '.private/hidden.csv',
      'node_modules/package/data.csv',
    ];
    for (const file of files) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), 'test fixture');
    }
    const scan = await scanProject(root);
    expect(scan.artifacts).toHaveLength(6);
    expect(new Set(scan.artifacts.map((file) => file.stage))).toEqual(
      new Set(['inputs', 'plan', 'code', 'results', 'figures', 'paper'])
    );
    expect(scan.artifacts.every((file) => file.size > 0 && path.isAbsolute(file.path))).toBe(true);
    expect(scan.limited).toBe(false);
  });

  it.each([
    ['data/problem.docx', 'inputs'],
    ['data/map.png', 'inputs'],
    ['results/table.csv', 'results'],
    ['figures/plot.pdf', 'figures'],
    ['paper/final.pdf', 'paper'],
    ['requirements.txt', 'code'],
    ['code/plan.py', 'code'],
    ['model_plan.md', 'plan'],
    ['notes.txt', null],
  ])('classifies %s in its project context', (file, expected) => {
    expect(classifyProjectFile(file)).toBe(expected);
  });

  it('never follows a directory link outside the project', async () => {
    const root = await fixture();
    const outside = await fixture();
    await fs.writeFile(path.join(outside, 'outside.csv'), 'outside');
    await fs.symlink(
      outside,
      path.join(root, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    expect((await scanProject(root)).artifacts).toEqual([]);
  });

  it('reports an incomplete scan instead of claiming missing files', async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, 'data'));
    await fs.writeFile(path.join(root, 'data/file.csv'), 'data');
    expect((await scanProject(root, { maxDepth: 0 })).limited).toBe(true);
    expect((await scanProject(root, { maxEntries: 1 })).limited).toBe(true);
  });

  it('distinguishes an empty project from an inaccessible one', async () => {
    const root = await fixture();
    expect((await scanProject(root)).artifacts).toEqual([]);
    await expect(scanProject(path.join(root, 'missing'))).rejects.toThrow();
    await expect(scanProject('relative/path')).rejects.toThrow();
  });
});
