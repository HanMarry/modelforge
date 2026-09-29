import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '../../test/runRecordFixtures';
import { FILE_HASH_MISSING, FILE_HASH_UNREADABLE } from '../runRecord';
import { createFileHashCache, projectFilePath, sha256OfFile } from './fileHashSnapshot';

const tempDirs: string[] = [];

async function project(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelforge-hashes-'));
  tempDirs.push(root);
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('file hash snapshot', () => {
  it('hashes files and tells missing and unreadable ones apart', async () => {
    const root = await project({ 'data/in.csv': 'x,y\n', 'results/out.csv': '中文,1\n' });
    const cache = createFileHashCache();

    const snapshot = await cache.snapshot(root, [
      'results/out.csv',
      'data/in.csv',
      'data/gone.csv',
      'data',
      '../outside.csv',
      'data/in.csv',
    ]);

    expect([...snapshot.entries()]).toEqual([
      ['results/out.csv', sha256('中文,1\n')],
      ['data/in.csv', sha256('x,y\n')],
      ['data/gone.csv', FILE_HASH_MISSING],
      ['data', FILE_HASH_UNREADABLE],
      ['../outside.csv', FILE_HASH_UNREADABLE],
    ]);
    expect(await sha256OfFile(path.join(root, 'data', 'in.csv'))).toBe(sha256('x,y\n'));
  });

  it('reuses a hash while the size and modification time stay the same', async () => {
    const root = await project({ 'data/in.csv': 'first\n' });
    const file = path.join(root, 'data', 'in.csv');
    const digest = vi.fn(sha256OfFile);
    const cache = createFileHashCache({ digest });

    expect(await cache.hashFile(file)).toBe(sha256('first\n'));
    expect(await cache.hashFile(file)).toBe(sha256('first\n'));
    expect(digest).toHaveBeenCalledTimes(1);

    await fs.writeFile(file, 'second, longer\n');
    expect(await cache.hashFile(file)).toBe(sha256('second, longer\n'));
    expect(digest).toHaveBeenCalledTimes(2);

    // Same size, new modification time.
    await fs.writeFile(file, 'third, longer!\n');
    const later = new Date(Date.now() + 5000);
    await fs.utimes(file, later, later);
    expect(await cache.hashFile(file)).toBe(sha256('third, longer!\n'));
    expect(digest).toHaveBeenCalledTimes(3);

    cache.clear();
    await cache.hashFile(file);
    expect(digest).toHaveBeenCalledTimes(4);

    await fs.rm(file);
    expect(await cache.hashFile(file)).toBe(FILE_HASH_MISSING);
  });

  it('keeps at most the configured number of hashes', async () => {
    const root = await project({ 'a.csv': 'a', 'b.csv': 'b' });
    const digest = vi.fn(sha256OfFile);
    const cache = createFileHashCache({ digest, maxEntries: 1 });

    await cache.snapshot(root, ['a.csv']);
    await cache.snapshot(root, ['b.csv']);
    await cache.snapshot(root, ['a.csv']);
    expect(digest).toHaveBeenCalledTimes(3);
  });

  it('maps Project-relative paths into the Project only', () => {
    const root = path.resolve('/project');
    expect(projectFilePath(root, 'results/out.csv')).toBe(path.join(root, 'results', 'out.csv'));
    expect(projectFilePath(root, '../escape.csv')).toBeNull();
    expect(projectFilePath(root, '/etc/passwd')).toBeNull();
    expect(projectFilePath(root, 'C:/Windows/win.ini')).toBeNull();
    expect(projectFilePath(root, '')).toBeNull();
  });
});
