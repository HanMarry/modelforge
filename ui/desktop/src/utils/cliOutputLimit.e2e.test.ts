/**
 * End-to-end check: the bundled claude.exe → the real ModelForge shim → an upstream that rejects
 * the output budget the CLI asks for.
 *
 * Why this is a test and not a mock: the offending `max_tokens` value (64000) is chosen by the
 * wrapped CLI itself, so the retry can only be proved with the real CLI in the loop. The upstream
 * is a local stub — no provider credentials are involved.
 *
 * Skips itself when the bundled CLI is not installed on this machine.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAnthropicShim } from './anthropicShim';

const CLAUDE_EXE =
  process.env.MODELFORGE_CLAUDE_EXE ??
  path.join(os.homedir(), 'AppData/Local/Programs/@mathmodeldesktop/resources/claude-code/claude.exe');

const OUTPUT_LIMIT = 8192;
const bundledCliAvailable = fs.existsSync(CLAUDE_EXE);

interface LimitedUpstream {
  seenMaxTokens: number[];
  url: string;
  close: () => Promise<void>;
}

/**
 * OpenAI-style SSE, because the shim always asks upstream to stream. Answering with a plain JSON
 * body would leave the shim parsing nothing and the CLI reporting an empty result.
 */
function sseBody(text: string): string {
  const chunk = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({
      id: 'cmpl_e2e',
      choices: [{ delta, finish_reason: finish }],
    })}\n\n`;

  return (
    chunk({ role: 'assistant', content: text }, null) +
    chunk({}, 'stop') +
    `data: ${JSON.stringify({
      id: 'cmpl_e2e',
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    })}\n\n` +
    'data: [DONE]\n\n'
  );
}

async function startLimitedUpstream(): Promise<LimitedUpstream> {
  const seenMaxTokens: number[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { max_tokens?: number };
    seenMaxTokens.push(body.max_tokens ?? 0);

    if ((body.max_tokens ?? 0) > OUTPUT_LIMIT) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: `max_tokens must be less than or equal to ${OUTPUT_LIMIT}` },
        })
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.end(sseBody('E2E_OK'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    seenMaxTokens,
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function runClaude(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_EXE, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.on('error', (error) =>
      resolve({ code: -1, out: `${out}\nspawn error: ${error.message}` })
    );
    child.on('close', (code) => resolve({ code, out }));
  });
}

describe.skipIf(!bundledCliAvailable)('bundled CLI output-budget recovery', () => {
  let upstream: LimitedUpstream;

  beforeAll(async () => {
    upstream = await startLimitedUpstream();
  });

  afterAll(async () => {
    await upstream.close();
  });

  it(
    'answers normally when the provider rejects the 64k output budget the CLI requests',
    async () => {
      const shim = await startAnthropicShim({
        baseUrl: upstream.url,
        apiKey: 'e2e-token',
        model: 'small-output-model',
      });
      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelforge-e2e-'));

      try {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          ANTHROPIC_BASE_URL: shim.url,
          ANTHROPIC_AUTH_TOKEN: 'e2e-token',
          CLAUDE_CONFIG_DIR: configDir,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1',
          NO_PROXY: '127.0.0.1,localhost',
          // The CLI refuses plain HTTP to a loopback shim unless cert checks are relaxed.
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
        };
        // A machine-level proxy otherwise intercepts loopback and breaks the run.
        for (const key of [
          'HTTP_PROXY',
          'HTTPS_PROXY',
          'http_proxy',
          'https_proxy',
          'ALL_PROXY',
          'all_proxy',
        ]) {
          delete env[key];
        }

        const result = await runClaude(
          [
            '--print',
            '--output-format',
            'json',
            '--debug-file',
            path.join(configDir, 'debug.log'),
            'reply with the single word PROBE',
          ],
          env
        );

        // Completed turn, and the retry really happened against the CLI's own number.
        expect(result.out).toContain('E2E_OK');
        expect(upstream.seenMaxTokens[0]).toBeGreaterThan(OUTPUT_LIMIT);
        expect(upstream.seenMaxTokens).toContain(OUTPUT_LIMIT);
      } finally {
        await shim.close();
        fs.rmSync(configDir, { recursive: true, force: true });
      }
    },
    180_000
  );
});

if (!bundledCliAvailable) {
  // Keep the reason visible instead of failing the suite on machines without the bundle.
  it.skip(`bundled CLI not present at ${CLAUDE_EXE}`, () => undefined);
}
