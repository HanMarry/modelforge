import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reviewBridge } from '../../bridges/reviewBridge';
import { registerReviewIpc } from './reviewIpc';

const renderer = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: renderer }));

const deps = { sensitiveValues: () => [], userDataDir: '/user-data', broadcast: vi.fn() };

describe('review IPC skeleton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the review-* channels', async () => {
    const handle = vi.fn();
    registerReviewIpc({ handle }, deps);

    expect(handle.mock.calls.map(([channel]) => channel)).toEqual(['review-list', 'review-save']);
    for (const [, listener] of handle.mock.calls) {
      expect(await listener({}, {})).toMatchObject({
        ok: false,
        error: { code: 'NOT_IMPLEMENTED' },
      });
    }
  });

  it('bridges each method to its channel', () => {
    const paper = { projectDir: '/project', paperPath: 'paper/main.tex' };
    const save = { ...paper, competitionId: 'cumcm', output: { dimensions: [], suggestions: [] } };
    reviewBridge.reviewList(paper);
    reviewBridge.reviewSave(save);

    expect(renderer.invoke.mock.calls).toEqual([
      ['review-list', paper],
      ['review-save', save],
    ]);
  });
});
