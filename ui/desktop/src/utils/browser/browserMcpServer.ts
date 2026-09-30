/**
 * Streamable HTTP MCP server exposing the built-in browser to the Kernel (requirement 12).
 * It binds only to loopback on a random port and requires a per-launch Bearer token, so the tools
 * cannot be reached from another process or machine. `browser_click` and `browser_type` always ask
 * the user through the approval channel, regardless of the Kernel's permission mode (12.3).
 *
 * The server is stateless and every POST gets its own `McpServer` and transport. A stateless
 * transport serves exactly one request (the SDK throws on reuse since 1.26), and one instance
 * shared by several Kernel sessions would mix up their JSON-RPC ids (GHSA-345p-7cg4-v4c7). A
 * reused transport left every request after `initialize` without a response, so the Kernel
 * waited for the extension until its timeout on each new session. Nothing is lost: the tools keep
 * no state between requests and the server sends no notifications of its own, so GET (the
 * optional SSE stream) and DELETE (session end) answer 405, as the MCP spec allows.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { BrowserApprovalRequest, BrowserPanelHost } from './browserPanelHost';

export interface BrowserMcpEndpoint {
  url: string;
  token: string;
  close: () => Promise<void>;
}

export interface BrowserMcpDeps {
  host: BrowserPanelHost;
  requestApproval: (request: BrowserApprovalRequest) => Promise<boolean>;
  /** Notifies the renderer to switch to the browser tab after a Kernel-initiated open. */
  onOpen: () => void;
  /** Registers the token in the log mask so it never reaches a log file (3.7). */
  registerSecret: (value: string) => void;
}

function text(text: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text }] };
}

function error(text: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text }], isError: true };
}

function timingSafeEqualHex(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, '').replace(/^\[/, '').replace(/\]$/, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** Answers a request that never reaches an MCP server with a JSON-RPC error body. */
function reject(
  res: http.ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {}
): void {
  res
    .writeHead(status, { 'content-type': 'application/json', ...headers })
    .end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/** A fresh MCP server with the four browser tools; one is created per HTTP request. */
function createBrowserMcpServer({ host, requestApproval, onOpen }: BrowserMcpDeps): McpServer {
  const server = new McpServer({ name: 'modelforge-browser', version: '1.0.0' });

  server.registerTool(
    'browser_open',
    { description: 'Open a URL in the built-in browser panel.', inputSchema: { url: z.string() } },
    async ({ url }) => {
      const result = await host.navigate(url);
      if (!result.ok) {
        if (result.code === 'URL_SCHEME') return error('URL_SCHEME');
        return error(`LOAD_FAILED:${result.error?.reason ?? 'other'}`);
      }
      onOpen();
      return text(JSON.stringify(host.getState()));
    }
  );

  server.registerTool(
    'browser_read',
    { description: 'Read the title, URL and visible text of the current browser page.' },
    async () => {
      const result = await host.readPage();
      if ('code' in result) return error(result.code);
      return text(JSON.stringify(result));
    }
  );

  server.registerTool(
    'browser_click',
    {
      description: 'Click an element in the browser page, identified by a CSS selector.',
      inputSchema: { selector: z.string() },
    },
    async ({ selector }) => {
      if (!host.hasLoadedPage()) return error('NO_PAGE');
      const target = await host.locate(selector);
      if (!target) return error(`ELEMENT_NOT_FOUND:${selector}`);
      const approved = await requestApproval({
        id: randomUUID(),
        action: 'click',
        description: target.description,
        url: host.getState().url,
      });
      if (!approved) return error('USER_REJECTED');
      await host.click(selector);
      return text('clicked');
    }
  );

  server.registerTool(
    'browser_type',
    {
      description: 'Type text into an element in the browser page, identified by a CSS selector.',
      inputSchema: { selector: z.string(), text: z.string() },
    },
    async ({ selector, text: value }) => {
      if (!host.hasLoadedPage()) return error('NO_PAGE');
      const target = await host.locate(selector);
      if (!target) return error(`ELEMENT_NOT_FOUND:${selector}`);
      const approved = await requestApproval({
        id: randomUUID(),
        action: 'type',
        description: target.description,
        text: value,
        url: host.getState().url,
      });
      if (!approved) return error('USER_REJECTED');
      await host.type(selector, value);
      return text('typed');
    }
  );

  return server;
}

async function handlePost(
  deps: BrowserMcpDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: unknown
): Promise<void> {
  const server = createBrowserMcpServer(deps);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (failure) {
    console.error('[browser] MCP request failed', failure);
    if (!res.headersSent) {
      reject(res, 500, -32603, 'Internal error');
    }
  }
}

export function startBrowserMcpServer(deps: BrowserMcpDeps): Promise<BrowserMcpEndpoint> {
  const token = randomBytes(32).toString('base64url');
  deps.registerSecret(token);

  return new Promise<BrowserMcpEndpoint>((resolve, rejectStart) => {
    const httpServer = http.createServer((req, res) => {
      const authorization = req.headers.authorization ?? '';
      const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!bearer || !timingSafeEqualHex(bearer, token)) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
        return;
      }
      if (!isLoopbackHost(req.headers.host)) {
        res.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"forbidden"}');
        return;
      }
      if (req.method !== 'POST') {
        reject(res, 405, -32000, 'Method not allowed.', { allow: 'POST' });
        return;
      }

      // Decode as UTF-8 across chunk boundaries, so text typed into a page (browser_type) keeps
      // multi-byte characters such as Chinese intact.
      req.setEncoding('utf8');
      let body = '';
      req.on('data', (chunk: string) => {
        body += chunk;
      });
      req.on('end', () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          reject(res, 400, -32700, 'Parse error');
          return;
        }
        void handlePost(deps, req, res, parsed);
      });
    });

    httpServer.on('error', rejectStart);
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        token,
        close: () =>
          new Promise<void>((done) => {
            httpServer.closeAllConnections();
            httpServer.close(() => done());
          }),
      });
    });
  });
}
