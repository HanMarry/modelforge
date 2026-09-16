import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startAnthropicShim } from './anthropicShim';
import { isContextOverflow, isOutputLimitError, parseMaxOutputTokens } from './shimErrors';

const servers: http.Server[] = [];

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop() as http.Server;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** A stand-in provider that rejects `max_tokens` above [limit], like a small-output model does. */
async function upstreamWithOutputLimit(
  limit: number,
  seen: number[]
): Promise<{ url: string }> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { max_tokens?: number };
    seen.push(body.max_tokens ?? 0);

    if ((body.max_tokens ?? 0) > limit) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: `max_tokens must be less than or equal to ${limit}` },
        })
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'cmpl_1',
        choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      })
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1` };
}

const post = (url: string, maxTokens: number) =>
  fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-5',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }),
  });

describe('output-limit errors are not context overflows', () => {
  it('parses the limit the provider states', () => {
    expect(
      parseMaxOutputTokens('{"error":{"message":"max_tokens must be less than or equal to 8192"}}')
    ).toBe(8192);
  });

  it('does not invent a number when the provider states none', () => {
    expect(parseMaxOutputTokens('{"error":{"message":"max_tokens is invalid"}}')).toBeNull();
  });

  it('ignores unrelated 400s', () => {
    expect(parseMaxOutputTokens('{"error":{"message":"model not found"}}')).toBeNull();
  });

  it('classifies a size rejection as an output-limit error, not an overflow', () => {
    const body = '{"error":{"message":"max_tokens must be less than or equal to 8192"}}';
    expect(isOutputLimitError(400, body)).toBe(true);
    // The regression: "max_tokens" used to match the overflow pattern, which made the kernel
    // compact history over a request that only needed a smaller output budget.
    expect(isContextOverflow(400, body)).toBe(false);
  });

  it('still recognises genuine context overflow', () => {
    const body = '{"error":{"message":"This model maximum context length is 131072 tokens"}}';
    expect(isContextOverflow(400, body)).toBe(true);
    expect(isOutputLimitError(400, body)).toBe(false);
  });
});

describe('anthropic shim recovers from an oversized output budget', () => {
  it("retries with the provider's stated limit and returns the answer", async () => {
    const seen: number[] = [];
    const upstream = await upstreamWithOutputLimit(8192, seen);
    const shim = await startAnthropicShim({
      baseUrl: upstream.url,
      apiKey: 'test',
      model: 'small-output-model',
    });
    try {
      // 64000 is what the wrapped CLI actually asks for.
      const response = await post(shim.url, 64000);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { content: { text: string }[] };
      expect(payload.content[0].text).toBe('OK');
      expect(seen).toEqual([64000, 8192]);
    } finally {
      await shim.close();
    }
  });

  it('does not retry when the provider accepts the requested budget', async () => {
    const seen: number[] = [];
    const upstream = await upstreamWithOutputLimit(64000, seen);
    const shim = await startAnthropicShim({
      baseUrl: upstream.url,
      apiKey: 'test',
      model: 'big-output-model',
    });
    try {
      expect((await post(shim.url, 64000)).status).toBe(200);
      expect(seen).toEqual([64000]);
    } finally {
      await shim.close();
    }
  });

  /**
   * When the provider gives no usable number the shim must not guess: the original error has to
   * reach the kernel unchanged so the user sees the real reason.
   */
  it('surfaces a size rejection with no stated limit instead of guessing', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'max_tokens exceeds the maximum' } }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const shim = await startAnthropicShim({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'test',
      model: 'unknown-model',
    });
    try {
      const response = await post(shim.url, 64000);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).not.toContain('prompt is too long');
      expect(body.error.message).toContain('max_tokens');
    } finally {
      await shim.close();
    }
  });
});
