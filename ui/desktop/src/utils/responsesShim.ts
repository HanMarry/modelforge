/**
 * OpenAI Responses ⇄ Chat Completions shim.
 *
 * Codex 0.146 removed `wire_api = "chat"` (openai/codex#7782) and now only speaks the Responses
 * API, while the model the user configures in the app (DeepSeek and friends) only speaks
 * `/chat/completions`. This loopback server bridges the two so the Codex kernel runs on the
 * user's own key, with the key injected here rather than on the client.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describeUpstreamError, isContextOverflow, parseMaxOutputTokens } from './shimErrors';

export interface ResponsesShimOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  port?: number;
  onLog?: (message: string) => void;
}

type ResponsesContentPart =
  | { type: 'input_text'; text?: string }
  | { type: 'output_text'; text?: string }
  | { type: 'input_image'; image_url?: string }
  | { type: string; [key: string]: unknown };

type ResponsesInputItem =
  | { type?: 'message'; role?: string; content?: string | ResponsesContentPart[] }
  | { type: 'function_call'; name?: string; arguments?: string; call_id?: string; id?: string }
  | { type: 'function_call_output'; call_id?: string; output?: string }
  | { type: string; [key: string]: unknown };

interface ResponsesRequest {
  model?: string;
  instructions?: string;
  input?: string | ResponsesInputItem[];
  tools?: { type?: string; name?: string; description?: string; parameters?: unknown }[];
  tool_choice?: unknown;
  max_output_tokens?: number;
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

function contentText(content: string | ResponsesContentPart[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const text = (part as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

function toOpenAiMessages(body: ResponsesRequest): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });

  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }

  for (const item of input ?? []) {
    switch (item.type) {
      case undefined:
      case 'message': {
        const message = item as { role?: string; content?: string | ResponsesContentPart[] };
        messages.push({
          // The Responses API uses a `developer` role that Chat Completions providers reject.
          role: message.role === 'developer' ? 'system' : (message.role ?? 'user'),
          content: contentText(message.content),
        });
        break;
      }
      case 'function_call': {
        const call = item as { name?: string; arguments?: string; call_id?: string; id?: string };
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: call.call_id ?? call.id ?? `call_${Math.random().toString(36).slice(2, 8)}`,
              type: 'function',
              function: { name: call.name ?? 'unknown', arguments: call.arguments || '{}' },
            },
          ],
        });
        break;
      }
      case 'function_call_output': {
        const output = item as { call_id?: string; output?: string };
        messages.push({
          role: 'tool',
          tool_call_id: output.call_id ?? '',
          content: output.output ?? '',
        });
        break;
      }
      default:
        break;
    }
  }

  return messages;
}

function toOpenAiTools(body: ResponsesRequest): Record<string, unknown>[] | undefined {
  const tools = (body.tools ?? []).filter((tool) => tool.type === 'function' && tool.name);
  if (tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name as string,
      description: tool.description ?? '',
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }));
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
    message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export async function startResponsesShim(options: ResponsesShimOptions) {
  const log = options.onLog ?? (() => {});
  const upstream = options.baseUrl.replace(/\/+$/, '');
  const chatUrl = upstream.endsWith('/chat/completions')
    ? upstream
    : `${upstream}/chat/completions`;

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(json({ ok: true, upstream: chatUrl, model: options.model }));
      return;
    }
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/responses')) {
      res.writeHead(404).end('not found');
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);

    let body: ResponsesRequest;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ResponsesRequest;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(json({ error: { message: 'bad json', type: 'invalid_request_error' } }));
      return;
    }

    const wantsStream = body.stream !== false;
    const requestedMaxTokens = body.max_output_tokens;
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

    const postUpstream = () =>
      fetch(chatUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
        body: json(payload),
      });

    let upstreamResponse: Response;
    try {
      upstreamResponse = await postUpstream();
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(json({ error: { message: String((error as Error).message ?? error) } }));
      return;
    }

    // Mirrors the Anthropic shim: the CLI's output budget is its own model's, so a smaller real
    // model rejects the request until it is lowered to what the provider states.
    if (!upstreamResponse.ok && upstreamResponse.status === 400) {
      const rejection = await upstreamResponse.text().catch(() => '');
      const allowed = parseMaxOutputTokens(rejection);
      if (allowed !== null && allowed < (requestedMaxTokens ?? Number.POSITIVE_INFINITY)) {
        log(
          `← upstream rejected max_tokens=${requestedMaxTokens}; retrying with ${allowed} ` +
            `(stated by provider)`
        );
        payload.max_tokens = allowed;
        try {
          upstreamResponse = await postUpstream();
        } catch (error) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(json({ error: { message: String((error as Error).message ?? error) } }));
          return;
        }
      } else {
        upstreamResponse = new Response(rejection, {
          status: upstreamResponse.status,
          headers: upstreamResponse.headers,
        });
      }
    }

    if (!upstreamResponse.ok || !upstreamResponse.body) {
      const detail = await upstreamResponse.text().catch(() => '');
      log(`← upstream error ${upstreamResponse.status}: ${detail.slice(0, 300)}`);
      res.writeHead(upstreamResponse.status, { 'content-type': 'application/json' });
      res.end(
        json({
          error: {
            message: describeUpstreamError(upstreamResponse.status, detail, options.model),
            type: 'invalid_request_error',
            ...(isContextOverflow(upstreamResponse.status, detail)
              ? { code: 'context_length_exceeded' }
              : {}),
          },
        })
      );
      return;
    }

    const responseId = `resp_${Date.now().toString(36)}`;
    const messageItemId = `msg_${Date.now().toString(36)}`;

    const baseResponse = {
      id: responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model: options.model,
      status: 'in_progress',
      output: [] as unknown[],
    };

    if (!wantsStream) {
      const completion = (await upstreamResponse.json()) as UpstreamChunk;
      const choice = completion.choices?.[0];
      const output: unknown[] = [];
      const text = choice?.message?.content ?? '';
      if (text) {
        output.push({
          id: messageItemId,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        });
      }
      for (const call of choice?.message?.tool_calls ?? []) {
        output.push({
          type: 'function_call',
          id: `fc_${Math.random().toString(36).slice(2, 10)}`,
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
          status: 'completed',
        });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        json({
          ...baseResponse,
          status: 'completed',
          output,
          usage: {
            input_tokens: completion.usage?.prompt_tokens ?? 0,
            output_tokens: completion.usage?.completion_tokens ?? 0,
            total_tokens:
              (completion.usage?.prompt_tokens ?? 0) + (completion.usage?.completion_tokens ?? 0),
          },
        })
      );
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (type: string, data: Record<string, unknown>) =>
      res.write(`event: ${type}\ndata: ${json({ type, ...data })}\n\n`);

    send('response.created', { response: baseResponse });
    send('response.in_progress', { response: baseResponse });

    let textStarted = false;
    let messageOutputIndex = -1;
    let textBuffer = '';
    let nextOutputIndex = 0;
    const toolItems = new Map<
      number,
      { outputIndex: number; itemId: string; callId: string; name: string; args: string }
    >();
    let inputTokens = 0;
    let outputTokens = 0;

    const startMessageItem = () => {
      if (textStarted) return;
      textStarted = true;
      messageOutputIndex = nextOutputIndex++;
      send('response.output_item.added', {
        output_index: messageOutputIndex,
        item: {
          id: messageItemId,
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
      });
      send('response.content_part.added', {
        item_id: messageItemId,
        output_index: messageOutputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
    };

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

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return;

      if (delta.content) {
        startMessageItem();
        textBuffer += delta.content;
        send('response.output_text.delta', {
          item_id: messageItemId,
          output_index: messageOutputIndex,
          content_index: 0,
          delta: delta.content,
        });
      }

      for (const call of delta.tool_calls ?? []) {
        const callIndex = call.index ?? 0;
        let item = toolItems.get(callIndex);
        if (!item) {
          item = {
            outputIndex: nextOutputIndex++,
            itemId: `fc_${Math.random().toString(36).slice(2, 10)}`,
            callId: call.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
            name: call.function?.name ?? 'unknown',
            args: '',
          };
          toolItems.set(callIndex, item);
          send('response.output_item.added', {
            output_index: item.outputIndex,
            item: {
              id: item.itemId,
              type: 'function_call',
              call_id: item.callId,
              name: item.name,
              arguments: '',
              status: 'in_progress',
            },
          });
        }
        const args = call.function?.arguments;
        if (args) {
          item.args += args;
          send('response.function_call_arguments.delta', {
            item_id: item.itemId,
            output_index: item.outputIndex,
            delta: args,
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

    const output: unknown[] = [];
    if (textStarted) {
      const messageItem = {
        id: messageItemId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: textBuffer, annotations: [] }],
      };
      send('response.output_text.done', {
        item_id: messageItemId,
        output_index: messageOutputIndex,
        content_index: 0,
        text: textBuffer,
      });
      send('response.content_part.done', {
        item_id: messageItemId,
        output_index: messageOutputIndex,
        content_index: 0,
        part: { type: 'output_text', text: textBuffer, annotations: [] },
      });
      send('response.output_item.done', {
        output_index: messageOutputIndex,
        item: messageItem,
      });
      output.push(messageItem);
    }

    for (const item of toolItems.values()) {
      const completeItem = {
        id: item.itemId,
        type: 'function_call',
        call_id: item.callId,
        name: item.name,
        arguments: item.args || '{}',
        status: 'completed',
      };
      send('response.function_call_arguments.done', {
        item_id: item.itemId,
        output_index: item.outputIndex,
        arguments: item.args || '{}',
      });
      send('response.output_item.done', { output_index: item.outputIndex, item: completeItem });
      output.push(completeItem);
    }

    send('response.completed', {
      response: {
        ...baseResponse,
        status: 'completed',
        output,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
      },
    });
    res.end();
    log(`← stream done items=${output.length} out=${outputTokens}`);
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  log(`responses shim on http://127.0.0.1:${address.port} → ${chatUrl}`);
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

// Standalone entry: `tsx responsesShim.ts` (used by the Codex acceptance test).
if (process.argv[1] && process.argv[1].includes('responsesShim')) {
  const baseUrl = process.env.SHIM_UPSTREAM_BASE_URL ?? '';
  const apiKey = process.env.SHIM_UPSTREAM_API_KEY ?? '';
  const model = process.env.SHIM_UPSTREAM_MODEL ?? 'deepseek-chat';
  const port = Number(process.env.SHIM_PORT ?? 8788);
  if (!baseUrl || !apiKey) {
    console.error('需要 SHIM_UPSTREAM_BASE_URL 与 SHIM_UPSTREAM_API_KEY');
    process.exit(1);
  }
  startResponsesShim({
    baseUrl,
    apiKey,
    model,
    port,
    onLog: (m) => console.log(`[shim] ${m}`),
  }).catch((error) => {
    console.error('[shim] 启动失败', error);
    process.exit(1);
  });
}
