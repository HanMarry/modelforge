// @vitest-environment node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExerciseRecord } from './progress';
import {
  LEARNING_PROGRESS_FILE,
  createProgressStore,
  normalizeRecords,
  toExerciseRecord,
  upsertRecord,
} from './progressStore';

let userData: string;

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'learning-progress-'));
});

afterEach(async () => {
  await fs.rm(userData, { recursive: true, force: true });
});

const done: ExerciseRecord = {
  exerciseId: 'lp-production-plan',
  status: '已完成',
  completedAt: '2026-10-01T08:00:00.000Z',
  solutionViewed: false,
  lastSubmission: '最优解 x1 = 2, x2 = 6',
};

describe('progress records', () => {
  it('keeps only well-formed records and their known fields', () => {
    expect(toExerciseRecord({ ...done, extra: 1 })).toEqual(done);
    expect(toExerciseRecord({ exerciseId: 'a', status: '未通过', solutionViewed: true })).toEqual({
      exerciseId: 'a',
      status: '未通过',
      solutionViewed: true,
    });
    // completedAt only belongs to a completed exercise.
    expect(
      toExerciseRecord({ exerciseId: 'a', status: '未通过', solutionViewed: false, completedAt: 'x' })
    ).toEqual({ exerciseId: 'a', status: '未通过', solutionViewed: false });
    for (const value of [
      null,
      [],
      { exerciseId: '', status: '未开始', solutionViewed: false },
      { exerciseId: 'a', status: 'done', solutionViewed: false },
      { exerciseId: 'a', status: '未开始' },
      { exerciseId: 'a', status: '未开始', solutionViewed: false, lastSubmission: 3 },
    ]) {
      expect(toExerciseRecord(value)).toBeNull();
    }
  });

  it('keeps one record per exercise, the last one', () => {
    const first = { exerciseId: 'a', status: '未通过', solutionViewed: false };
    const second = { exerciseId: 'a', status: '已完成', solutionViewed: true };
    const other = { exerciseId: 'b', status: '未开始', solutionViewed: false };
    expect(normalizeRecords([first, other, 'junk', second])).toEqual([second, other]);
  });

  it('replaces or appends a record', () => {
    const other: ExerciseRecord = { exerciseId: 'b', status: '未开始', solutionViewed: false };
    const updated: ExerciseRecord = { ...done, solutionViewed: true };
    expect(upsertRecord([done, other], updated)).toEqual([updated, other]);
    expect(upsertRecord([other], done)).toEqual([other, done]);
  });
});

describe('createProgressStore', () => {
  it('starts empty and keeps what was written, across store instances', async () => {
    const store = createProgressStore(userData);
    expect(await store.read()).toEqual([]);

    await store.write([done]);

    const file = JSON.parse(await fs.readFile(path.join(userData, LEARNING_PROGRESS_FILE), 'utf8'));
    expect(file).toEqual({ version: 1, records: [done] });
    // A new store, as after a restart, reads the same records.
    expect(await createProgressStore(userData).read()).toEqual([done]);
  });

  it('writes through the atomic writer', async () => {
    const writes: string[] = [];
    const store = createProgressStore(userData, {
      writeFile: async (target, data) => {
        writes.push(target);
        await fs.writeFile(target, data);
      },
    });
    await store.write([done]);
    expect(writes).toEqual([path.join(userData, LEARNING_PROGRESS_FILE)]);
  });

  it('moves a corrupt file aside instead of overwriting it', async () => {
    const target = path.join(userData, LEARNING_PROGRESS_FILE);
    await fs.writeFile(target, '{ not json');
    const store = createProgressStore(userData, {
      now: () => new Date('2026-10-01T08:00:00.000Z'),
    });

    expect(await store.read()).toEqual([]);

    const aside = path.join(userData, 'learning-progress.corrupt-2026-10-01T08-00-00-000Z.json');
    expect(await fs.readFile(aside, 'utf8')).toBe('{ not json');
    await expect(fs.access(target)).rejects.toThrow();
  });

  it('runs exclusive tasks one after another, even after a failure', async () => {
    const store = createProgressStore(userData);
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = store.exclusive(async () => {
      order.push('first:start');
      await gate;
      order.push('first:end');
      throw new Error('first failed');
    });
    const second = store.exclusive(async () => {
      order.push('second');
      return 2;
    });
    release();

    await expect(first).rejects.toThrow('first failed');
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });
});
