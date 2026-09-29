import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pbtParams } from '../test/pbt';
import {
  CheckpointService,
  resolveGit,
  type CheckpointFs,
  type CheckpointResult,
} from './checkpoints/checkpointService';

const tempDirs: string[] = [];
let gitPath: string | null = null;

beforeAll(async () => {
  const resolved = await resolveGit({});
  gitPath = resolved.ok ? resolved.value.git : null;
});

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function makeProject(): { root: string; userData: string; userGit: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-ckpt-'));
  tempDirs.push(base);
  const root = path.join(base, 'proj');
  const userData = path.join(base, 'userData');
  fs.mkdirSync(root, { recursive: true });
  const userGit = path.join(root, '.git');
  fs.mkdirSync(userGit, { recursive: true });
  fs.writeFileSync(path.join(userGit, 'config'), '[core]\n\trepositoryformatversion = 0\n');
  fs.writeFileSync(path.join(userGit, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(userGit, 'index'), 'this must never change\n');
  return { root, userData, userGit };
}

function snapshotUserGit(userGit: string): string {
  return fs.readFileSync(path.join(userGit, 'index'), 'utf8');
}

function treeOf(root: string): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        result.set(path.relative(root, full), fs.readFileSync(full));
      }
    }
  }
  return result;
}

function expectTreesEqual(actual: Map<string, Buffer>, expected: Map<string, Buffer>): void {
  expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
  for (const [key, value] of expected) {
    expect(actual.get(key)?.equals(value)).toBe(true);
  }
}

const requireGit = () => {
  if (!gitPath) {
    throw new Error('git is not available on this machine');
  }
};

function makeService(userData: string, options: { maxCheckpoints?: number; fs?: CheckpointFs } = {}) {
  return new CheckpointService({
    userDataDir: userData,
    bundledGitPath: gitPath ?? undefined,
    ...options,
  });
}

async function okOrThrow<T>(result: CheckpointResult<T>): Promise<T> {
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

// Feature: mathmodel-parity-and-beyond, Property 24: 每轮一个 Checkpoint 与保留上限
describe('Property 24: 每轮一个 Checkpoint 与保留上限', () => {
  it('creates one checkpoint per (session, turn) and keeps at most the cap', async () => {
    requireGit();
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          cap: fc.integer({ min: 2, max: 4 }),
          extra: fc.integer({ min: 1, max: 3 }),
        }),
        async ({ cap, extra }) => {
          const { root, userData, userGit } = makeProject();
          const before = snapshotUserGit(userGit);
          const service = makeService(userData, { maxCheckpoints: cap });
          const total = cap + extra;

          for (let turn = 1; turn <= total; turn += 1) {
            fs.writeFileSync(path.join(root, `turn-${turn}.txt`), `content ${turn}`);
            // Two calls for the same turn must produce a single checkpoint.
            const first = await okOrThrow(await service.ensureForTurn(root, 's1', turn));
            const second = await okOrThrow(await service.ensureForTurn(root, 's1', turn));
            expect(second.created).toBe(false);
            expect(second.checkpointId).toBe(first.checkpointId);
          }

          const list = await okOrThrow(await service.listCheckpoints(root, 100));
          const auto = list.filter((checkpoint) => checkpoint.kind === 'auto');
          expect(auto.length).toBe(cap);

          // Newest turns survive; oldest are dropped.
          const turns = auto.map((checkpoint) => checkpoint.turn).sort((a, b) => a - b);
          expect(turns).toEqual(Array.from({ length: cap }, (_, index) => extra + 1 + index));

          // The user's own `.git` is untouched.
          expect(snapshotUserGit(userGit)).toBe(before);
        }
      ),
      pbtParams
    );
  });

  it('keeps the newest 100 checkpoints when the cap is 100', async () => {
    requireGit();
    const { root, userData, userGit } = makeProject();
    const before = snapshotUserGit(userGit);
    const service = makeService(userData, { maxCheckpoints: 100 });

    for (let turn = 1; turn <= 101; turn += 1) {
      fs.writeFileSync(path.join(root, `turn-${turn}.txt`), `content ${turn}`);
      await okOrThrow(await service.ensureForTurn(root, 's1', turn));
    }

    const list = await okOrThrow(await service.listCheckpoints(root, 1000));
    const auto = list.filter((checkpoint) => checkpoint.kind === 'auto');
    expect(auto.length).toBe(100);
    const turns = auto.map((checkpoint) => checkpoint.turn);
    expect(Math.min(...turns)).toBe(2);
    expect(Math.max(...turns)).toBe(101);
    expect(snapshotUserGit(userGit)).toBe(before);
  });
});

