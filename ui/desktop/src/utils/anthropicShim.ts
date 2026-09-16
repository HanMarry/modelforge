/**
 * Anthropic Messages ⇄ OpenAI Chat Completions shim.
 *
 * Claude Code (our packaged agent kernel) only speaks Anthropic's `/v1/messages` shape, while
 * the model the user configures in the app (DeepSeek and friends) only speaks
 * `/chat/completions`. This runs a loopback server that translates both directions, so the user
 * only has to enter a key in the app: everything shape-related is handled here.
 *
 * M1 scope: text, tool_use / tool_result, streaming SSE, usage accounting, model override.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { anthropicErrorType, describeUpstreamError, parseMaxOutputTokens } from './shimErrors';

export interface AnthropicShimOptions {
  /** Upstream OpenAI-compatible base, e.g. https://api.deepseek.com/v1 */
  baseUrl: string;
  apiKey: string;
  /** Model to force upstream (Claude Code asks for claude-* names the provider does not know). */
  model: string;
  /**
   * Optional ceiling for `max_tokens`. The CLI requests its own output budget (64k), which smaller
   * models reject outright; setting this avoids one wasted round trip per session.
   */
  maxOutputTokens?: number;
  port?: number;
  /**
   * Directory to write the exact upstream payload into. The kernel's system prompt is written by
   * the wrapped CLI, so when the agent misstates its own identity the only way to tell whether the
   * cause is the prompt or the model is to read what actually left this process.
   */
  dumpDir?: string;
  onLog?: (message: string) => void;
}

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}
interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | AnthropicTextBlock[];
  is_error?: boolean;
}
interface AnthropicImageBlock {
  type: 'image';
  source?: { type: string; media_type?: string; data?: string };
}
type AnthropicBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicImageBlock
  | { type: string; [key: string]: unknown };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

interface AnthropicRequest {
  model?: string;
  system?: string | AnthropicTextBlock[];
  messages?: AnthropicMessage[];
  tools?: { name: string; description?: string; input_schema?: unknown }[];
  tool_choice?: { type?: string; name?: string };
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

interface OpenAiToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

const json = (value: unknown) => JSON.stringify(value);

/** Per-string cap for dumps, so one huge prompt cannot turn a diagnostic into a disk-space bug. */
const DUMP_STRING_LIMIT = 200_000;

function clampForDump(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > DUMP_STRING_LIMIT
      ? `${value.slice(0, DUMP_STRING_LIMIT)}\n…[truncated ${value.length - DUMP_STRING_LIMIT} chars]`
      : value;
  }
  if (Array.isArray(value)) return value.map(clampForDump);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, clampForDump(v)])
    );
  }
  return value;
}

/** Best-effort: a diagnostic must never be able to take the shim down. */
function dumpPayload(dumpDir: string | undefined, payload: Record<string, unknown>): void {
  if (!dumpDir) return;
  try {
    fs.mkdirSync(dumpDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(
      path.join(dumpDir, `upstream-${stamp}-pid${process.pid}.json`),
      JSON.stringify(clampForDump(payload), null, 2),
      'utf8'
    );
  } catch {
    // ignored on purpose
  }
}

function textOf(content: string | AnthropicBlock[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is AnthropicTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** Anthropic system + messages → OpenAI messages, flattening tool blocks. */
function toOpenAiMessages(body: AnthropicRequest): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];

  const system = body.system && textOf(body.system as AnthropicTextBlock[]);
  if (body.system && !system) {
    messages.push({ role: 'system', content: String(body.system) });
  } else if (system) {
    messages.push({ role: 'system', content: system });
  }

  for (const message of body.messages ?? []) {
    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content });
      continue;
    }

    const blocks = message.content ?? [];
    const toolResults = blocks.filter(
      (block): block is AnthropicToolResultBlock => block.type === 'tool_result'
    );
    for (const result of toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: result.tool_use_id,
        content: textOf(result.content) || (result.is_error ? 'error' : ''),
      });
    }

    const toolUses = blocks.filter(
      (block): block is AnthropicToolUseBlock => block.type === 'tool_use'
    );
    const text = textOf(blocks);
    const images = blocks.filter(
      (block): block is AnthropicImageBlock =>
        block.type === 'image' && Boolean((block as AnthropicImageBlock).source?.data)
    );

    if (toolUses.length > 0 && message.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolUses.map((use) => ({
          id: use.id,
          type: 'function',
          function: { name: use.name, arguments: json(use.input ?? {}) },
        })),
      });
      continue;
    }

    if (images.length > 0) {
      const parts: Record<string, unknown>[] = images.map((block) => {
        const source = (block as AnthropicImageBlock).source;
        return {
          type: 'image_url',
          image_url: { url: `data:${source?.media_type};base64,${source?.data ?? ''}` },
        };
      });
      if (text) parts.unshift({ type: 'text', text });
      messages.push({ role: message.role, content: parts });
      continue;
    }

    if (text) messages.push({ role: message.role, content: text });
  }

  return messages;
}

