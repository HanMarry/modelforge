import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../../test/pbt';
import {
  DATA_FILE_EXTENSIONS,
  MAX_DATA_FILES,
  selectDataFiles,
  type DataFileFs,
  type DataFileFsStat,
} from './selectDataFiles';

interface Node {
  kind: 'dir' | 'file';
  size: number;
  mtimeMs: number;
}

class TreeFs implements DataFileFs {
  private readonly nodes: Map<string, Node>;

  constructor(nodes: Map<string, Node>) {
    this.nodes = nodes;
  }

  async readdir(p: string): Promise<string[]> {
    const prefix = p === '' ? '' : `${p.replace(/\\/g, '/').replace(/\/$/, '')}/`;
    const names = new Set<string>();
    for (const key of this.nodes.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!rest) continue;
      const first = rest.split('/')[0];
      names.add(first);
    }
    return [...names];
  }

  async stat(p: string): Promise<DataFileFsStat> {
    const key = p.replace(/\\/g, '/').replace(/\/$/, '');
    const node = this.nodes.get(key);
    if (!node) throw new Error('ENOENT');
    return {
      isFile: () => node.kind === 'file',
      isDirectory: () => node.kind === 'dir',
      size: node.size,
      mtimeMs: node.mtimeMs,
    };
  }
}

/** Builds an in-memory tree from a set of relative file paths. */
function treeFromFiles(files: Array<{ path: string; size: number; mtimeMs: number }>): TreeFs {
  const nodes = new Map<string, Node>();
  for (const file of files) {
    const segments = file.path.split('/');
    for (let i = 1; i <= segments.length; i += 1) {
      const prefix = segments.slice(0, i).join('/');
      const isFile = i === segments.length;
      if (isFile) {
        nodes.set(prefix, { kind: 'file', size: file.size, mtimeMs: file.mtimeMs });
      } else if (!nodes.has(prefix)) {
        nodes.set(prefix, { kind: 'dir', size: 0, mtimeMs: 0 });
      }
    }
  }
  return new TreeFs(nodes);
}

const allowedExts = [...DATA_FILE_EXTENSIONS];
const extArb = fc.oneof(
  ...allowedExts.map((ext) => fc.constant(ext)),
  ...allowedExts.map((ext) => fc.constant(ext.toUpperCase())),
  fc.constant('.txt'),
  fc.constant('.csv.bak')
);

// 文件名只用不含路径分隔符的字符：`/`、`\` 会让生成的路径与内存树的层级对不上
const fileArb = fc.record({
  depth: fc.integer({ min: 0, max: 8 }),
  name: fc.string({
    unit: fc.constantFrom('a', 'b', 'Z', '0', ' ', '_', '-', '.', '中'),
    minLength: 1,
    maxLength: 8,
  }),
  ext: extArb,
  size: fc.integer({ min: 0, max: 1_000_000 }),
  mtimeMs: fc.integer({ min: 0, max: 4_000_000_000 }),
});

type GeneratedFile = { depth: number; name: string; ext: string };

function pathOf(f: GeneratedFile): string {
  const dirs = f.depth === 0 ? '' : Array.from({ length: f.depth }, () => 'd').join('/') + '/';
  return `${dirs}${f.name}${f.ext}`;
}

// 同一路径只出现一次：内存树按路径去重，重复路径会让期望数多于实际文件数
const treeArb = fc
  .uniqueArray(fileArb, { minLength: 1, maxLength: 60, selector: pathOf })
  .map((files) =>
    files.map((f) => ({
      path: pathOf(f),
      size: f.size,
      mtimeMs: f.mtimeMs,
    }))
  );

function depthOf(relativePath: string): number {
  return relativePath.split('/').length - 1;
}

function isAllowed(relativePath: string): boolean {
  const name = relativePath.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return DATA_FILE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

// Feature: mathmodel-parity-and-beyond, Property 22: 数据文件列表规则
describe('Property 22: 数据文件列表规则', () => {
  it('lists only whitelisted, depth-bounded files sorted by mtime desc', async () => {
    await fc.assert(
      fc.asyncProperty(treeArb, async (files) => {
        const fs = treeFromFiles(files);
        const result = await selectDataFiles('', fs);

        for (const entry of result.files) {
          expect(depthOf(entry.relativePath)).toBeLessThanOrEqual(5);
          expect(isAllowed(entry.relativePath)).toBe(true);
        }

        const times = result.files.map((f) => f.modifiedAt);
        for (let i = 1; i < times.length; i += 1) {
          expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
        }

        const expected = files.filter(
          (f) => depthOf(f.path) <= 5 && isAllowed(f.path)
        );
        expect(result.total).toBe(expected.length);
        expect(result.files.length).toBe(Math.min(expected.length, MAX_DATA_FILES));
        expect(result.truncated).toBe(expected.length > MAX_DATA_FILES);
      }),
      pbtParams
    );
  });

  it('caps the list and reports the total', async () => {
    const files = Array.from({ length: 12 }, (_, i) => ({
      path: `f${i}.csv`,
      size: 1,
      mtimeMs: 1000 - i,
    }));
    const result = await selectDataFiles('', treeFromFiles(files), { maxFiles: 5 });
    expect(result.total).toBe(12);
    expect(result.files).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });
});