// Feature: mathmodel-parity-and-beyond, Property 25: Checkpoint 恢复逐字节一致
describe('Property 25: Checkpoint 恢复逐字节一致', () => {
  it('restores a snapshot byte-for-byte across add/delete/modify/rename', async () => {
    requireGit();
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            name: fc.stringOf(fc.constantFrom('a', 'b', '中', '文', ' ', '0'), { minLength: 1, maxLength: 6 }),
            content: fc.uint8Array({ minLength: 0, maxLength: 16 }),
          }),
          { minLength: 1, maxLength: 4 }
        ),
        async (initialFiles) => {
          const { root, userData } = makeProject();
          const service = makeService(userData);

          const names = new Set<string>();
          for (const file of initialFiles) {
            if (names.has(file.name)) continue;
            names.add(file.name);
            fs.writeFileSync(path.join(root, file.name), Buffer.from(file.content));
          }
          await okOrThrow(await service.ensureForTurn(root, 's1', 1));
          const expected = treeOf(root);

          // Mutate: modify, add, delete.
          const first = [...names][0] ?? 'x';
          fs.writeFileSync(path.join(root, first), Buffer.from('modified'));
          fs.writeFileSync(path.join(root, 'added-新.txt'), Buffer.from([0, 1, 2, 255]));
          if (names.size > 1) {
            fs.rmSync(path.join(root, [...names][1]));
          }
          await okOrThrow(await service.ensureForTurn(root, 's1', 2));

          const list = await okOrThrow(await service.listCheckpoints(root, 10));
          const turn1 = list.find((c) => c.turn === 1);
          expect(turn1).toBeDefined();
          await okOrThrow(await service.restore(root, turn1!.id));

          expectTreesEqual(treeOf(root), expected);
        }
      ),
      pbtParams
    );
  });
});

// Feature: mathmodel-parity-and-beyond, Property 26: 恢复失败回滚
describe('Property 26: 恢复失败回滚', () => {
  function failingFs(failWritePath: string): CheckpointFs {
    return {
      realpathSync: (p) => fs.realpathSync(p),
      existsSync: (p) => fs.existsSync(p),
      mkdirSync: (p, o) => fs.mkdirSync(p, o),
      writeFileSync: (p, data) => {
        if (path.resolve(p) === path.resolve(failWritePath)) {
          throw Object.assign(new Error('EIO: injected write failure'), { code: 'EIO' });
        }
        fs.writeFileSync(p, data);
      },
      readFileSync: (p) => fs.readFileSync(p),
      unlinkSync: (p) => fs.unlinkSync(p),
      readdirSync: (p, o) => fs.readdirSync(p, o),
      lstatSync: (p) => fs.lstatSync(p),
    };
  }

  it('rolls back to the pre-restore snapshot when a file write fails', async () => {
    requireGit();
    const { root, userData } = makeProject();
    fs.writeFileSync(path.join(root, 'keep.txt'), 'original');
    const service = makeService(userData);
    await okOrThrow(await service.ensureForTurn(root, 's1', 1));

    fs.writeFileSync(path.join(root, 'keep.txt'), 'changed');
    fs.writeFileSync(path.join(root, 'new.txt'), 'new');
    await okOrThrow(await service.ensureForTurn(root, 's1', 2));
    const beforeRestore = treeOf(root);

    const checkpoints = await okOrThrow(await service.listCheckpoints(root, 10));
    const turn1 = checkpoints.find((c) => c.turn === 1)!.id;

    // The first file written during restore is `keep.txt`; fail that write.
    const failing = makeService(userData, { fs: failingFs(path.join(root, 'keep.txt')) });
    const result = await failing.restore(root, turn1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CHECKPOINT_FAILED');
    }

    // The project must be back to its pre-restore state.
    expectTreesEqual(treeOf(root), beforeRestore);
  });
});
