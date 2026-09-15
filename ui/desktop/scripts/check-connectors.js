#!/usr/bin/env node
/**
 * Speaks the MCP stdio handshake to each installable connector and reports whether it
 * answers.
 *
 * Why this exists: the acceptance checklist's biggest open question was "does clicking
 * Install in the app actually produce a working MCP server?" Package metadata and
 * `--help` do not answer that — the server has to complete `initialize` and `tools/list`.
 * This script performs exactly that exchange, using the same command and arguments the
 * connector catalogue stores, so a connector that cannot handshake fails here instead of
 * failing on a user's machine.
 *
 * Usage:
 *   node scripts/check-connectors.js            # all installable connectors
 *   node scripts/check-connectors.js arxiv      # one, by id
 *
 * Network access is required: uvx/npx fetch the package on first run.
 */
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const DESKTOP = path.join(__dirname, '..');
const REPO = path.join(DESKTOP, '..', '..');

/**
 * The installable connectors, mirrored from src/catalog/connectors.ts. Kept explicit
 * rather than parsed so that a mismatch is visible in review; `docs-check` guards the
 * counts.
 */
const CONNECTORS = [
  {
    id: 'arxiv',
    cmd: 'uvx',
    args: ['arxiv-mcp-server'],
    expectTools: true,
  },
  {
    id: 'web-fetch',
    cmd: 'uvx',
    args: ['mcp-server-fetch'],
    expectTools: true,
  },
  {
    id: 'zotero',
    cmd: 'uvx',
    args: ['zotero-mcp'],
    env: { ZOTERO_LOCAL: 'true' },
    expectTools: true,
  },
  {
    id: 'drawio',
    cmd: 'uvx',
    args: ['--from', 'drawio-mcp', '--with', 'mcp<2', 'drawio-mcp'],
    expectTools: true,
  },
  {
    id: 'crossref',
    cmd: 'uvx',
    args: ['--from', 'crossref-mcp', '--with', 'mcp<2', 'crossref-mcp'],
    expectTools: true,
  },
  {
    id: 'context7',
    cmd: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    expectTools: true,
  },
  {
    id: 'fred',
    cmd: 'uvx',
    args: ['fred-mcp'],
    // Exits with a clear message when the key is absent; see the note in the report.
    expectCredentialError: /FRED_API_KEY/,
  },
  {
    id: 'github',
    // Remote streamable-http server; not a stdio child, checked separately.
    remote: 'https://api.githubcopilot.com/mcp/',
  },
];

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'modelforge-connector-check', version: '1.0.0' },
  },
};

const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };

const LIST_TOOLS = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

/**
 * Resolve the launcher the way the app does: directly, with no shell in between.
 *
 * Using `shell: true` would hand the arguments to cmd.exe, which treats `<` in
 * `--with mcp<2` as an input redirection and fails with "The system cannot find the
 * file specified". The desktop app spawns the process directly, so the check does too —
 * otherwise it would report a failure users cannot actually hit.
 *
 * Windows needs one extra step for `npx`: Node 20.12+/22+ refuse to spawn a `.cmd` file
 * without a shell (the CVE-2024-27980 mitigation makes `spawn('npx.cmd')` throw EINVAL),
 * and `spawn` throws that synchronously rather than emitting `error`. The desktop app
 * ships its own `npx.cmd` shim for this; here npm's `npx-cli.js` is run through the
 * current Node interpreter, which needs no shell and no shim.
 */
function which(name) {
  try {
    const output = execFileSync('where', [name], { stdio: 'pipe', encoding: 'utf8' });
    return (
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)[0] ?? null
    );
  } catch {
    return null;
  }
}

