import { describe, expect, it, vi } from 'vitest';
import type { LearningReviewMaterials } from '../../types/learningApi';
import type { Message } from '../../types/message';
import {
  ReviewTimeoutError,
  buildReviewPrompt,
  lastAssistantText,
  parseReviewVerdicts,
  reviewSubjectiveChecks,
  type ReviewRequest,
  type ReviewTransport,
} from './kernelReview';

vi.mock('../../acp/chatSessionStore', () => ({
  acpChatSessionActions: { deleteSnapshot: vi.fn() },
  acpChatSessionStore: { getSnapshot: vi.fn() },
}));
vi.mock('../../acp/prompt', () => ({ acpCancelPrompt: vi.fn(), acpPromptSession: vi.fn() }));
vi.mock('../../acp/sessions', () => ({ acpDeleteSession: vi.fn(), acpNewSession: vi.fn() }));

const materials: LearningReviewMaterials = {
  exerciseId: 'clean-temperature-log',
  checks: [
    { id: 'cleaning-notes', kind: 'subjective', description: '逐条说明了处理方式' },
    { id: 'rule-named', kind: 'subjective', description: '写明了识别规则' },
  ],
  files: [
    { path: 'notes/cleaning.md', content: '用 ```IQR``` 规则', truncated: true },
    { path: 'notes/missing.md', content: null, truncated: false },
  ],
};

const request: ReviewRequest = {
  exerciseTitle: '清洗一张日气温记录表',
  projectDir: '/project',
  submission: '我删掉了 85.0',
  materials,
};

const VERDICTS =
  '{"results":[{"checkId":"cleaning-notes","passed":true,"reason":"清楚"},' +
  '{"checkId":"rule-named","passed":false,"reason":"没写规则"}]}';

describe('buildReviewPrompt', () => {
  it('lists the items, the submission and the files', () => {
    const prompt = buildReviewPrompt(request);

    expect(prompt).toContain('清洗一张日气温记录表');
    expect(prompt).toContain('- cleaning-notes：逐条说明了处理方式');
    expect(prompt).toContain('- rule-named：写明了识别规则');
    expect(prompt).toContain('我删掉了 85.0');
    expect(prompt).toContain('### notes/cleaning.md');
    expect(prompt).toContain('（文件较长，只给出了开头部分）');
    expect(prompt).toContain('### notes/missing.md\n（文件不存在或无法读取）');
    // The fence is longer than any backtick run in the file.
    expect(prompt).toContain('````text\n用 ```IQR``` 规则\n````');
  });

  it('says so when nothing was submitted', () => {
    expect(buildReviewPrompt({ ...request, submission: '  ' })).toContain('（未填写）');
  });
});

describe('parseReviewVerdicts', () => {
  const ids = ['cleaning-notes', 'rule-named'];

  it('reads a bare JSON reply', () => {
    expect(parseReviewVerdicts(VERDICTS, ids)).toEqual([
      { checkId: 'cleaning-notes', passed: true, reason: '清楚' },
      { checkId: 'rule-named', passed: false, reason: '没写规则' },
    ]);
  });

  it('reads JSON inside a code block or surrounded by prose', () => {
    expect(parseReviewVerdicts('结论如下：\n```json\n' + VERDICTS + '\n```', ids)).toHaveLength(2);
    expect(parseReviewVerdicts('好的。' + VERDICTS + ' 以上。', ids)).toHaveLength(2);
  });

  it('keeps the first verdict per known item and drops the rest', () => {
    const reply = JSON.stringify([
      { checkId: 'rule-named', passed: true },
      { checkId: 'rule-named', passed: false, reason: 'second' },
      { checkId: 'other', passed: true, reason: 'x' },
      { checkId: 'cleaning-notes', passed: 'yes' },
      'junk',
    ]);
    expect(parseReviewVerdicts(reply, ids)).toEqual([
      { checkId: 'rule-named', passed: true, reason: '' },
    ]);
  });

  it('throws when the reply holds no verdict list', () => {
    expect(() => parseReviewVerdicts('我认为都通过了', ids)).toThrow();
    expect(() => parseReviewVerdicts('{"passed": true}', ids)).toThrow();
  });
});

describe('lastAssistantText', () => {
  const message = (role: 'user' | 'assistant', text: string): Message => ({
    role,
    created: 0,
    metadata: {} as Message['metadata'],
    content: [{ type: 'text', text }],
  });

  it('returns the last assistant message with text', () => {
    expect(
      lastAssistantText([
        message('user', 'q'),
        message('assistant', 'first'),
        message('assistant', 'second'),
        message('assistant', ' '),
        message('user', 'r'),
      ])
    ).toBe('second');
    expect(lastAssistantText([message('user', 'q')])).toBeUndefined();
  });
});

function fakeTransport(overrides: Partial<ReviewTransport> = {}): ReviewTransport {
  return {
    open: vi.fn(async () => 'review-session'),
    prompt: vi.fn(async () => undefined),
    reply: vi.fn(() => VERDICTS),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('reviewSubjectiveChecks', () => {
  it('asks the Kernel once and closes the session', async () => {
    const transport = fakeTransport();

    const verdicts = await reviewSubjectiveChecks(request, 5_000, transport);

    expect(verdicts.map((verdict) => verdict.passed)).toEqual([true, false]);
    expect(transport.open).toHaveBeenCalledWith('/project');
    expect(transport.prompt).toHaveBeenCalledWith('review-session', buildReviewPrompt(request));
    await settle();
    expect(transport.cancel).not.toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalledWith('review-session');
  });

  it('does not open a session when there is nothing to judge', async () => {
    const transport = fakeTransport();
    const empty = { ...request, materials: { ...materials, checks: [] } };
    expect(await reviewSubjectiveChecks(empty, 5_000, transport)).toEqual([]);
    expect(transport.open).not.toHaveBeenCalled();
  });

  it('times out, cancels the prompt and still closes the session', async () => {
    const transport = fakeTransport({ prompt: vi.fn(() => new Promise<void>(() => undefined)) });

    await expect(reviewSubjectiveChecks(request, 20, transport)).rejects.toBeInstanceOf(
      ReviewTimeoutError
    );
    await settle();
    expect(transport.cancel).toHaveBeenCalledWith('review-session');
    expect(transport.close).toHaveBeenCalledWith('review-session');
  });

  it('closes a session that opens only after the timeout', async () => {
    let open: (id: string) => void = () => undefined;
    const transport = fakeTransport({
      open: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            open = resolve;
          })
      ),
    });

    await expect(reviewSubjectiveChecks(request, 10, transport)).rejects.toBeInstanceOf(
      ReviewTimeoutError
    );
    open('late-session');
    await settle();
    expect(transport.prompt).not.toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalledWith('late-session');
  });

  it('reports an unreadable reply as an error', async () => {
    const transport = fakeTransport({ reply: vi.fn(() => '都不错') });
    await expect(reviewSubjectiveChecks(request, 5_000, transport)).rejects.toThrow();
    await settle();
    expect(transport.close).toHaveBeenCalled();
  });
});
