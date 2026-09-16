import { test as base, Page, Browser, chromium } from '@playwright/test';
import { exec, spawn, ChildProcess } from 'child_process';
import { createServer } from 'net';
import { join } from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Kills forge/electron processes from this checkout that a previous run left behind.
 * The npx -> pnpm -> forge chain can outlive the shell pid that spawn() reports, so a
 * plain `taskkill /T` on it is not enough; without this sweep a stale instance keeps the
 * debug port and the next run silently attaches to it (or fails to open DevTools).
 */
async function sweepStaleAppProcesses(): Promise<void> {
  if (process.platform !== 'win32') {
    return;
  }
  const script =
    "$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'goose.*electron-forge' -or $_.CommandLine -match 'goose.*electron\\\\dist' }; " +
    '$procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
  // EncodedCommand sidesteps cmd/powershell quoting pitfalls (the checkout path is non-ASCII).
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  await execAsync(`powershell -NoProfile -EncodedCommand ${encoded}`, { timeout: 30_000 }).catch(
    () => {}
  );
}

/** Picks a currently free loopback port; fixed ports collide with other local tooling. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

type GooseTestFixtures = {
  goosePage: Page;
};

/**
 * Test-scoped fixture that launches a fresh Electron app for EACH test.
 *
 * Isolation: ⚠️ Partial - each test gets a fresh app instance, but uses ambient user config
 * Speed: ⚠️ Slow - ~3s startup overhead per test
 *
 * This ensures each test starts with a fresh app instance, but the app uses the
 * user's existing Goose configuration (providers, models, etc.).
 *
 * Usage:
 *   import { test, expect } from './fixtures';
 *
 *   test('my test', async ({ goosePage }) => {
 *     await goosePage.waitForSelector('[data-testid="chat-input"]');
 *     // ... test code
 *   });
 */
