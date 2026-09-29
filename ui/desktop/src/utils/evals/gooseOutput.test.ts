import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../../test/pbt';
import {
  classifyRun,
  describeOutcome,
  fallbackUsage,
  normalizePathForCompare,
  parseGooseJsonOutput,
  resolveTokens,
  samePath,
  sessionUsageForDir,
  usageFromCounts,
  type RunOutcome,
} from './gooseOutput';

/** Shaped like `goose run --output-format json` (JsonOutput in crates/goose-cli/src/session). */
function gooseJson(
  metadata: Record<string, unknown>,
  replies: string[] = ['好的，我们先看约束。']
): string {
  const messages = [
    { id: null, role: 'user', created: 1, content: [{ type: 'text', text: '题目' }], metadata: {} },
    ...replies.map((text, index) => ({
      id: `m${index}`,
      role: 'assistant',
      created: 2 + index,
      content: [
        { type: 'toolRequest', id: 't', toolCall: { status: 'success' } },
        { type: 'text', text },
      ],
      metadata: { userVisible: true, agentVisible: true },
    })),
  ];
  return JSON.stringify({ messages, metadata }, null, 2);
}

const completed = {
  total_tokens: 1500,
  input_tokens: 1200,
  output_tokens: 300,
  status: 'completed',
};

const cleanExit: RunOutcome = {
  spawnError: null,
  stoppedBy: null,
  exitCode: 0,
  signal: null,
  reported: 'completed',
};

