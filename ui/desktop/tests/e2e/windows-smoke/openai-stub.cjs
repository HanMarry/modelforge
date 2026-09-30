#!/usr/bin/env node
'use strict';
/**
 * Loopback OpenAI-compatible stub for the Windows installer smoke test
 * (spec mathmodel-parity-and-beyond, task 13.6; workflow .github/workflows/modelforge-windows-smoke.yml).
 *
 * It stands in for a real model so the installed app can be driven end to end without network
 * access or cost. It speaks the subset of the Chat Completions API the kernel's `openai`
 * provider uses (crates/goose-provider-types/src/formats/openai.rs):
 *
 *   GET  /v1/models              model list (the wizard's connectivity test and context probes)
 *   POST /v1/chat/completions    streamed (SSE) or plain JSON replies
 *
 * Replies are scripted by markers the test puts into its user message:
 *
 *   MFSMOKE_NONCE:<alnum>        tags every request of one test so it can find them again
 *   MFSMOKE_TOOL:<base64url>     JSON `{ "tool": "<name>", "arguments": { ... } }`: when the request
 *                                offers that tool, the stub answers with exactly one tool call
 *
 * After the tool result comes back, the stub answers with a text that echoes the tool output
 * (`MFSMOKE_TOOL_RESULT` followed by the result), so the UI shows what the tool returned. Any
 * other request gets the plain reply `MODELFORGE_WINDOWS_SMOKE_OK`.
 *
 * Test-only endpoints:
 *
 *   GET /__health                liveness probe for the workflow
 *   GET /__requests?nonce=<n>    the logged requests (all, or those carrying the nonce)
 *
 * Every request is also appended to MODELFORGE_STUB_LOG (JSON lines) for the uploaded artifacts.
 * The Authorization header is never logged, only whether one was sent.
 *
 * Environment: MODELFORGE_STUB_PORT (default 47372), MODELFORGE_STUB_LOG,
 * MODELFORGE_STUB_CONSOLE_LOG (the stub's own diagnostics; it is started detached by the workflow).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.MODELFORGE_STUB_PORT || 47372);
const REQUEST_LOG = process.env.MODELFORGE_STUB_LOG || path.join(process.cwd(), 'stub-requests.jsonl');
const CONSOLE_LOG = process.env.MODELFORGE_STUB_CONSOLE_LOG || '';
const MODEL_ID = 'stub-model';
const PLAIN_REPLY = 'MODELFORGE_WINDOWS_SMOKE_OK';
const MAX_ENTRIES = 5000;
const MAX_LOGGED_TEXT = 16 * 1024;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const NONCE_PATTERN = /MFSMOKE_NONCE:([A-Za-z0-9]{4,64})/g;
const TOOL_PATTERN = /MFSMOKE_TOOL:([A-Za-z0-9_-]+)/;

/** @type {object[]} */
const entries = [];

function diag(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  if (CONSOLE_LOG) {
    try {
      fs.appendFileSync(CONSOLE_LOG, line, 'utf8');
    } catch {
      // Diagnostics must never take the stub down.
    }
  } else {
    process.stdout.write(line);
  }
}

function clip(text) {
  if (typeof text !== 'string') return text;
  return text.length > MAX_LOGGED_TEXT ? `${text.slice(0, MAX_LOGGED_TEXT)}…[${text.length} chars]` : text;
}

function record(entry) {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  try {
    fs.mkdirSync(path.dirname(REQUEST_LOG), { recursive: true });
    fs.appendFileSync(REQUEST_LOG, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    diag(`cannot append to ${REQUEST_LOG}: ${error.message}`);
  }
}

/** Text of an OpenAI message `content`: a string or an array of `{ type, text }` parts. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('\n');
  }
  return '';
}

function noncesOf(messages) {
  const found = new Set();
  for (const message of messages) {
    if (!message || message.role !== 'user') continue;
    for (const match of textOf(message.content).matchAll(NONCE_PATTERN)) found.add(match[1]);
  }
  return [...found];
}

function decodeDirective(text) {
  const match = TOOL_PATTERN.exec(text);
  if (!match) return null;
  try {
    const parsed = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    if (parsed && typeof parsed.tool === 'string' && parsed.tool.length > 0) {
      return { tool: parsed.tool, arguments: parsed.arguments ?? {} };
    }
  } catch {
    // Fall through to the error below.
  }
  return { error: 'MFSMOKE_TOOL marker could not be decoded' };
}

function offeredTools(body) {
  if (!Array.isArray(body.tools)) return [];
  return body.tools
    .map((tool) => (tool && tool.function && typeof tool.function.name === 'string' ? tool.function.name : null))
    .filter((name) => name !== null);
}

/** The offered tool matching the requested one: exact name first, then by the unprefixed name. */
function resolveTool(requested, offered) {
  if (offered.includes(requested)) return requested;
  const bare = requested.replace(/^.*(__|\.)/, '');
  return (
    offered.find((name) => name === bare || name.endsWith(`__${bare}`) || name.endsWith(`.${bare}`)) ?? null
  );
}

/** Decides the reply for one chat request; see the file comment. */
function planReply(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index] && messages[index].role === 'user') {
      lastUser = index;
      break;
    }
  }
  const userText = lastUser >= 0 ? textOf(messages[lastUser].content) : '';
  const nonces = noncesOf(messages);
  const toolResults = messages
    .slice(lastUser + 1)
    .filter((message) => message && message.role === 'tool')
    .map((message) => ({ toolCallId: message.tool_call_id ?? null, text: textOf(message.content) }));
  const offered = offeredTools(body);

  if (toolResults.length > 0) {
    // Echo the tool output back so the final assistant message shows what the tool returned.
    const echoed = toolResults.map((result) => result.text).join('\n\n');
    return {
      kind: 'text',
      nonces,
      toolResults,
      offered,
      text: `MFSMOKE_TOOL_RESULT\n\n~~~text\n${echoed}\n~~~\n`,
    };
  }

  const directive = decodeDirective(userText);
  if (directive && directive.error) {
    return { kind: 'text', nonces, toolResults, offered, text: `MFSMOKE_TOOL_ERROR ${directive.error}` };
  }
  if (directive && offered.length > 0) {
    const name = resolveTool(directive.tool, offered);
    if (name) {
      return { kind: 'tool', nonces, toolResults, offered, name, arguments: directive.arguments };
    }
    return {
      kind: 'text',
      nonces,
      toolResults,
      offered,
      text: `MFSMOKE_TOOL_MISSING ${directive.tool}; offered tools: ${offered.join(', ') || '(none)'}`,
    };
  }
  // Requests without tools (for example the session title request) get the plain reply, even
  // when they quote a user message carrying a tool marker.
  return {
    kind: 'text',
    nonces,
    toolResults,
    offered,
    text: nonces.length > 0 ? `${PLAIN_REPLY} ${nonces.join(' ')}` : PLAIN_REPLY,
  };
}

