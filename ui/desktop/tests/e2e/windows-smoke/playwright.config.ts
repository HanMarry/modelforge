/**
 * Playwright configuration for the installed-app smoke specs (task 13.6). Used only by
 * .github/workflows/modelforge-windows-smoke.yml, which copies tests/e2e into a harness
 * directory outside the checkout and runs, for example:
 *
 *   npx playwright test -c tests/e2e/windows-smoke/playwright.config.ts windows-installed-smoke
 *
 * Each invocation writes its reports under MODELFORGE_SMOKE_RESULTS_DIR, so the workflow keeps
 * one report per scenario (primary, cn-user, upgrade, uninstall). The specs drive the app over
 * CDP (see harness.ts), so Playwright's own screenshot/trace options do not apply; the harness
 * attaches screenshots and app logs itself.
 */
import { defineConfig } from '@playwright/test';
import path from 'node:path';

const resultsDir =
  process.env.MODELFORGE_SMOKE_RESULTS_DIR ??
  path.join(__dirname, '..', '..', '..', 'test-results', 'windows-smoke');

export default defineConfig({
  testDir: '..',
  testMatch: /windows-installed-[a-z-]+\.spec\.ts$/,
  // Every test launches the packaged app at least once; the kernel and the stub add latency.
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  // One retry. The cn-user scenario has twice lost its worker to a native crash (0xC0000409) on
  // the last test, while the same test passes in the uninstall scenario, and a first-run prompt
  // that mounts late can cost an attempt. `summarize-results.cjs` reports such a test as flaky in
  // `summary.md`, so a retried failure is visible instead of being counted as clean.
  retries: 1,
  forbidOnly: true,
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(resultsDir, 'report.json') }],
    ['html', { outputFolder: path.join(resultsDir, 'html'), open: 'never' }],
  ],
  outputDir: path.join(resultsDir, 'artifacts'),
  preserveOutput: 'always',
  use: {
    actionTimeout: 30_000,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
