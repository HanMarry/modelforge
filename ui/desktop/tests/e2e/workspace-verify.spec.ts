import { test, expect } from './fixtures';
import { mkdirSync } from 'fs';
import { join } from 'path';

/**
 * Acceptance walkthrough for the workspace surfaces: hub dropdowns, editor view,
 * file search + preview. Screenshots land in test-results/verify/ so the run can be
 * inspected by eye instead of trusted from logs alone.
 */
test.setTimeout(240000);

const SHOT_DIR = join(__dirname, '..', '..', 'test-results', 'verify');

test('workspace surfaces are usable end to end', async ({ goosePage: page }) => {
  mkdirSync(SHOT_DIR, { recursive: true });
  const shot = async (name: string) => {
    await page.screenshot({ path: join(SHOT_DIR, `${name}.png`) });
    console.log(`[verify] captured ${name}`);
  };
  const any = (patterns: string[]) => new RegExp(patterns.join('|'));

  await page.waitForSelector('#root', { timeout: 30000 });
  await page.waitForTimeout(6000);
  await shot('01-hub');

  const workflowTrigger = page
    .locator('button')
    .filter({ hasText: any(['自由对话', 'Free chat']) })
    .first();
  await expect(workflowTrigger).toBeVisible({ timeout: 30000 });
  await workflowTrigger.click();
  await page.waitForTimeout(800);
  await shot('02-workflow-menu');
  console.log(`[verify] workflow menu items: ${await page.locator('[role="menuitem"]').count()}`);

  const reviewItem = page
    .locator('[role="menuitem"]')
    .filter({ hasText: any(['评审', 'Review']) });
  await expect(reviewItem.first()).toBeVisible({ timeout: 10000 });
  await reviewItem.first().click();
  await page.waitForTimeout(1200);
  await shot('03-workflow-selected');

  const contestTrigger = page
    .locator('button')
    .filter({ hasText: any(['赛事', 'Contest']) })
    .first();
  await contestTrigger.click();
  await page.waitForTimeout(800);
  console.log(`[verify] contest menu items: ${await page.locator('[role="menuitem"]').count()}`);
  await shot('04-contest-menu');
  const customItem = page
    .locator('[role="menuitem"]')
    .filter({ hasText: any(['新建自定义模板']) });
  console.log(`[verify] custom template entries: ${await customItem.count()}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  const editorButton = page
    .locator('button')
    .filter({ hasText: any(['编辑器视图', 'Editor view']) })
    .first();
  await expect(editorButton).toBeVisible({ timeout: 15000 });
  await editorButton.click();
  await page.waitForTimeout(2500);
  await shot('05-editor-view');

  const emptyState = page.getByText(any(['打开文件', 'Open a file'])).first();
  await expect(emptyState).toBeVisible({ timeout: 15000 });
  console.log('[verify] editor empty state visible');

  const searchInput = page.locator('input[placeholder]').first();
  await searchInput.fill('fig_roadmap');
  await page.waitForTimeout(2500);
  await shot('06-file-search');

  const result = page.locator('button').filter({ hasText: 'fig_roadmap' }).first();
  if (await result.count()) {
    await result.click();
    await page.waitForTimeout(4000);
    await shot('07-code-preview');
    console.log(`[verify] preview nodes: ${await page.locator('pre, code').count()}`);
  } else {
    console.log('[verify] no search hit for fig_roadmap');
  }

  const panelTabs = await page
    .locator('button')
    .filter({ hasText: any(['版本', 'Versions']) })
    .count();
  console.log(`[verify] versions tab buttons visible: ${panelTabs}`);
});