const USAGE = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function streamReply(res, reply, model) {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (choices, extra = {}) =>
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices, ...extra })}\n\n`);

  if (reply.kind === 'tool') {
    const callId = `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    send([
      {
        index: 0,
        delta: {
          role: 'assistant',
          content: null,
          tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: reply.name, arguments: '' } }],
        },
        finish_reason: null,
      },
    ]);
    send([
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.arguments) } }] },
        finish_reason: null,
      },
    ]);
    send([{ index: 0, delta: {}, finish_reason: 'tool_calls' }], { usage: USAGE });
  } else {
    send([{ index: 0, delta: { role: 'assistant', content: reply.text }, finish_reason: null }]);
    send([{ index: 0, delta: {}, finish_reason: 'stop' }], { usage: USAGE });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

function jsonReply(res, reply, model) {
  const message =
    reply.kind === 'tool'
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
              type: 'function',
              function: { name: reply.name, arguments: JSON.stringify(reply.arguments) },
            },
          ],
        }
      : { role: 'assistant', content: reply.text };
  sendJson(res, 200, {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: reply.kind === 'tool' ? 'tool_calls' : 'stop' }],
    usage: USAGE,
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const base = {
    at: new Date().toISOString(),
    method: req.method,
    path: pathname,
    auth: typeof req.headers.authorization === 'string' && req.headers.authorization.length > 0,
  };

  if (req.method === 'GET' && pathname === '/__health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.method === 'GET' && pathname === '/__requests') {
    const nonce = url.searchParams.get('nonce');
    sendJson(res, 200, nonce ? entries.filter((entry) => (entry.nonces || []).includes(nonce)) : entries);
    return;
  }
  if (req.method === 'GET' && pathname.endsWith('/models')) {
    record({ ...base, reply: { kind: 'models' } });
    sendJson(res, 200, {
      object: 'list',
      data: [{ id: MODEL_ID, object: 'model', created: 0, owned_by: 'modelforge-smoke' }],
    });
    return;
  }
  if (req.method === 'POST' && pathname.endsWith('/chat/completions')) {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      record({ ...base, error: `invalid request body: ${error.message}` });
      sendJson(res, 400, { error: { message: 'invalid JSON body', type: 'invalid_request_error' } });
      return;
    }
    const reply = planReply(body);
    const model = typeof body.model === 'string' && body.model ? body.model : MODEL_ID;
    record({
      ...base,
      model,
      stream: body.stream === true,
      nonces: reply.nonces,
      offeredTools: reply.offered.length,
      offeredToolNames: reply.offered.slice(0, 80),
      messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
      toolResults: reply.toolResults.map((result) => ({ ...result, text: clip(result.text) })),
      reply:
        reply.kind === 'tool'
          ? { kind: 'tool', name: reply.name, arguments: reply.arguments }
          : { kind: 'text', text: clip(reply.text) },
    });
    if (body.stream === true) {
      streamReply(res, reply, model);
    } else {
      jsonReply(res, reply, model);
    }
    return;
  }

  // Anything else (for example the Responses API) is not supported; log it so a wrong route
  // shows up in the artifacts instead of as a silent hang.
  record({ ...base, error: 'no stub route' });
  sendJson(res, 404, {
    error: { message: `modelforge smoke stub: no route for ${req.method} ${pathname}`, type: 'not_found' },
  });
}

function start() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      diag(`handler failed: ${error.stack || error.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: { message: 'stub failure', type: 'server_error' } });
      else res.end();
    });
  });

  server.on('error', (error) => {
    diag(`server error: ${error.stack || error.message}`);
    process.exit(1);
  });

  server.listen(PORT, '127.0.0.1', () => {
    diag(`modelforge smoke stub listening on http://127.0.0.1:${PORT} (log: ${REQUEST_LOG})`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

if (require.main === module) {
  start();
}

module.exports = { planReply, textOf, decodeDirective, resolveTool };
