import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRuntimeSystemPromptAppend,
  provisionAgentRuntime,
  SHIM_DUMP_ENV_VAR,
  SYSTEM_PROMPT_ENV_VAR,
} from './agentRuntime';
import { startAnthropicShim } from './anthropicShim';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelforge-identity-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('runtime persistence and diagnostics', () => {
  it.each(['claude-code', 'codex'] as const)(
    'preserves %s session history on shutdown',
    async (runtime) => {
      vi.stubEnv('MODELFORGE_DEBUG_SHIM', '0');
      const provisioned = await provisionAgentRuntime(
        {
          runtime,
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: 'test-only',
          model: 'test-model',
        },
        tempDir()
      );
      const transcript = path.join(provisioned.configDir!, 'session.jsonl');
      fs.writeFileSync(transcript, '{"message":"keep this session"}\n');
      await provisioned.dispose();
      expect(fs.readFileSync(transcript, 'utf8')).toContain('keep this session');
    }
  );

  it('disables payload recording unless diagnostic capture is explicitly enabled', async () => {
    vi.stubEnv('MODELFORGE_DEBUG_SHIM', '0');
    const provisioned = await provisionAgentRuntime(
      {
        runtime: 'claude-code',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'test-only',
        model: 'test-model',
      },
      tempDir()
    );
    try {
      const health = await fetch(`${provisioned.shimUrl}/health`).then((r) => r.json());
      expect(health.dumpDir).toBeNull();
      expect(provisioned.env[SHIM_DUMP_ENV_VAR]).toBe('');
    } finally {
      await provisioned.dispose();
    }
  });
});

/**
 * These assert the *content* of the identity override rather than a transcript, because the
 * regression they guard is a behaviour of the wrapped CLI (its harness prompt introduces the agent
 * as "Claude Code, Anthropic's official CLI for Claude"). A real transcript test needs a live
 * model; this pins the part we control so a future edit cannot silently drop it.
 */
describe('buildRuntimeSystemPromptAppend', () => {
  const prompt = buildRuntimeSystemPromptAppend({ model: 'deepseek-v4-pro', contextLimit: 128000 });

  it('names the vertical agent as the identity', () => {
    expect(prompt).toContain('ModelForge');
    expect(prompt).toContain('数学建模');
  });

  it('names the model the user actually selected', () => {
    expect(prompt).toContain('deepseek-v4-pro');
  });

  it('handles the identity question explicitly', () => {
    // The question that exposed the bug, and the answer shape we require.
    expect(prompt).toContain('你是 Claude 吗');
    expect(prompt).toMatch(/不是 Claude/);
  });

  it('refutes the harness self-description instead of ignoring it', () => {
    // The override is appended *after* a prompt that already claims Claude Code, so it has to
    // name that claim to outrank it.
    expect(prompt).toContain("You are Claude Code, Anthropic's official CLI for Claude");
    expect(prompt).toMatch(/不描述你/);
  });

  it('forbids inventing model specs', () => {
    expect(prompt).toMatch(/不要编造模型名/);
  });

  it('states the resolved context window when one is known', () => {
    expect(prompt).toContain('128,000');
  });

  it('omits the context window when it could not be resolved', () => {
    const unknown = buildRuntimeSystemPromptAppend({ model: 'deepseek-v4-pro' });
    expect(unknown).not.toMatch(/上下文窗口约/);
  });

  it('exposes the env var the kernel reads', () => {
    expect(SYSTEM_PROMPT_ENV_VAR).toBe('MODELFORGE_SYSTEM_PROMPT');
  });
});

describe('anthropic shim payload dump', () => {
  it('writes the exact upstream payload so identity claims can be audited', async () => {
    const dumpDir = path.join(tempDir(), 'shim-dumps');
    const requested: string[] = [];

    // Upstream stands in for the provider; the shim only needs it to answer.
    const upstream = await startAnthropicShim({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'unused',
      model: 'deepseek-v4-pro',
      dumpDir,
    });
    try {
      await fetch(`${upstream.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-5',
          system: 'SENTINEL_SYSTEM_PROMPT',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        }),
      }).catch(() => undefined);
      requested.push('sent');
    } finally {
      await upstream.close();
    }

    const files = fs.existsSync(dumpDir) ? fs.readdirSync(dumpDir) : [];
    expect(requested).toHaveLength(1);
    expect(files.length).toBeGreaterThan(0);

    const dumped = JSON.parse(fs.readFileSync(path.join(dumpDir, files[0]), 'utf8')) as {
      model: string;
      messages: { role: string; content: string }[];
    };
    // The dump records what left the app: upstream model forced, harness prompt preserved.
    expect(dumped.model).toBe('deepseek-v4-pro');
    expect(dumped.messages[0]).toEqual({ role: 'system', content: 'SENTINEL_SYSTEM_PROMPT' });
  });

  it('does not create a dump directory when dumping is off', async () => {
    const dumpDir = path.join(tempDir(), 'shim-dumps-off');
    const shim = await startAnthropicShim({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'unused',
      model: 'deepseek-v4-pro',
    });
    try {
      await fetch(`${shim.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: false }),
      }).catch(() => undefined);
    } finally {
      await shim.close();
    }
    expect(fs.existsSync(dumpDir)).toBe(false);
  });
});
