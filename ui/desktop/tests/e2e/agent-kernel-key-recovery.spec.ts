/**
 * P0-1 end-to-end replay: saving a key must start the kernel right away, without an app
 * restart. This replays the exact local failure (external kernel selected, goose holds the
 * provider key in the credential store, no in-app copy yet) and then restores that state by
 * forgetting the test copy.
 *
 * The key used here is a placeholder; provisioning only starts the local loopback shim.
 */
import { test, expect } from './fixtures';

// App startup (pnpm bootstrap + forge + vite) easily exceeds the default 60s on this machine;
// the fixture waits up to 3 minutes for the debug port on top of that.
test.setTimeout(420_000);

test('agent kernel starts as soon as a key is saved, no restart (P0-1)', async ({ goosePage }) => {
  const page = goosePage;

  await page.waitForSelector('[data-testid="sidebar-settings-button"]', { timeout: 60000 });
  await page.click('[data-testid="sidebar-settings-button"]');
  await page.waitForSelector('[data-testid="settings-app-tab"]', { timeout: 30000 });
  await page.click('[data-testid="settings-app-tab"]');
  await page.waitForSelector('#agent-kernel', { timeout: 30000 });

  const panel = page.locator('#agent-kernel');
  await panel.scrollIntoViewIfNeeded();

  // 1) The failure state: external kernel selected, key missing, actionable hint shown.
  await expect(panel.getByText(/缺少 API Key/).first()).toBeVisible({ timeout: 20000 });
  await expect(panel.getByText(/独立副本|its own copy/).first()).toBeVisible();

  // 2) Save a key — the kernel must become Ready within this session (no restart).
  const placeholderKey = 'sk-e2e-recovery-placeholder';
  await panel.locator('input[type="password"]').fill(placeholderKey);
  await panel.getByRole('button', { name: /^保存密钥$|^Save key$/ }).click();

  await expect(panel.getByText(/127\.0\.0\.1/).first()).toBeVisible({ timeout: 60000 });
  await expect(panel.getByText(/缺少 API Key/)).toHaveCount(0);

  // 3) Restore the original state: drop the test copy captured for the kernel.
  await panel.getByRole('button', { name: /^删除已保存密钥$|^Forget saved key$/ }).click();
  await expect(panel.getByText(/未设置|not set/).first()).toBeVisible({ timeout: 20000 });
});
