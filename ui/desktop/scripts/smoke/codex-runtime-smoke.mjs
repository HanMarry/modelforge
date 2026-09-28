#!/usr/bin/env node
/**
 * End-to-end check of the bundled Codex runtime (requirement 7.12, 7.14).
 *
 * Starts a local stub of the OpenAI Responses API, writes the same kind of CODEX_HOME
 * config.toml the app generates (src/utils/agentRuntime.ts), launches the packaged
 * `codex-acp.cmd` and drives one ACP session: initialize -> session/new -> session/prompt.
 * Passes when the agent streams back the stub's reply. No real model or API key is involved.
 *
 * Usage: node scripts/smoke/codex-runtime-smoke.mjs --entry <path to resources/bin/codex-acp.cmd>
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXPECTED_TEXT = 'MODELFORGE_SMOKE_OK';
const STEP_TIMEOUT_MS = 90_000;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const entry = argValue('--entry');
if (!entry || !fs.existsSync(entry)) {
  console.error(`codex runtime smoke: --entry must point to codex-acp.cmd (got ${entry})`);
  process.exit(2);
}

const stubRequests = [];

function sendEvent(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

const server = createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1');
    stubRequests.push(`${req.method} ${pathname} (${body.length} bytes)`);

    if (req.method === 'POST' && pathname.endsWith('/responses')) {
      const responseId = `resp_smoke_${stubRequests.length}`;
      const itemId = `msg_smoke_${stubRequests.length}`;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      sendEvent(res, { type: 'response.created', response: { id: responseId } });
      sendEvent(res, {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', role: 'assistant', id: itemId, content: [] },
      });
      sendEvent(res, {
        type: 'response.output_text.delta',
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta: EXPECTED_TEXT,
      });
      sendEvent(res, {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          role: 'assistant',
          id: itemId,
          content: [{ type: 'output_text', text: EXPECTED_TEXT }],
        },
      });
      sendEvent(res, {
        type: 'response.completed',
        response: {
          id: responseId,
          usage: {
            input_tokens: 1,
            input_tokens_details: null,
            output_tokens: 1,
            output_tokens_details: null,
            total_tokens: 2,
          },
        },
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'smoke-model', object: 'model', created: 0, owned_by: 'modelforge' }],
        })
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `no stub for ${req.method} ${pathname}` } }));
  });
});

class AcpClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.nonJsonLines = [];
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onData(chunk));
  }

  onData(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        this.onLine(line);
      }
    }
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.nonJsonLines.push(line);
      return;
    }
    if (message.method && message.id !== undefined) {
      this.answerAgentRequest(message);
      return;
    }
    if (message.method) {
      this.notifications.push(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(`${pending.method} failed: ${JSON.stringify(message.error)}`));
    } else {
      pending.resolve(message.result);
    }
  }

  answerAgentRequest(message) {
    const reply =
      message.method === 'session/request_permission'
        ? { jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } }
        : {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: `smoke client does not implement ${message.method}` },
          };
    this.child.stdin.write(`${JSON.stringify(reply)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${method} timed out after ${STEP_TIMEOUT_MS} ms`)),
        STEP_TIMEOUT_MS
      );
    });
    return Promise.race([response, timeout]).finally(() => clearTimeout(timer));
  }

  agentText() {
    return this.notifications
      .filter((note) => note.method === 'session/update')
      .map((note) => note.params?.update)
      .filter((update) => update?.sessionUpdate === 'agent_message_chunk')
      .map((update) => (update.content?.type === 'text' ? update.content.text : ''))
      .join('');
  }
}

function stopProcessTree(child) {
  if (child.exitCode !== null || child.pid === undefined) {
    return;
  }
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}

async function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelforge-codex-smoke-'));
  const codexHome = path.join(workDir, 'codex-home');
  const projectDir = path.join(workDir, 'project');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  // Same keys provisionCodex() writes for the in-app shim.
  fs.writeFileSync(
    path.join(codexHome, 'config.toml'),
    [
      'model = "smoke-model"',
      'model_provider = "modelforge_shim"',
      'disable_response_storage = true',
      "developer_instructions = '''",
      'You are the ModelForge smoke test.',
      "'''",
      '',
      '[model_providers.modelforge_shim]',
      'name = "ModelForge (local shim)"',
      `base_url = "http://127.0.0.1:${port}/v1"`,
      'wire_api = "responses"',
      'env_key = "MODELFORGE_SHIM_KEY"',
      '',
    ].join('\n'),
    'utf8'
  );

  const stderr = [];
  const child = spawn(`"${entry}"`, [], {
    shell: true,
    windowsHide: true,
    cwd: projectDir,
    env: { ...process.env, CODEX_HOME: codexHome, MODELFORGE_SHIM_KEY: 'smoke-key' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const exited = new Promise((resolve) => child.on('exit', resolve));

  const client = new AcpClient(child);
  let failure = null;
  try {
    const init = await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'modelforge-smoke', version: '1.0.0' },
    });
    console.log(`initialize ok: ${JSON.stringify(init?.agentInfo ?? init?.protocolVersion)}`);

    const session = await client.request('session/new', { cwd: projectDir, mcpServers: [] });
    if (!session?.sessionId) {
      throw new Error(`session/new returned no sessionId: ${JSON.stringify(session)}`);
    }
    console.log(`session/new ok: ${session.sessionId}`);

    const result = await client.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Reply with the smoke token.' }],
    });
    const text = client.agentText();
    console.log(`session/prompt ok: stopReason=${result?.stopReason} text=${JSON.stringify(text)}`);
    if (!text.includes(EXPECTED_TEXT)) {
      throw new Error(`agent reply did not contain ${EXPECTED_TEXT}`);
    }
    if (!stubRequests.some((line) => line.includes('/responses'))) {
      throw new Error('the adapter never reached the Responses stub');
    }
  } catch (error) {
    failure = error;
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => stopProcessTree(child), 10_000);
    await exited;
    clearTimeout(timer);
    server.close();
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  if (failure) {
    console.error(`codex runtime smoke FAILED: ${failure.message}`);
    console.error(`stub requests:\n  ${stubRequests.join('\n  ') || '(none)'}`);
    console.error(
      `agent notifications (last 20):\n  ${client.notifications
        .slice(-20)
        .map((note) => JSON.stringify(note).slice(0, 400))
        .join('\n  ')}`
    );
    if (client.nonJsonLines.length) {
      console.error(`non-JSON stdout:\n  ${client.nonJsonLines.slice(-20).join('\n  ')}`);
    }
    console.error(`adapter stderr (tail):\n${stderr.join('').slice(-4000)}`);
    process.exit(1);
  }
  console.log('codex runtime smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
