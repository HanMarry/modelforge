/**
 * Acceptance walkthrough driven over CDP against a running ModelForge instance.
 * Run the app with ENABLE_PLAYWRIGHT=1 PLAYWRIGHT_DEBUG_PORT=9222 first.
 *
 * Usage: node scripts/verify-workspace-ui.js
 */
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const DEBUG_PORT = process.env.PLAYWRIGHT_DEBUG_PORT || '9222';
const SHOT_DIR = path.join(__dirname, '..', 'test-results', 'verify');
const any = (patterns) => new RegExp(patterns.join('|'));

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  await page.waitForSelector('#root', { timeout: 60000 });
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await page.waitForTimeout(7000);

  // Click without Playwright's viewport/actionability gate: the hub column can extend past a
  // small Electron window, which made real clicks retry forever.
  // force: true skips the viewport/actionability gate but still sends real pointer events,
  // which radix menus require (they open on pointerdown).
  const rawClick = async (locator) => {
    await locator.click({ force: true, timeout: 15000 });
  };
  const rawFill = async (locator, value) => {
    await locator.fill(value, { force: true, timeout: 15000 });
  };

  const results = [];
  // Playwright's screenshot waits for the page to settle; the hub animates forever, so the
  // raw CDP capture is used instead.
  const cdp = await context.newCDPSession(page);
  const shot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), Buffer.from(data, 'base64'));
    results.push(`captured ${name}`);
  };
  const check = async (label, fn) => {
    try {
      const value = await fn();
      results.push(`${value ? 'PASS' : 'FAIL'}  ${label}`);
      return value;
    } catch (error) {
      results.push(`FAIL  ${label} — ${error.message.split('\n')[0]}`);
      return false;
    }
  };

  await shot('01-hub');

  // 1. Hub workflow dropdown
  const workflowTrigger = page.locator('button').filter({ hasText: any(['自由对话', 'Free chat']) }).first();
  await check('workflow dropdown trigger visible', async () => workflowTrigger.isVisible());
  await rawClick(workflowTrigger);
  await page.waitForTimeout(900);
  await shot('02-workflow-menu');
  const workflowItems = await page.locator('[role="menuitem"]').count();
  results.push(`INFO  workflow menu items = ${workflowItems}`);
  const reviewItem = page.locator('[role="menuitem"]').filter({ hasText: any(['评审', 'Review']) }).first();
  await check('review workflow item present', async () => reviewItem.isVisible());
  await rawClick(reviewItem);
  await page.waitForTimeout(1200);
  await shot('03-workflow-selected');
  await check(
    'workflow selection reflected in trigger',
    async () => (await page.locator('button').filter({ hasText: '评审' }).count()) > 0
  );

  // 2. Hub contest dropdown
  const contestTrigger = page.locator('button').filter({ hasText: any(['赛事', 'Contest']) }).first();
  await rawClick(contestTrigger);
  await page.waitForTimeout(900);
  const contestItems = await page.locator('[role="menuitem"]').count();
  results.push(`INFO  contest menu items = ${contestItems}`);
  await shot('04-contest-menu');
  await check(
    'contest list has 华中杯 and 新建自定义模板',
    async () =>
      (await page.locator('[role="menuitem"]').filter({ hasText: '华中杯' }).count()) > 0 &&
      (await page.locator('[role="menuitem"]').filter({ hasText: '新建自定义模板' }).count()) > 0
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // 3. Editor view
  const editorButton = page.locator('button').filter({ hasText: any(['编辑器视图', 'Editor view']) }).first();
  await check('editor view button visible', async () => editorButton.isVisible());
  await rawClick(editorButton);
  await page.waitForTimeout(3000);
  await shot('05-editor-view');
  await check(
    'editor empty state shown',
    async () => (await page.getByText(any(['打开文件', 'Open a file'])).count()) > 0
  );

  // 4. File search + code preview (palette check)
  const searchInput = page.locator('input[placeholder]').first();
  const hasSearch = await check('file search input visible', async () => searchInput.isVisible());
  if (hasSearch) {
    await rawFill(searchInput, 'fig_roadmap');
    await page.waitForTimeout(3000);
    await shot('06-file-search');
    const result = page.locator('button').filter({ hasText: 'fig_roadmap' }).first();
    if ((await result.count()) > 0) {
      await rawClick(result);
      await page.waitForTimeout(4500);
      await shot('07-code-preview');
      const preCount = await page.locator('pre').count();
      const spanCount = await page.locator('pre span').count();
      results.push(`INFO  preview <pre> = ${preCount}, highlighted spans = ${spanCount}`);
      const bg = await page
        .locator('pre')
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor)
        .catch(() => 'n/a');
      results.push(`INFO  code block background = ${bg}`);
    } else {
      results.push('INFO  no search hit for fig_roadmap');
    }
  }

  fs.writeFileSync(path.join(SHOT_DIR, 'report.txt'), results.join('\n'));
  console.log(results.join('\n'));
  await browser.close().catch(() => {});
}

main().catch((error) => {
  console.error('verify failed:', error);
  process.exit(1);
});
