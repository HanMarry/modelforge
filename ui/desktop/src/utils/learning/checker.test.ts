// @vitest-environment node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import learningPath from '../../catalog/learning-path.json';
import type { LearningCatalog, LearningCheck } from '../../types/learningApi';
import {
  MAX_EXCERPT_BYTES,
  ProjectDirError,
  isProjectRelativePath,
  readReviewMaterials,
  runDeterministicChecks,
} from './checker';

const catalog = learningPath as unknown as LearningCatalog;

let project: string;

beforeEach(async () => {
  project = await fs.mkdtemp(path.join(os.tmpdir(), 'learning-checker-'));
});

afterEach(async () => {
  await fs.rm(project, { recursive: true, force: true });
});

async function write(relative: string, content: string): Promise<void> {
  const target = path.join(project, ...relative.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

const range = (field: string, min: number, max: number): LearningCheck => ({
  id: `range-${field}`,
  kind: 'number-in-range',
  description: field,
  path: 'results/answer.json',
  field,
  min,
  max,
});

describe('runDeterministicChecks', () => {
  it('checks that a file exists inside the Project', async () => {
    await write('data/clean.csv', 'date,temperature\n');
    const checks: LearningCheck[] = [
      { id: 'present', kind: 'file-exists', description: '', path: 'data/clean.csv' },
      { id: 'absent', kind: 'file-exists', description: '', path: 'data/missing.csv' },
      { id: 'folder', kind: 'file-exists', description: '', path: 'data' },
      { id: 'outside', kind: 'file-exists', description: '', path: '../escape.csv' },
    ];

    const results = await runDeterministicChecks(project, { checks });

    expect(results.map(({ checkId, passed }) => [checkId, passed])).toEqual([
      ['present', true],
      ['absent', false],
      ['folder', false],
      ['outside', false],
    ]);
    expect(results[1].reason).toContain('data/missing.csv');
  });

  it('reads a number from a JSON file and compares it with the range', async () => {
    await write(
      'results/answer.json',
      '\uFEFF{"missing": 3, "outliers": 2, "label": "3", "big": 1e400, "nested": {"x": 1}}'
    );
    const checks = [
      range('missing', 3, 3),
      range('outliers', 1, 1),
      range('label', 0, 10),
      range('big', 0, 10),
      range('absent', 0, 10),
      range('nested', 0, 10),
    ];

    const results = await runDeterministicChecks(project, { checks });

    expect(results.map((result) => result.passed)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    // The reason names the submitted value but not the expected range.
    expect(results[1].reason).toContain('outliers = 2');
    expect(results[1].reason).not.toContain('1, 1');
    expect(results[2].reason).toContain('不是数字');
    expect(results[4].reason).toContain('absent');
  });

  it('fails number checks on missing, malformed or non-object JSON', async () => {
    const check = range('value', 0, 1);
    expect((await runDeterministicChecks(project, { checks: [check] }))[0]).toMatchObject({
      passed: false,
      reason: expect.stringContaining('找不到文件'),
    });

    await write('results/answer.json', '{"value": 0.5');
    expect((await runDeterministicChecks(project, { checks: [check] }))[0].reason).toContain(
      '不是合法的 JSON'
    );

    await write('results/answer.json', '[0.5]');
    expect((await runDeterministicChecks(project, { checks: [check] }))[0].reason).toContain(
      '顶层不是 JSON 对象'
    );
  });

  it('skips subjective items', async () => {
    const results = await runDeterministicChecks(project, {
      checks: [{ id: 'notes', kind: 'subjective', description: 'notes', files: ['notes.md'] }],
    });
    expect(results).toEqual([]);
  });

  it('refuses a link that leads out of the Project', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'learning-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'answer.json'), '{"value": 1}');
      try {
        await fs.symlink(outside, path.join(project, 'results'), 'junction');
      } catch {
        return; // Links need extra rights on some Windows machines.
      }
      const [result] = await runDeterministicChecks(project, { checks: [range('value', 0, 2)] });
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('项目目录之外');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('throws ProjectDirError when the Project directory is unusable', async () => {
    await expect(
      runDeterministicChecks(path.join(project, 'nope'), { checks: [] })
    ).rejects.toBeInstanceOf(ProjectDirError);
    await expect(runDeterministicChecks('relative/dir', { checks: [] })).rejects.toBeInstanceOf(
      ProjectDirError
    );
    await write('file.txt', '');
    await expect(
      runDeterministicChecks(path.join(project, 'file.txt'), { checks: [] })
    ).rejects.toBeInstanceOf(ProjectDirError);
  });
});

describe('readReviewMaterials', () => {
  it('reads each named file once, marks missing and long files', async () => {
    await write('notes/a.md', '# 说明\n');
    await write('notes/long.md', 'x'.repeat(MAX_EXCERPT_BYTES + 10));
    const materials = await readReviewMaterials(project, {
      id: 'demo',
      checks: [
        { id: 'size', kind: 'file-exists', description: '', path: 'notes/a.md' },
        { id: 'one', kind: 'subjective', description: '', files: ['notes/a.md', 'notes/b.md'] },
        { id: 'two', kind: 'subjective', description: '', files: ['notes/a.md', 'notes/long.md'] },
        { id: 'three', kind: 'subjective', description: 'three' },
      ],
    });

    expect(materials.exerciseId).toBe('demo');
    expect(materials.checks.map((check) => check.id)).toEqual(['one', 'two', 'three']);
    expect(materials.files.map(({ path: file, truncated }) => [file, truncated])).toEqual([
      ['notes/a.md', false],
      ['notes/b.md', false],
      ['notes/long.md', true],
    ]);
    expect(materials.files[0].content).toBe('# 说明\n');
    expect(materials.files[1].content).toBeNull();
    expect(materials.files[2].content).toHaveLength(MAX_EXCERPT_BYTES);
  });
});

describe('the catalogue check items', () => {
  const exercises = catalog.groups.flatMap((group) =>
    group.courses.flatMap((course) => course.exercises)
  );

  it('name only Project-relative files', () => {
    for (const exercise of exercises) {
      for (const check of exercise.checks) {
        const paths = check.kind === 'subjective' ? (check.files ?? []) : [check.path];
        for (const file of paths) {
          expect(isProjectRelativePath(file), `${exercise.id}/${check.id}: ${file}`).toBe(true);
        }
      }
    }
  });

  it('give every subjective item at least one file to judge', () => {
    for (const exercise of exercises) {
      for (const check of exercise.checks) {
        if (check.kind === 'subjective') {
          expect(check.files?.length ?? 0, `${exercise.id}/${check.id}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('are all passed by a correct solution of the first exercise', async () => {
    const exercise = exercises.find((entry) => entry.id === 'clean-temperature-log');
    if (!exercise) throw new Error('clean-temperature-log is missing from the catalogue');
    await write('data/clean.csv', 'date,temperature\n2026-07-01,31.2\n');
    await write('results/answer.json', '{"missing": 3, "outliers": 1}');

    const results = await runDeterministicChecks(project, exercise);

    expect(results).toHaveLength(3);
    expect(results.every((result) => result.passed)).toBe(true);
  });
});

describe('isProjectRelativePath', () => {
  it('accepts plain relative paths only', () => {
    expect(isProjectRelativePath('notes/a.md')).toBe(true);
    for (const value of ['', ' ', '/abs', 'C:/x', 'a\\b', 'a/../b', './a', 'a//b', 'a/']) {
      expect(isProjectRelativePath(value), value).toBe(false);
    }
  });
});