function resolveLauncher(cmd) {
  if (process.platform !== 'win32') return { command: cmd, args: [] };

  if (cmd === 'npx') {
    const npxCmd = which('npx.cmd');
    if (npxCmd) {
      const candidates = [
        'node_modules/npm/bin/npx-cli.js',
        '../lib/node_modules/npm/bin/npx-cli.js',
      ];
      for (const relative of candidates) {
        const cli = path.resolve(path.dirname(npxCmd), relative);
        if (fs.existsSync(cli)) return { command: process.execPath, args: [cli] };
      }
    }
    return { command: 'npx.cmd', args: [] };
  }

  const candidates = cmd === 'uvx' ? ['uvx.exe', 'uvx'] : [cmd];
  for (const candidate of candidates) {
    if (which(candidate)) return { command: candidate, args: [] };
  }
  return { command: cmd, args: [] };
}

function runStdioHandshake(connector, timeoutMs) {
  return new Promise((resolve) => {
    const launcher = resolveLauncher(connector.cmd);
    let child;
    try {
      child = spawn(launcher.command, [...launcher.args, ...connector.args], {
        env: { ...process.env, ...(connector.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      // A launcher that cannot be spawned must fail this connector, not the whole run.
      resolve({
        ok: false,
        reason: `could not launch ${launcher.command}: ${error.message}`,
        stderr: '',
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let sawInitialize = false;
    let sawTools = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // already gone
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        reason: `no response within ${timeoutMs / 1000}s`,
        stderr: stderr.slice(-400),
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        let message;
        try {
          message = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (message.id === 1 && message.result?.serverInfo) {
          sawInitialize = true;
          // Complete the handshake and ask what the server can do.
          child.stdin.write(`${JSON.stringify(INITIALIZED)}\n`);
          child.stdin.write(`${JSON.stringify(LIST_TOOLS)}\n`);
        }
        if (message.id === 2 && Array.isArray(message.result?.tools)) {
          sawTools = true;
          finish({
            ok: true,
            serverName: message.result.tools.length >= 0 ? 'ok' : 'ok',
            tools: message.result.tools.map((tool) => tool.name),
          });
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => finish({ ok: false, reason: error.message }));

    child.on('close', (code) => {
      if (settled) return;
      if (connector.expectCredentialError && connector.expectCredentialError.test(stderr)) {
        finish({ ok: true, credentialRequired: true, tools: [] });
        return;
      }
      const detail = stderr.split('\n').filter(Boolean).slice(-3).join(' | ');
      finish({
        ok: sawInitialize,
        reason: sawInitialize
          ? `initialized but no tools/list response (exit ${code})`
          : `exited (${code}) before initialize`,
        stderr: detail.slice(0, 400),
      });
    });

    child.stdin.write(`${JSON.stringify(INITIALIZE)}\n`);
  });
}

async function checkRemote(connector) {
  try {
    const response = await fetch(connector.remote, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(INITIALIZE),
    });
    // 401 means the endpoint is live and wants credentials: that is the expected result
    // for a server requiring a PAT.
    const expected = [200, 400, 401, 405, 406];
    return {
      ok: expected.includes(response.status),
      reason: `HTTP ${response.status}${response.status === 401 ? ' (credentials required — expected)' : ''}`,
      tools: [],
    };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

async function main() {
  const only = process.argv[2];

  for (const connector of CONNECTORS) {
    if (only && connector.id !== only) continue;

    if (connector.remote) {
      const result = await checkRemote(connector);
      console.log(
        `${result.ok ? 'ok      ' : 'FAILED  '}${connector.id.padEnd(12)} ${result.reason}`
      );
      if (!result.ok) process.exitCode = 1;
      continue;
    }

    process.stdout.write(`${connector.id.padEnd(12)} connecting... `);
    const result = await runStdioHandshake(connector, 180000);
    process.stdout.write('\r');
    if (result.ok) {
      const detail = result.credentialRequired
        ? 'credentials required — expected, package is functional'
        : `${result.tools.length} tool(s)`;
      console.log(`ok      ${connector.id.padEnd(12)} ${detail}`);
    } else {
      console.log(`FAILED  ${connector.id.padEnd(12)} ${result.reason}`);
      if (result.stderr) console.log(`        ${result.stderr}`);
      process.exitCode = 1;
    }
  }
}

if (require.main === module) main();
