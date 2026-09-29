import { afterEach, describe, expect, it, vi } from 'vitest';
import { REVIEW_DIMENSIONS, type ReviewOutput } from './reviewModel';
import { startReview, type ReviewKernel, type ReviewRunRequest } from './reviewRunner';

const request: ReviewRunRequest = {
  workingDir: '/project',
  paperPath: 'paper/main.tex',
  format: 'latex',
  competitionId: 'cumcm',
  competitionName: '全国大学生数学建模竞赛',
  sessionTitle: 'Mock review: paper/main.tex',
};

const review: ReviewOutput = {
  dimensions: REVIEW_DIMENSIONS.map((name, index) => ({
    name,
    score: index + 3,
    reasons: [`${name} 的理由`],
  })),
  suggestions: [{ text: '补充检验', location: { section: '5 求解', lines: [10, 12] } }],
};

/** A Kernel that completes a valid review; tests change single methods. */
function kernel() {
  return {
    unavailableReason: vi.fn<ReviewKernel['unavailableReason']>(async () => null),
    openSession: vi.fn<ReviewKernel['openSession']>(async () => 'session-1'),
    prompt: vi.fn<ReviewKernel['prompt']>(async () => 'end_turn'),
    cancel: vi.fn<ReviewKernel['cancel']>(async () => undefined),
    isWaitingForUser: vi.fn<ReviewKernel['isWaitingForUser']>(() => false),
    replyTexts: vi.fn<ReviewKernel['replyTexts']>(() => [
      `评审结果：\n\`\`\`json\n${JSON.stringify(review)}\n\`\`\``,
    ]),
    closeSession: vi.fn<ReviewKernel['closeSession']>(async () => undefined),
  };
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('startReview', () => {
  it('sends the review task in its own session and returns the validated output', async () => {
    const fake = kernel();
    const outcome = await startReview(request, fake).result;

    expect(outcome).toEqual({ ok: true, output: review });
    expect(fake.openSession).toHaveBeenCalledWith('/project', 'Mock review: paper/main.tex');
    const [sessionId, prompt] = fake.prompt.mock.calls[0];
    expect(sessionId).toBe('session-1');
    expect(prompt).toContain('mathmodel-mock-review');
    expect(prompt).toContain('"paper/main.tex"');
    expect(prompt).toContain('"cumcm"');
    expect(fake.closeSession).toHaveBeenCalledWith('session-1');
    expect(fake.cancel).not.toHaveBeenCalled();
  });

  it('does not start when the Kernel is unavailable', async () => {
    const fake = kernel();
    fake.unavailableReason.mockResolvedValue('Missing API key');
    expect(await startReview(request, fake).result).toEqual({
      ok: false,
      failure: { kind: 'kernel-unavailable', detail: 'Missing API key' },
    });
    expect(fake.openSession).not.toHaveBeenCalled();
  });

  it('reports a session that cannot be opened', async () => {
    const fake = kernel();
    fake.openSession.mockRejectedValue(new Error('ACP URL is not available'));
    expect(await startReview(request, fake).result).toEqual({
      ok: false,
      failure: { kind: 'session-failed', detail: 'ACP URL is not available' },
    });
    expect(fake.prompt).not.toHaveBeenCalled();
  });

  it('reports a failed model call and still closes the session', async () => {
    const fake = kernel();
    fake.prompt.mockRejectedValue(new Error('429 Too Many Requests'));
    expect(await startReview(request, fake).result).toEqual({
      ok: false,
      failure: { kind: 'model-call-failed', detail: '429 Too Many Requests' },
    });
    expect(fake.closeSession).toHaveBeenCalledWith('session-1');
  });

  it.each([
    ['cancelled', 'cancelled'],
    ['refusal', 'refused'],
    ['max_tokens', 'output-truncated'],
    ['max_turn_requests', 'output-truncated'],
  ])('maps stop reason %s to %s', async (stopReason, kind) => {
    const fake = kernel();
    fake.prompt.mockResolvedValue(stopReason);
    const outcome = await startReview(request, fake).result;
    expect(outcome.ok ? null : outcome.failure.kind).toBe(kind);
  });

  it('reports a reply without JSON, quoting its end', async () => {
    const fake = kernel();
    fake.replyTexts.mockReturnValue(['文件不存在：paper/main.tex，未进行评审。']);
    expect(await startReview(request, fake).result).toEqual({
      ok: false,
      failure: { kind: 'no-json', detail: '文件不存在：paper/main.tex，未进行评审。' },
    });
  });

  it('reports a reply that fails validation, with its problems', async () => {
    const fake = kernel();
    const partial = { ...review, dimensions: review.dimensions.slice(0, 5) };
    fake.replyTexts.mockReturnValue([JSON.stringify(partial)]);
    const outcome = await startReview(request, fake).result;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('invalid-output');
    expect(outcome.failure.problems).toEqual([{ kind: 'missing-dimension', name: '写作表达' }]);
  });

  it('times out, cancels the turn and closes the session', async () => {
    vi.useFakeTimers();
    const fake = kernel();
    fake.prompt.mockImplementation(() => never<string>());
    const run = startReview(request, fake, { timeoutMs: 60_000 });
    let settled = false;
    void run.result.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(59_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await run.result).toEqual({ ok: false, failure: { kind: 'timeout' } });
    expect(fake.cancel).toHaveBeenCalledWith('session-1');
    expect(fake.closeSession).toHaveBeenCalledWith('session-1');
  });

  it('stops when the user cancels during the turn', async () => {
    const fake = kernel();
    fake.prompt.mockImplementation(() => never<string>());
    const run = startReview(request, fake);
    await vi.waitFor(() => expect(fake.prompt).toHaveBeenCalled());
    run.cancel();

    expect(await run.result).toEqual({ ok: false, failure: { kind: 'cancelled' } });
    expect(fake.cancel).toHaveBeenCalledWith('session-1');
    expect(fake.closeSession).toHaveBeenCalledWith('session-1');
  });

  it('closes a session that opens only after the user cancelled', async () => {
    const fake = kernel();
    const opened: Array<(sessionId: string) => void> = [];
    fake.openSession.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          opened.push(resolve);
        })
    );
    const run = startReview(request, fake);
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    run.cancel();
    expect(await run.result).toEqual({ ok: false, failure: { kind: 'cancelled' } });

    opened[0]('late-session');
    await vi.waitFor(() => expect(fake.closeSession).toHaveBeenCalledWith('late-session'));
    expect(fake.prompt).not.toHaveBeenCalled();
  });

  it('gives up when the Kernel waits for an approval the panel cannot grant', async () => {
    vi.useFakeTimers();
    const fake = kernel();
    fake.prompt.mockImplementation(() => never<string>());
    fake.isWaitingForUser.mockReturnValue(true);
    const run = startReview(request, fake, { pollMs: 500 });
    await vi.advanceTimersByTimeAsync(500);

    expect(await run.result).toEqual({ ok: false, failure: { kind: 'approval-required' } });
    expect(fake.cancel).toHaveBeenCalledWith('session-1');
  });
});