describe('gooseOutput examples', () => {
  it('reads status, usage and assistant text from the JSON output', () => {
    const output = parseGooseJsonOutput(gooseJson(completed, ['第一段', '第二段']));
    expect(output).toEqual({
      status: 'completed',
      usage: { tokensIn: 1200, tokensOut: 300 },
      assistantText: ['第一段', '第二段'],
    });
  });

  it('finds the object among other lines goose printed', () => {
    const text = [
      'Loading recipe: 评测',
      '{ not json',
      gooseJson({ ...completed, status: 'error' }),
      'Error: provider returned 401',
      '',
    ].join('\n');
    expect(parseGooseJsonOutput(text)?.status).toBe('error');
    expect(parseGooseJsonOutput(text)?.usage).toEqual({ tokensIn: 1200, tokensOut: 300 });

    const compact = `starting\n${JSON.stringify({ messages: [], metadata: completed })}\n`;
    expect(parseGooseJsonOutput(compact)?.usage).toEqual({ tokensIn: 1200, tokensOut: 300 });
  });

  it('returns null when there is no JSON output', () => {
    expect(parseGooseJsonOutput('')).toBeNull();
    expect(parseGooseJsonOutput('   \n')).toBeNull();
    expect(parseGooseJsonOutput('Error: something failed')).toBeNull();
    expect(parseGooseJsonOutput('[1, 2]')).toBeNull();
    expect(parseGooseJsonOutput('{"other": 1}')).toBeNull();
  });

  it('keeps usage unknown when goose could not read it', () => {
    const output = parseGooseJsonOutput(
      gooseJson({ total_tokens: null, status: 'completed' }, [])
    );
    expect(output).toEqual({ status: 'completed', usage: null, assistantText: [] });
  });

  it('derives a missing side of the usage from the total', () => {
    expect(usageFromCounts({ input_tokens: 10, output_tokens: 5 })).toEqual({
      tokensIn: 10,
      tokensOut: 5,
    });
    expect(usageFromCounts({ input_tokens: 10, total_tokens: 15 })).toEqual({
      tokensIn: 10,
      tokensOut: 5,
    });
    expect(usageFromCounts({ output_tokens: 5, total_tokens: 15 })).toEqual({
      tokensIn: 10,
      tokensOut: 5,
    });
    expect(usageFromCounts({ total_tokens: 15 })).toEqual({ tokensIn: 15, tokensOut: 0 });
    expect(usageFromCounts({ input_tokens: 10 })).toEqual({ tokensIn: 10, tokensOut: 0 });
    expect(usageFromCounts({ total_tokens: null })).toBeNull();
    expect(usageFromCounts({ input_tokens: -1, total_tokens: 'x' })).toBeNull();
    expect(usageFromCounts(null)).toBeNull();
  });

  it('sums the session record of exactly the working directory', () => {
    const list = JSON.stringify([
      {
        id: '1',
        working_dir: 'C:\\Temp\\evals\\m\\practice-air-quality',
        accumulated_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      },
      {
        id: '2',
        working_dir: 'C:\\Temp\\evals\\m\\practice-air-quality-2',
        accumulated_usage: { input_tokens: 999, output_tokens: 999, total_tokens: 1998 },
      },
      {
        id: '3',
        working_dir: 'c:/temp/evals/m/practice-air-quality/',
        accumulated_usage: { input_tokens: null, output_tokens: null, total_tokens: null },
      },
    ]);
    expect(sessionUsageForDir(list, 'C:/Temp/evals/m/practice-air-quality', true)).toEqual({
      tokensIn: 100,
      tokensOut: 20,
      sessions: 2,
    });
    expect(sessionUsageForDir(list, 'C:\\Temp\\evals\\m\\practice-air-quality', false)).toEqual({
      tokensIn: 100,
      tokensOut: 20,
      sessions: 1,
    });
    const none = { tokensIn: 0, tokensOut: 0, sessions: 0 };
    expect(sessionUsageForDir(list, 'C:/Temp/evals/m/other', true)).toEqual(none);
    expect(sessionUsageForDir('[]', 'C:/Temp', true)).toEqual(none);
    expect(sessionUsageForDir(`update available\n${list}\n`, 'C:/Temp', true)).toEqual(none);
    expect(sessionUsageForDir('No sessions found', 'C:/Temp', true)).toBeNull();
    expect(sessionUsageForDir('', 'C:/Temp', true)).toBeNull();
  });

  it('falls back to the session record, and to 0 only for runs that ended by themselves', () => {
    const recorded = { tokensIn: 5, tokensOut: 1, sessions: 1 };
    const none = { tokensIn: 0, tokensOut: 0, sessions: 0 };
    expect(fallbackUsage(recorded, true)).toEqual({ tokensIn: 5, tokensOut: 1 });
    expect(fallbackUsage(recorded, false)).toEqual({ tokensIn: 5, tokensOut: 1 });
    expect(fallbackUsage(none, false)).toEqual({ tokensIn: 0, tokensOut: 0 });
    expect(fallbackUsage(none, true)).toBeNull();
    expect(fallbackUsage(null, false)).toBeNull();
  });

  it('normalizes separators, prefixes and case for path comparison', () => {
    expect(normalizePathForCompare('\\\\?\\C:\\A\\\\b\\', true)).toBe('c:/a/b');
    expect(normalizePathForCompare('C:\\', false)).toBe('C:/');
    expect(normalizePathForCompare('/tmp/x/', false)).toBe('/tmp/x');
    expect(normalizePathForCompare('/', false)).toBe('/');
    expect(samePath('/tmp/A', '/tmp/a', false)).toBe(false);
    expect(samePath('/tmp/A', '/tmp/a', true)).toBe(true);
  });

  it('prefers the JSON output, then the session record', () => {
    const output = { tokensIn: 1, tokensOut: 2 };
    const session = { tokensIn: 3, tokensOut: 4 };
    expect(resolveTokens(output, session)).toEqual({ ...output, tokenSource: 'output' });
    expect(resolveTokens(null, session)).toEqual({ ...session, tokenSource: 'session' });
    const unknown = resolveTokens(null, null);
    expect(unknown.tokenSource).toBe('unknown');
    expect(Number.isNaN(unknown.tokensIn + unknown.tokensOut)).toBe(true);
  });

  it('classifies how a run ended (requirement 23.7, 23.8)', () => {
    expect(classifyRun(cleanExit)).toEqual({ status: '完成' });
    expect(classifyRun({ ...cleanExit, reported: null })).toEqual({ status: '完成' });
    expect(classifyRun({ ...cleanExit, exitCode: 1, reported: 'error' })).toEqual({
      status: '失败',
      failure: '模型调用失败',
    });
    expect(classifyRun({ ...cleanExit, reported: 'error' })).toEqual({
      status: '失败',
      failure: '模型调用失败',
    });
    expect(classifyRun({ ...cleanExit, exitCode: null, signal: 'SIGKILL' }).failure).toBe(
      '模型调用失败'
    );
    expect(classifyRun({ ...cleanExit, spawnError: 'ENOENT', exitCode: null })).toEqual({
      status: '失败',
      failure: '模型调用失败',
    });
    expect(classifyRun({ ...cleanExit, stoppedBy: 'timeout', exitCode: 1 })).toEqual({
      status: '失败',
      failure: '超时',
    });
    expect(classifyRun({ ...cleanExit, stoppedBy: 'budget', exitCode: 1 })).toEqual({
      status: '已中止',
    });
    expect(classifyRun({ ...cleanExit, stoppedBy: 'interrupted', exitCode: null })).toEqual({
      status: '已中止',
    });
  });

  it('describes unclean ends without goose error text', () => {
    expect(describeOutcome(cleanExit, 60)).toBeUndefined();
    expect(describeOutcome({ ...cleanExit, stoppedBy: 'timeout' }, 60)).toBe(
      '超过 60 分钟未结束，已停止'
    );
    expect(describeOutcome({ ...cleanExit, exitCode: 2 }, 60)).toBe('goose 退出码 2');
    expect(describeOutcome({ ...cleanExit, spawnError: 'ENOENT' }, 60)).toBe(
      '无法启动 goose（ENOENT）'
    );
    expect(describeOutcome({ ...cleanExit, exitCode: null, signal: 'SIGTERM' }, 60)).toBe(
      'goose 被信号 SIGTERM 终止'
    );
  });
});

