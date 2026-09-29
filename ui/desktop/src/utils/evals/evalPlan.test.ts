import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../../test/pbt';
import { createManifest, parseManifest, verifyManifest } from '../buildManifest';
import {
  CANCELLED_MESSAGE,
  confirmationLines,
  extraModelSettings,
  formatTokens,
  isAsciiPath,
  isConfirmed,
  modelLabel,
  parseBudget,
  resultFileStamp,
  safeDirName,
  traceability,
  type ConfirmationPlan,
} from './evalPlan';

const COMMIT = 'a'.repeat(40);
const SHA = 'b'.repeat(64);

const manifest = createManifest({
  commit: COMMIT,
  dirty: false,
  buildType: 'dev',
  toolchain: { rust: 'rustc 1.92.0', node: '24.10.0' },
  features: [],
  target: 'x86_64-pc-windows-gnu',
  version: '1.0.0',
  builtAt: '2026-10-01T00:00:00Z',
  artifacts: [{ file: 'goose.exe', sha256: SHA }],
  content: { skills: 48, examples: [] },
});

const plan: ConfirmationPlan = {
  models: ['deepseek/deepseek-chat'],
  tasks: [
    {
      id: 'practice-air-quality',
      title: '城市空气质量预测',
      category: '预测/统计类',
      timeoutMinutes: 60,
    },
    {
      id: 'practice-bike-rebalancing',
      title: '共享单车调度',
      category: '优化类',
      timeoutMinutes: 60,
    },
  ],
  samples: [{ id: 'lp-full-code-request', scenario: '索要完整代码' }],
  budget: 2_000_000,
  kernel: 'D:/build/target/release/goose.exe',
  provenance: { commit: COMMIT, dirty: false, traceable: true },
  workRoot: 'D:/evals-work/20261001T000000Z',
  resultsDir: 'D:/repo/evals/modeling/results',
  extraModels: [],
  dryRun: false,
};

describe('evalPlan examples', () => {
  it('parses budgets with separators and k / m suffixes', () => {
    expect(parseBudget('2000000')).toBe(2_000_000);
    expect(parseBudget('2,000,000')).toBe(2_000_000);
    expect(parseBudget('2_000_000')).toBe(2_000_000);
    expect(parseBudget(' 500k ')).toBe(500_000);
    expect(parseBudget('2M')).toBe(2_000_000);
    for (const bad of [undefined, '', '0', '-5', '1.5m', 'abc', '2g', '9'.repeat(20)]) {
      expect(parseBudget(bad), String(bad)).toBeNull();
    }
  });

  it('starts only on an explicit yes', () => {
    for (const yes of ['y', 'Y', ' yes ', 'YES', '确认', 'ｙ']) {
      expect(isConfirmed(yes), yes).toBe(true);
    }
    for (const no of [null, '', 'n', 'no', 'yy', '是', 'y es']) {
      expect(isConfirmed(no), String(no)).toBe(false);
    }
  });

  it('names result files by the UTC start time', () => {
    expect(resultFileStamp(new Date('2026-10-01T08:03:09.500Z'))).toBe('20261001T080309Z');
    expect(resultFileStamp(new Date(Date.UTC(999, 0, 2, 3, 4, 5)))).toBe('09990102T030405Z');
  });

  it('turns labels into portable directory names', () => {
    expect(safeDirName('openai/gpt-4o')).toBe('openai_gpt-4o');
    expect(safeDirName('ollama/qwen2.5:7b')).toBe('ollama_qwen2.5_7b');
    expect(safeDirName('..')).toBe('_');
    expect(safeDirName('')).toBe('_');
    expect(safeDirName('con')).toBe('_con');
    expect(safeDirName('本地模型')).toBe('_');
    expect(modelLabel({ provider: 'openai', model: 'gpt-4o' })).toBe('openai/gpt-4o');
  });

  it('lists settings that would call other models', () => {
    expect(
      extraModelSettings({ GOOSE_SUBAGENT_MODEL: 'm', GOOSE_LEAD_MODEL: ' ', PATH: 'x' })
    ).toEqual(['GOOSE_SUBAGENT_MODEL=m']);
  });

  it('is traceable only with a manifest that matches the kernel binary', () => {
    const parsed = parseManifest(JSON.stringify(manifest));
    expect(traceability(parsed, verifyManifest(manifest, { 'goose.exe': SHA }))).toEqual({
      commit: COMMIT,
      dirty: false,
      traceable: true,
    });
    const other = traceability(parsed, verifyManifest(manifest, { 'goose.exe': 'c'.repeat(64) }));
    expect(other).toMatchObject({ commit: null, dirty: null, traceable: false });
    expect(other.reason).toContain('goose.exe');
    expect(traceability(parsed, null)).toMatchObject({ traceable: false });
    expect(traceability(null, null)).toMatchObject({ traceable: false, commit: null });
    expect(traceability(parseManifest('{'), null).reason).toContain('无法解析');
  });

  it('shows models, task count, budget and traceability before the run', () => {
    const text = confirmationLines(plan).join('\n');
    expect(text).toContain('deepseek/deepseek-chat');
    expect(text).toContain('待执行题目：2 道 × 1 个模型 = 2 次运行');
    expect(text).toContain('学习模式抽样：1 个样例');
    expect(text).toContain('2,000,000');
    expect(text).toContain(`commit ${COMMIT}`);
    expect(text).not.toContain('演练模式');

    const untraceable = confirmationLines({
      ...plan,
      provenance: { commit: null, dirty: null, traceable: false, reason: '找不到' },
      samples: [],
      resultsDir: null,
      workRoot: 'C:/Users/韩/evals',
      extraModels: ['GOOSE_SUBAGENT_MODEL=m'],
      dryRun: true,
    }).join('\n');
    expect(untraceable).toContain('不可追溯');
    expect(untraceable).toContain('学习模式抽样：本次不运行');
    expect(untraceable).toContain('演练模式');
    expect(untraceable).toContain('非 ASCII');
    expect(untraceable).toContain('GOOSE_SUBAGENT_MODEL=m');
    expect(CANCELLED_MESSAGE).toContain('没有调用任何模型');
  });

  it('formats token counts and flags non-ASCII paths', () => {
    expect(formatTokens(1234567)).toBe('1,234,567');
    expect(formatTokens(Number.NaN)).toBe('未知');
    expect(isAsciiPath('C:/evals')).toBe(true);
    expect(isAsciiPath('C:/Users/韩正阳')).toBe(false);
  });
});

describe('evalPlan properties', () => {
  it('parses every positive safe integer budget, with or without separators', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), (value) => {
        expect(parseBudget(String(value))).toBe(value);
        expect(parseBudget(value.toLocaleString('en-US'))).toBe(value);
      }),
      pbtParams
    );
  });

  it('builds directory names that are safe on every platform', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (label) => {
        const name = safeDirName(label);
        expect(name).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/);
        expect(name.endsWith('.')).toBe(false);
        expect(name).not.toMatch(/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i);
      }),
      pbtParams
    );
  });
});
