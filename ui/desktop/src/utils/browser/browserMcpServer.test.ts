// @vitest-environment node

/**
 * The built-in browser's MCP server (requirement 12) has to answer every request of every Kernel
 * session. A stateless transport serves a single request, so a shared one left everything after
 * `initialize` unanswered and each new session waited for the extension until its timeout.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { BrowserApprovalRequest, BrowserPanelHost } from './browserPanelHost';
import { startBrowserMcpServer, type BrowserMcpEndpoint } from './browserMcpServer';

interface Typed {
  selector: string;
  text: string;
}

function fakeHost(): { host: BrowserPanelHost; typed: Typed[] } {
  const typed: Typed[] = [];
  const state = {
    url: 'https://example.org/',
    title: 'Example',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
  };
  const host = {
    hasLoadedPage: () => true,
    getState: () => state,
    navigate: () => Promise.resolve({ ok: true }),
    readPage: () =>
      Promise.resolve({
        title: 'Example',
        url: state.url,
        text: '示例页面的正文',
        truncated: false,
      }),
    locate: (selector: string) => Promise.resolve({ description: `输入框 ${selector}` }),
    click: () => Promise.resolve(),
    type: (selector: string, text: string) => {
      typed.push({ selector, text });
      return Promise.resolve();
    },
  };
  return { host: host as unknown as BrowserPanelHost, typed };
}

let endpoint: BrowserMcpEndpoint | null = null;
const clients: Client[] = [];

async function start(approve: (request: BrowserApprovalRequest) => boolean = () => true) {
  const { host, typed } = fakeHost();
  const approvals: BrowserApprovalRequest[] = [];
  const started = await startBrowserMcpServer({
    host,
    requestApproval: (request) => {
      approvals.push(request);
      return Promise.resolve(approve(request));
    },
    onOpen: () => undefined,
    registerSecret: () => undefined,
  });
  endpoint = started;
  return { target: started, typed, approvals };
}

async function connect(target: BrowserMcpEndpoint): Promise<Client> {
  const client = new Client({ name: 'browser-mcp-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(target.url), {
    requestInit: { headers: { Authorization: `Bearer ${target.token}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

function firstText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.find((item) => item.type === 'text')?.text ?? '';
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await endpoint?.close();
  endpoint = null;
});

describe('browser MCP server', () => {
  it('answers every request of several concurrent clients', async () => {
    const { target } = await start();
    const [first, second] = await Promise.all([connect(target), connect(target)]);

    const names = ['browser_click', 'browser_open', 'browser_read', 'browser_type'];
    const [firstTools, secondTools] = await Promise.all([first.listTools(), second.listTools()]);
    expect(firstTools.tools.map((tool) => tool.name).sort()).toEqual(names);
    expect(secondTools.tools.map((tool) => tool.name).sort()).toEqual(names);

    const reads = await Promise.all([
      first.callTool({ name: 'browser_read', arguments: {} }),
      second.callTool({ name: 'browser_read', arguments: {} }),
      first.callTool({ name: 'browser_read', arguments: {} }),
    ]);
    for (const read of reads) {
      expect(isError(read)).toBe(false);
      expect(JSON.parse(firstText(read))).toMatchObject({
        title: 'Example',
        text: '示例页面的正文',
      });
    }
  });

  it('asks for approval and keeps Chinese text intact when typing', async () => {
    const { target, typed, approvals } = await start();
    const client = await connect(target);
    const value = '城市空气质量预测：第一问';

    const result = await client.callTool({
      name: 'browser_type',
      arguments: { selector: '#q', text: value },
    });

    expect(firstText(result)).toBe('typed');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ action: 'type', text: value, url: 'https://example.org/' });
    expect(typed).toEqual([{ selector: '#q', text: value }]);
  });

  it('does not type when the user rejects', async () => {
    const { target, typed } = await start(() => false);
    const client = await connect(target);

    const result = await client.callTool({
      name: 'browser_type',
      arguments: { selector: '#q', text: 'x' },
    });

    expect(isError(result)).toBe(true);
    expect(firstText(result)).toBe('USER_REJECTED');
    expect(typed).toEqual([]);
  });

  it('rejects requests without the token and answers GET with 405', async () => {
    const { target } = await start();

    const noToken = await fetch(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(noToken.status).toBe(401);

    const stream = await fetch(target.url, {
      headers: { Authorization: `Bearer ${target.token}`, accept: 'text/event-stream' },
    });
    expect(stream.status).toBe(405);
  });
});