describe('gooseOutput properties', () => {
  /** Lines goose might print around its JSON: never an opening or lone closing brace. */
  const noiseLine = fc
    .string({ unit: fc.constantFrom('a', ' ', ':', '中', '1', '"', '[', '}'), maxLength: 12 })
    .filter((line) => !line.startsWith('{') && line.trimEnd() !== '}');
  const countArb = fc.integer({ min: 0, max: 2_000_000_000 });

  it('recovers the usage whatever goose printed around the JSON object', () => {
    fc.assert(
      fc.property(
        fc.array(noiseLine, { maxLength: 4 }),
        fc.array(noiseLine, { maxLength: 4 }),
        countArb,
        countArb,
        fc.constantFrom('completed', 'error'),
        fc.array(fc.string({ maxLength: 20 }), { maxLength: 3 }),
        (before, after, input, output, status, replies) => {
          const json = gooseJson(
            { total_tokens: input + output, input_tokens: input, output_tokens: output, status },
            replies
          );
          const parsed = parseGooseJsonOutput([...before, json, ...after].join('\n'));
          expect(parsed).toEqual({
            status,
            usage: { tokensIn: input, tokensOut: output },
            assistantText: replies,
          });
        }
      ),
      pbtParams
    );
  });

  it('counts a session exactly when its directory is the working directory', () => {
    const segment = fc.string({
      unit: fc.constantFrom('a', 'B', '-', '_', '1', '题'),
      minLength: 1,
      maxLength: 6,
    });
    fc.assert(
      fc.property(
        fc.array(segment, { minLength: 1, maxLength: 4 }),
        segment,
        countArb,
        countArb,
        (segments, suffix, input, output) => {
          const dir = `C:\\evals\\${segments.join('\\')}`;
          const list = JSON.stringify([
            {
              working_dir: dir,
              accumulated_usage: { input_tokens: input, output_tokens: output },
            },
            {
              working_dir: `${dir}${suffix}`,
              accumulated_usage: { input_tokens: 1, output_tokens: 1 },
            },
          ]);
          expect(sessionUsageForDir(list, dir.replace(/\\/g, '/'), true)).toEqual({
            tokensIn: input,
            tokensOut: output,
            sessions: 1,
          });
        }
      ),
      pbtParams
    );
  });
});
