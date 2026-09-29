import { _electron, test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Smoke test for the INSTALLED Windows build (spec requirement 7.2–7.4, workflow
 * .github/workflows/modelforge-windows-smoke.yml). Unlike tests/e2e/fixtures.ts, this does not
 * start `electron-forge` in dev mode: it launches the packaged `ModelForge.exe` produced by the
 * NSIS installer, with an isolated userData directory, so nothing leaks from the CI machine.
 *
 * The workflow sets MODELFORGE_EXE to the installed executable and MODELFORGE_STUB_PORT to a
 * loopback OpenAI-compatible stub it started, then runs this file:
 *
 *   playwright test tests/e2e/windows-installed-smoke.spec.ts
 */

const MODELFORGE_EXE = process.env.MODELFORGE_EXE ?? '';

test.describe('installed ModelForge', () => {
  test('first launch shows the main window within 30s', async () => {
    expect(MODELFORGE_EXE, 'MODELFORGE_EXE must point at the installed executable').toBeTruthy();

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelforge-smoke-userdata-'));
    const startedAt = Date.now();

    const app = await _electron.launch({
      executablePath: MODELFORGE_EXE,
      args: [`--user-data-dir=${userDataDir}`],
      env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    });

    try {
      // Requirement 7.2: the main window (or, once task 12 lands, the onboarding wizard) must
      // appear within 30s on a clean machine (no Rust/Node/global ACP adapter).
      const window = await app.firstWindow({ timeout: 30_000 });
      await window.waitForLoadState('domcontentloaded', { timeout: 30_000 });

      const root = window.locator('#root');
      await expect(root).not.toHaveCount(0, { timeout: 30_000 });

      const mainUi = window.locator('[data-testid="chat-input"]').first();
      await expect(mainUi).toBeVisible({ timeout: 30_000 });

      console.log(`first window ready in ${Date.now() - startedAt}ms`);
    } finally {
      await app.close().catch(() => {});
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  test('plain chat reaches the local OpenAI-compatible stub', async () => {
    const port = Number(process.env.MODELFORGE_STUB_PORT ?? 0);
    test.skip(port === 0, 'MODELFORGE_STUB_PORT not set; the stub is started by the workflow');

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelforge-smoke-userdata-'));
    const app = await _electron.launch({
      executablePath: MODELFORGE_EXE,
      args: [`--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        // The workflow configures the app to use the loopback stub as its provider.
        MODELFORGE_SMOKE_BASE_URL: `http://127.0.0.1:${port}/v1`,
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
    });

    try {
      const window = await app.firstWindow({ timeout: 30_000 });
      const chatInput = window.locator('[data-testid="chat-input"]');
      await expect(chatInput).toBeVisible({ timeout: 30_000 });
      await chatInput.click();
      await chatInput.fill('Reply with the smoke token.');
      await chatInput.press('Enter');
      // The kernel routes the request through the local OpenAI-compatible shim (src/utils/agentKernel.ts).
      await expect(window.getByText('MODELFORGE_WINDOWS_SMOKE_OK').first()).toBeVisible({
        timeout: 60_000,
      });
    } finally {
      await app.close().catch(() => {});
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});
