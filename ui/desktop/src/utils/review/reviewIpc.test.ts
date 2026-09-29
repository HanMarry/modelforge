import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reviewBridge } from '../../bridges/reviewBridge';
import type { IpcResult } from '../ipcResult';
import { registerReviewIpc } from './reviewIpc';
import { REVIEW_DIMENSIONS, type ReviewOutput, type ReviewRecord } from './reviewModel';
import { paperPathHash } from './reviewStore';

const renderer = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: renderer }));

const SECRET = 'sk-review-secret-0123456789';
const T1 = new Date('2026-09-29T10:15:30.123Z');
const T2 = new Date('2026-09-30T08:00:00.000Z');

type Listener = (event: unknown, arg: unknown) => Promise<IpcResult<unknown>>;

const tempDirs: string[] = [];

async function project(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mf-review-')));
  tempDirs.push(root);
  return root;
}

async function write(root: string, relative: string, content: string): Promise<void> {
  const file = path.join(root, ...relative.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

function output(base = 5): ReviewOutput {
  return {
    dimensions: REVIEW_DIMENSIONS.map((name, index) => ({
      name,
      score: (base + index) % 11,
      reasons: [`${name}：第 ${index + 1} 节的具体理由`],
    })),
    suggestions: [
      { text: '补充参数扰动结果', location: { section: '6 灵敏度分析', lines: [120, 140] } },
      { text: '摘要写出问题二的数值', location: { section: '摘要', page: 1 } },
    ],
  };
}

interface Harness {
  call: <T>(channel: string, arg: unknown) => Promise<IpcResult<T>>;
  channels: string[];
  setNow: (date: Date) => void;
}

function harness(writeFile?: (target: string, data: string) => Promise<void>): Harness {
  let now = T1;
  const handle = vi.fn();
  registerReviewIpc(
    { handle },
    { sensitiveValues: () => [SECRET], userDataDir: '/user-data', broadcast: vi.fn() },
    { now: () => now, writeFile }
  );
  const listeners = new Map<string, Listener>(
    handle.mock.calls.map(([channel, listener]): [string, Listener] => [
      channel as string,
      listener as Listener,
    ])
  );
  return {
    channels: handle.mock.calls.map(([channel]) => channel as string),
    call: <T>(channel: string, arg: unknown) => {
      const listener = listeners.get(channel);
      if (!listener) throw new Error(`${channel} is not registered`);
      return listener({}, arg) as Promise<IpcResult<T>>;
    },
    setNow: (date) => {
      now = date;
    },
  };
}

function errorCode(result: IpcResult<unknown>): string | null {
  return result.ok ? null : result.error.code;
}

function recordDir(root: string, paperPath: string): string {
  return path.join(root, '.modelforge', 'reviews', paperPathHash(paperPath));
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).sort();
  } catch {
    return [];
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('review IPC registration', () => {
  it('registers the review-* channels', () => {
    expect(harness().channels).toEqual(['review-list', 'review-save', 'review-paper-check']);
  });

  it('bridges each method to its channel', () => {
    const paper = { projectDir: '/project', paperPath: 'paper/main.tex' };
    const save = { ...paper, competitionId: 'cumcm', output: output() };
    reviewBridge.reviewList(paper);
    reviewBridge.reviewSave(save);
    reviewBridge.reviewPaperCheck(paper);

    expect(renderer.invoke.mock.calls).toEqual([
      ['review-list', paper],
      ['review-save', save],
      ['review-paper-check', paper],
    ]);
  });
});

describe('review-paper-check', () => {
  it('accepts a readable paper and returns its canonical path and format', async () => {
    const root = await project();
    await write(root, 'paper/main.tex', '\\section{引言}');
    const result = await harness().call('review-paper-check', {
      projectDir: root,
      paperPath: 'paper\\./main.tex',
    });

    expect(result).toEqual({
      ok: true,
      data: {
        paperPath: 'paper/main.tex',
        format: 'latex',
        size: Buffer.byteLength('\\section{引言}'),
      },
    });
  });

  it('names the reason a paper cannot be reviewed (requirement 19.5)', async () => {
    const root = await project();
    await write(root, 'empty.md', '');
    await write(root, 'notes.docx', 'x');
    await fs.mkdir(path.join(root, 'folder.pdf'));
    const { call } = harness();
    const check = (paperPath: unknown) =>
      call('review-paper-check', { projectDir: root, paperPath }).then(errorCode);

    expect(await check('missing.tex')).toBe('PAPER_NOT_FOUND');
    expect(await check('empty.md')).toBe('PAPER_EMPTY');
    expect(await check('folder.pdf')).toBe('PAPER_UNREADABLE');
    expect(await check('notes.docx')).toBe('UNSUPPORTED_FORMAT');
    expect(await check('../outside.tex')).toBe('OUTSIDE_PROJECT');
    expect(await check(path.join(root, 'main.tex'))).toBe('OUTSIDE_PROJECT');
    expect(await check(42)).toBe('INVALID_REQUEST');
    expect(errorCode(await call('review-paper-check', null))).toBe('INVALID_REQUEST');
  });

  it.skipIf(process.platform === 'win32')('refuses a symlink that leaves the project', async () => {
    const root = await project();
    const outside = await project();
    await write(outside, 'secret.tex', 'outside');
    await fs.symlink(path.join(outside, 'secret.tex'), path.join(root, 'linked.tex'));

    const result = await harness().call('review-paper-check', {
      projectDir: root,
      paperPath: 'linked.tex',
    });
    expect(errorCode(result)).toBe('OUTSIDE_PROJECT');
  });

  it('masks key values in error messages', async () => {
    const root = await project();
    const result = await harness().call('review-paper-check', {
      projectDir: path.join(root, SECRET),
      paperPath: 'main.tex',
    });

    expect(errorCode(result)).toBe('PROJECT_NOT_FOUND');
    expect(result.ok ? '' : result.error.message).not.toContain(SECRET);
    expect(result.ok ? '' : result.error.message).toContain('********');
  });
});

describe('review-save and review-list', () => {
  it('stores a valid review under the paper hash and lists it (requirement 19.6)', async () => {
    const root = await project();
    await write(root, 'paper/main.tex', 'paper');
    const { call } = harness();

    const saved = await call<ReviewRecord>('review-save', {
      projectDir: root,
      paperPath: 'paper/main.tex',
      competitionId: 'cumcm',
      output: output(),
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.data).toEqual({
      paper: 'paper/main.tex',
      competitionId: 'cumcm',
      completedAt: T1.toISOString(),
      ...output(),
    });

    const dir = recordDir(root, 'paper/main.tex');
    const name = '2026-09-29T10-15-30.123Z.json';
    expect(await listDir(dir)).toEqual([name]);
    expect(JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'))).toEqual(saved.data);

    const listed = await call<ReviewRecord[]>('review-list', {
      projectDir: root,
      paperPath: 'paper/main.tex',
    });
    expect(listed).toEqual({ ok: true, data: [saved.data] });
  });

  it('saves nothing and keeps earlier records when the output is incomplete', async () => {
    const root = await project();
    await write(root, 'main.md', '# 论文');
    const { call } = harness();
    const request = { projectDir: root, paperPath: 'main.md', competitionId: 'mcm' };

    expect(errorCode(await call('review-save', { ...request, output: {} }))).toBe(
      'REVIEW_INCOMPLETE'
    );
    await expect(fs.stat(path.join(root, '.modelforge'))).rejects.toThrow();

    expect((await call('review-save', { ...request, output: output() })).ok).toBe(true);
    const dir = recordDir(root, 'main.md');
    const [first] = await listDir(dir);
    const before = await fs.readFile(path.join(dir, first), 'utf8');

    const missingDimension = { ...output(), dimensions: output().dimensions.slice(1) };
    const badScore = {
      ...output(),
      dimensions: output().dimensions.map((dimension) => ({ ...dimension, score: 11 })),
    };
    for (const bad of [missingDimension, badScore, null, 'text']) {
      const result = await call('review-save', { ...request, output: bad });
      expect(errorCode(result)).toBe('REVIEW_INCOMPLETE');
    }
    const unknown = { ...request, competitionId: 'nope', output: output() };
    expect(errorCode(await call('review-save', unknown))).toBe('UNKNOWN_COMPETITION');

    expect(await listDir(dir)).toEqual([first]);
    expect(await fs.readFile(path.join(dir, first), 'utf8')).toBe(before);
  });

  it('keeps earlier records when the write fails', async () => {
    const root = await project();
    await write(root, 'main.pdf', '%PDF-1.7');
    const request = {
      projectDir: root,
      paperPath: 'main.pdf',
      competitionId: 'apmcm',
      output: output(),
    };
    expect((await harness().call('review-save', request)).ok).toBe(true);
    const dir = recordDir(root, 'main.pdf');
    const before = await listDir(dir);

    const failing = harness(() => Promise.reject(new Error(`disk full ${SECRET}`)));
    failing.setNow(T2);
    const result = await failing.call('review-save', request);
    expect(errorCode(result)).toBe('WRITE_FAILED');
    expect(result.ok ? '' : result.error.message).not.toContain(SECRET);
    expect(await listDir(dir)).toEqual(before);
  });

  it('never replaces a record completed in the same millisecond', async () => {
    const root = await project();
    await write(root, 'main.tex', 'x');
    const { call } = harness();
    const request = { projectDir: root, paperPath: 'main.tex', competitionId: 'cumcm' };
    const dir = recordDir(root, 'main.tex');

    const firstFile = path.join(dir, '2026-09-29T10-15-30.123Z.json');
    expect((await call('review-save', { ...request, output: output(1) })).ok).toBe(true);
    const first = await fs.readFile(firstFile, 'utf8');
    expect((await call('review-save', { ...request, output: output(2) })).ok).toBe(true);
    expect(await fs.readFile(firstFile, 'utf8')).toBe(first);

    // Saves that race each other are queued, so each still gets its own file.
    const raced = await Promise.all([
      call('review-save', { ...request, output: output(3) }),
      call('review-save', { ...request, output: output(4) }),
    ]);
    expect(raced.every((result) => result.ok)).toBe(true);
    expect(await listDir(dir)).toEqual([
      '2026-09-29T10-15-30.123Z-1.json',
      '2026-09-29T10-15-30.123Z-2.json',
      '2026-09-29T10-15-30.123Z-3.json',
      '2026-09-29T10-15-30.123Z.json',
    ]);

    const listed = await call<ReviewRecord[]>('review-list', {
      projectDir: root,
      paperPath: 'main.tex',
    });
    const scores = listed.ok ? listed.data.map((record) => record.dimensions[0].score) : [];
    expect(scores.slice(0, 2)).toEqual([1, 2]);
    expect([...scores.slice(2)].sort()).toEqual([3, 4]);
  });

  it('lists oldest first and skips damaged, temporary and foreign files', async () => {
    const root = await project();
    await write(root, 'paper/a.tex', 'a');
    const harnessed = harness();
    const request = { projectDir: root, paperPath: 'paper/a.tex', competitionId: 'cumcm' };
    harnessed.setNow(T2);
    await harnessed.call('review-save', { ...request, output: output(3) });
    harnessed.setNow(T1);
    await harnessed.call('review-save', { ...request, output: output(4) });

    const dir = recordDir(root, 'paper/a.tex');
    await fs.writeFile(path.join(dir, 'broken.json'), '{ not json');
    await fs.writeFile(path.join(dir, '.x.json.123.tmp'), '{}');
    const foreign = {
      paper: 'paper/b.tex',
      competitionId: 'cumcm',
      completedAt: T1.toISOString(),
      ...output(),
    };
    await fs.writeFile(path.join(dir, 'foreign.json'), JSON.stringify(foreign));

    const listed = await harnessed.call<ReviewRecord[]>('review-list', {
      projectDir: root,
      paperPath: 'paper/a.tex',
    });
    expect(listed.ok && listed.data.map((record) => record.completedAt)).toEqual([
      T1.toISOString(),
      T2.toISOString(),
    ]);
  });

  it('returns no records for a paper that was never reviewed, even once it is gone', async () => {
    const root = await project();
    const { call } = harness();
    expect(await call('review-list', { projectDir: root, paperPath: 'gone.tex' })).toEqual({
      ok: true,
      data: [],
    });
    const outside = await call('review-list', { projectDir: root, paperPath: '../x.tex' });
    expect(errorCode(outside)).toBe('OUTSIDE_PROJECT');
  });
});
