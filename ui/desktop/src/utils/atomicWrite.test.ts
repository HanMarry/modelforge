import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryFs, type MemoryFsFault } from '../test/memoryFs';
import { pbtParams } from '../test/pbt';
import { AtomicWriteError, RENAME_RETRIES, writeFileAtomic } from './atomicWrite';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

const noSleep = async (): Promise<void> => undefined;

const faultArb: fc.Arbitrary<MemoryFsFault | null> = fc.oneof(
  fc.constant(null),
  fc
    .constantFrom('open' as const, 'write' as const, 'sync' as const, 'close' as const)
    .map((op): MemoryFsFault => ({ op })),
  fc.constant<MemoryFsFault>({ op: 'write-partial' }),
  fc
    .record({
      code: fc.constantFrom('EPERM', 'EBUSY', 'EIO', 'EXDEV'),
      times: fc.integer({ min: 1, max: RENAME_RETRIES + 3 }),
    })
    .map(({ code, times }): MemoryFsFault => ({ op: 'rename', code, times }))
);

function expectedToSucceed(fault: MemoryFsFault | null): boolean {
  if (fault === null) {
    return true;
  }
  return (
    fault.op === 'rename' &&
    (fault.code === 'EPERM' || fault.code === 'EBUSY') &&
    fault.times <= RENAME_RETRIES
  );
}

// Feature: mathmodel-parity-and-beyond, Property 10: 原子写入
describe('Property 10: 原子写入', () => {
  it('only ever exposes the old or the new contents, and cleans up on failure', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.string(), faultArb, async (before, after, fault) => {
        const target = '/data/agent-kernel-secrets.json';
        const memory = new MemoryFs({ [target]: before });
        memory.fault = fault;
        const observed: Array<string | undefined> = [];
        memory.onChange(() => observed.push(memory.files.get(target)));

        let error: unknown = null;
        try {
          await writeFileAtomic(target, after, {
            fs: memory,
            sleep: noSleep,
            tempPath: (file) => `${file}.pending.tmp`,
          });
        } catch (caught) {
          error = caught;
        }

        for (const value of observed) {
          expect([before, after]).toContain(value);
        }
        if (expectedToSucceed(fault)) {
          expect(error).toBeNull();
          expect(memory.files.get(target)).toBe(after);
        } else {
          expect(error).toBeInstanceOf(AtomicWriteError);
          expect(memory.files.get(target)).toBe(before);
        }
        expect([...memory.files.keys()]).toEqual([target]);
      }),
      pbtParams
    );
  });
});

describe('writeFileAtomic on the real file system', () => {
  it('replaces the target and leaves no temporary files behind', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-test-'));
    tempDirs.push(dir);
    const target = path.join(dir, '密钥 文件.json');
    fs.writeFileSync(target, '{"version":1}');

    await writeFileAtomic(target, '{"version":2}');
    await writeFileAtomic(target, Buffer.from('{"version":3}', 'utf8'));

    expect(fs.readFileSync(target, 'utf8')).toBe('{"version":3}');
    expect(fs.readdirSync(dir)).toEqual([path.basename(target)]);
  });

  it('reports the stage and keeps the target when the directory is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-test-'));
    tempDirs.push(dir);
    const target = path.join(dir, 'missing', 'report.txt');

    await expect(writeFileAtomic(target, 'x')).rejects.toMatchObject({ stage: 'open' });
    expect(fs.existsSync(path.dirname(target))).toBe(false);
  });
});