function toOpenAiTools(body: AnthropicRequest): Record<string, unknown>[] | undefined {
  if (!body.tools?.length) return undefined;
  return body.tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.input_schema ?? { type: 'object', properties: {} },
    },
  }));
}

function stopReasonOf(finish: string | null | undefined): string {
  switch (finish) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    default:
      return 'end_turn';
  }
}

interface UpstreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export async function startAnthropicShim(options: AnthropicShimOptions) {
  const log = options.onLog ?? (() => {});
  const upstream = options.baseUrl.replace(/\/+$/, '');
  const chatUrl = upstream.endsWith('/chat/completions')
    ? upstream
    : `${upstream}/chat/completions`;

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(json({ ok: true, upstream: chatUrl, model: options.model, dumpDir: options.dumpDir ?? null }));
      return;
    }

    if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
      res.writeHead(404).end('not found');
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);

    let body: AnthropicRequest;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as AnthropicRequest;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        json({ type: 'error', error: { type: 'invalid_request_error', message: 'bad json' } })
      );
      return;
    }

    // count_tokens: Claude Code only needs a rough number to plan.
    if (req.url.startsWith('/v1/messages/count_tokens')) {
      const text = json(toOpenAiMessages(body)).length;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(json({ input_tokens: Math.ceil(text / 4) }));
      return;
    }

    const wantsStream = body.stream !== false;
    const requestedMaxTokens = body.max_tokens;
    const payload: Record<string, unknown> = {
      model: options.model,
      messages: toOpenAiMessages(body),
      stream: wantsStream,
      ...(wantsStream ? { stream_options: { include_usage: true } } : {}),
      ...(requestedMaxTokens ? { max_tokens: requestedMaxTokens } : {}),
      ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    };
    const tools = toOpenAiTools(body);
    if (tools) payload.tools = tools;

    log(
      `→ upstream model=${options.model} messages=${(payload.messages as unknown[]).length} tools=${
        tools?.length ?? 0
      } stream=${wantsStream}`
    );
    dumpPayload(options.dumpDir, payload);

    const postUpstream = () =>
      fetch(chatUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body: json(payload),
      });

    let upstreamResponse: Response;
    try {
      upstreamResponse = await postUpstream();
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(
        json({
          type: 'error',
          error: { type: 'api_error', message: String((error as Error).message ?? error) },
        })
      );
      return;
    }

    // The CLI picks its output budget from the harness model (64k). A smaller real model rejects
    // the whole request, so lower it to whatever the upstream states and try once more. Doing this
    // here — rather than trusting a configured number — means any user-chosen model self-corrects.
    if (!upstreamResponse.ok && upstreamResponse.status === 400) {
      const rejection = await upstreamResponse.text().catch(() => '');
      const allowed = parseMaxOutputTokens(rejection);
      if (allowed !== null && allowed < (requestedMaxTokens ?? Number.POSITIVE_INFINITY)) {
        log(
          `← upstream rejected max_tokens=${requestedMaxTokens}; retrying with ${allowed} ` +
            `(stated by provider)`
        );
        payload.max_tokens = allowed;
        dumpPayload(options.dumpDir, payload);
        try {
          upstreamResponse = await postUpstream();
        } catch (error) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(
            json({
              type: 'error',
              error: { type: 'api_error', message: String((error as Error).message ?? error) },
            })
          );
          return;
        }
      } else {
        // No stated number: hand the original body back to the normal error path below.
        upstreamResponse = new Response(rejection, {
          status: upstreamResponse.status,
          headers: upstreamResponse.headers,
        });
      }
    }

    if (!upstreamResponse.ok || !upstreamResponse.body) {
      const detail = await upstreamResponse.text().catch(() => '');
      log(`← upstream error ${upstreamResponse.status}: ${detail.slice(0, 400)}`);
      res.writeHead(upstreamResponse.status, { 'content-type': 'application/json' });
      res.end(
        json({
          type: 'error',
          error: {
            type: anthropicErrorType(upstreamResponse.status),
            message: describeUpstreamError(upstreamResponse.status, detail, options.model),
          },
        })
      );
      return;
    }

    const messageId = `msg_${Date.now().toString(36)}`;

    if (!wantsStream) {
      const completion = (await upstreamResponse.json()) as UpstreamChunk;
      const choice = completion.choices?.[0];
      const content: AnthropicBlock[] = [];
      const delta = choice?.delta ?? {};
      const text = (choice as { message?: { content?: string } }).message?.content ?? delta.content;
      if (text) content.push({ type: 'text', text });
      const calls = (choice as { message?: { tool_calls?: unknown[] } }).message?.tool_calls ?? [];
      for (const call of calls as OpenAiToolCall[]) {
        let input: unknown;
        try {
          input = JSON.parse(call.arguments || '{}');
        } catch {
          input = {};
        }
        content.push({ type: 'tool_use', id: call.id, name: call.name, input });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        json({
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: options.model,
          content,
          stop_reason: stopReasonOf(choice?.finish_reason ?? undefined),
          stop_sequence: null,
          usage: {
            input_tokens: completion.usage?.prompt_tokens ?? 0,
            output_tokens: completion.usage?.completion_tokens ?? 0,
          },
        })
      );
      return;
    }

    // ---- streaming: OpenAI SSE → Anthropic SSE ----
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${json(data)}\n\n`);

    send('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: options.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

    let textBlockIndex = -1;
    let nextIndex = 0;
    const toolBlocks = new Map<number, { index: number; id: string; name: string }>();
    let finishReason: string | null = null;
    let outputTokens = 0;
    let inputTokens = 0;

    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const handleEvent = (raw: string) => {
      const dataLine = raw
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      if (!dataLine || dataLine === '[DONE]') return;

      let chunk: UpstreamChunk;
      try {
        chunk = JSON.parse(dataLine) as UpstreamChunk;
      } catch {
        return;
      }

      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
        outputTokens = chunk.usage.completion_tokens ?? outputTokens;
      }

      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const textDelta = choice.delta?.content;
      if (textDelta) {
        if (textBlockIndex === -1) {
          textBlockIndex = nextIndex++;
          send('content_block_start', {
            type: 'content_block_start',
            index: textBlockIndex,
            content_block: { type: 'text', text: '' },
          });
        }
        send('content_block_delta', {
          type: 'content_block_delta',
          index: textBlockIndex,
          delta: { type: 'text_delta', text: textDelta },
        });
      }

      for (const call of choice.delta?.tool_calls ?? []) {
        const callIndex = call.index ?? 0;
        let block = toolBlocks.get(callIndex);
        if (!block) {
          block = {
            index: nextIndex++,
            id: call.id ?? `toolu_${Math.random().toString(36).slice(2, 10)}`,
            name: call.function?.name ?? 'unknown',
          };
          toolBlocks.set(callIndex, block);
          send('content_block_start', {
            type: 'content_block_start',
            index: block.index,
            content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
          });
        }
        const args = call.function?.arguments;
        if (args) {
          send('content_block_delta', {
            type: 'content_block_delta',
            index: block.index,
            delta: { type: 'input_json_delta', partial_json: args },
          });
        }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) handleEvent(part);
    }
    if (buffer.trim()) handleEvent(buffer);

    if (textBlockIndex !== -1) {
      send('content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
    }
    for (const block of toolBlocks.values()) {
      send('content_block_stop', { type: 'content_block_stop', index: block.index });
    }
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReasonOf(finishReason), stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    });
    send('message_stop', { type: 'message_stop' });
    res.end();
    log(`← stream done stop=${stopReasonOf(finishReason)} out=${outputTokens}`);
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  log(`shim listening on http://127.0.0.1:${address.port} → ${chatUrl}`);
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    /** The kernel only names its own models, so the upstream model can change at runtime. */
    setModel: (model: string) => {
      options.model = model;
      log(`upstream model switched to ${model}`);
    },
    /** The key is read per request, so it can be replaced without restarting the shim. */
    setApiKey: (apiKey: string) => {
      options.apiKey = apiKey;
      log('upstream key replaced');
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Standalone entry: `tsx anthropicShim.ts` (used by the M1 acceptance test).
if (process.argv[1] && process.argv[1].includes('anthropicShim')) {
  const baseUrl = process.env.SHIM_UPSTREAM_BASE_URL ?? '';
  const apiKey = process.env.SHIM_UPSTREAM_API_KEY ?? '';
  const model = process.env.SHIM_UPSTREAM_MODEL ?? 'deepseek-chat';
  const port = Number(process.env.SHIM_PORT ?? 8787);

  if (!baseUrl || !apiKey) {
    console.error('需要 SHIM_UPSTREAM_BASE_URL 与 SHIM_UPSTREAM_API_KEY');
    process.exit(1);
  }
  startAnthropicShim({
    baseUrl,
    apiKey,
    model,
    port,
    onLog: (message) => console.log(`[shim] ${message}`),
  }).catch((error) => {
    console.error('[shim] 启动失败', error);
    process.exit(1);
  });
}