export const test = base.extend<GooseTestFixtures>({
  // Test-scoped fixture: launches a fresh Electron app for each test
  goosePage: async ({ browserName }, providePage, testInfo) => {
    void browserName;
    console.log(`Launching fresh Electron app for test: ${testInfo.title}`);

    let appProcess: ChildProcess | null = null;
    let browser: Browser | null = null;

    try {
      // A fresh free port per test: fixed ports (9222, 9333, ...) are taken by other local
      // tooling on some developer machines, which makes the CDP dial attach to the wrong
      // service or fail outright.
      const debugPort = await getFreePort();
      console.log(`Using debug port ${debugPort} for parallel test execution`);

      // Start from a clean slate: a stale instance would hold the debug port and the CDP
      // connection below would attach to it instead of the freshly launched app.
      await sweepStaleAppProcesses();

      // Start the electron-forge process with Playwright remote debugging enabled.
      // Use detached mode on Unix to create a process group we can kill together.
      // pnpm >= 10.30 is required by engines and only guaranteed through npx (same pattern
      // as start-modelforge.ps1); Windows needs a shell for the npx.cmd shim.
      appProcess = spawn('npx', ['--yes', 'pnpm@10.30.0', 'exec', 'electron-forge', 'start'], {
        cwd: join(__dirname, '../..'),
        // 'ignore' avoids pipe-buffer stalls when debug logging is off
        stdio: process.env.DEBUG_TESTS ? 'pipe' : 'ignore',
        detached: process.platform !== 'win32',
        shell: process.platform === 'win32',
        env: {
          ...process.env,
          ELECTRON_IS_DEV: '1',
          NODE_ENV: 'development',
          GOOSE_ALLOWLIST_BYPASS: 'true',
          ENABLE_PLAYWRIGHT: 'true',
          PLAYWRIGHT_DEBUG_PORT: debugPort.toString(), // Unique port per test for parallel execution
          RUST_LOG: 'info', // Enable info-level logging for goosed backend
          // Dev builds look for a self-compiled kernel (repo paths hold non-ASCII characters
          // here, so the build lives outside the tree — same setup as start-modelforge.ps1).
          // Without it `goose serve` fails and the app comes up half-broken.
          GOOSE_BINARY: process.env.GOOSE_BINARY ?? 'E:\\goose-build\\target\\debug\\goose.exe',
          GOOSE_TELEMETRY_OFF: '1',
          // Keep loopback traffic off any system proxy (a proxied CDP dial gets a 502).
          NO_PROXY: '127.0.0.1,localhost',
          no_proxy: '127.0.0.1,localhost',
        }
      });

      // Log process output for debugging
      if (process.env.DEBUG_TESTS) {
        appProcess.stdout?.on('data', (data) => {
          console.log('App stdout:', data.toString());
        });

        appProcess.stderr?.on('data', (data) => {
          console.log('App stderr:', data.toString());
        });
      }

      // Wait for the app to start and remote debugging to be available
      // Retry connection until it succeeds (app is ready) or timeout
      console.log(`Waiting for Electron app to start on port ${debugPort}...`);
      const maxRetries = 180; // 180 retries * 1s = 3 minutes max (forge start can be slow)
      const retryDelay = 1000; // 1s between retries

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
          console.log(`Connected to Electron app on attempt ${attempt} (~${(attempt * retryDelay) / 1000}s)`);
          break;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (attempt === maxRetries) {
            throw new Error(
              `Failed to connect to Electron app after ${maxRetries} attempts (${(maxRetries * retryDelay) / 1000}s). Last error: ${errorMessage}`,
              { cause: error }
            );
          }
          // Wait before next retry
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }

      if (!browser) {
        throw new Error('Browser connection failed unexpectedly');
      }

      // Wait for Electron to create its first window after the CDP endpoint is up.
      let page: Page | null = null;
      for (let attempt = 1; attempt <= 100; attempt++) {
        const contexts = browser.contexts();
        page = contexts.flatMap((context) => context.pages())[0] ?? null;
        if (page) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      if (!page) {
        throw new Error('No windows/pages found');
      }

      // Wait for page to be ready
      await page.waitForLoadState('domcontentloaded');

      // Try to wait for networkidle
      try {
        await page.waitForLoadState('networkidle', { timeout: 10000 });
      } catch {
        console.log('NetworkIdle timeout (likely due to MCP activity), continuing...');
      }

      // Wait for React app to be ready
      await page.waitForFunction(() => {
        const root = document.getElementById('root');
        return root && root.children.length > 0;
      }, { timeout: 30000 });

      console.log('App ready, starting test...');

      // Provide the page to the test
      await providePage(page);

    } finally {
      console.log('Cleaning up Electron app for this test...');

      // Close the CDP connection
      if (browser) {
        await browser.close().catch(console.error);
      }

      // Kill the npm process tree
      if (appProcess && appProcess.pid) {
        try {
          if (process.platform === 'win32') {
            // On Windows, kill the entire process tree
            await execAsync(`taskkill /F /T /PID ${appProcess.pid}`);
          } else {
            // On Unix, kill the entire process group
            try {
              // First try SIGTERM for graceful shutdown
              process.kill(-appProcess.pid, 'SIGTERM');
              await new Promise(resolve => setTimeout(resolve, 2000));
            } catch {
              // Process might already be dead
            }
            // Then SIGKILL if still running
            try {
              process.kill(-appProcess.pid, 'SIGKILL');
            } catch {
              // Process already exited
            }
          }
          console.log('Cleaned up app process');
        } catch (error) {
          if (
            error instanceof Error &&
            !('code' in error && error.code === 'ESRCH') &&
            !error.message.includes('No such process')
          ) {
            console.error('Error killing app process:', error);
          }
        }
      }

      // The taskkill above can miss the forge/electron tree when the shell pid is gone, and a
      // still-booting chain can spawn children after the kill. Let it settle, then sweep.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await sweepStaleAppProcesses();
    }
  },
});

export { expect } from '@playwright/test';
