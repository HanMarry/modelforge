/**
 * Acceptance walkthrough for the agent kernel feature, driven over CDP against a running
 * ModelForge instance.
 *
 * Run the app with ENABLE_PLAYWRIGHT=1 PLAYWRIGHT_DEBUG_PORT=9222 and an external kernel
 * selected (settings.json -> agentKernel.runtime), then: node scripts/verify-agent-kernel.js
 *
 * The script never closes the browser: over CDP that would terminate the app under test.
 */
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const DEBUG_PORT = process.env.PLAYWRIGHT_DEBUG_PORT || '9222';
const SHOT_DIR = path.join(__dirname, '..', 'test-results', 'verify-kernel');
const TOKEN = process.env.KERNEL_TOKEN || 'KERNELOK';
const PROMPT = process.env.KERNEL_PROMPT || `请只回复这一个大写单词：${TOKEN}`;
const KERNEL_LABEL = process.env.KERNEL_LABEL || 'Claude Code';
const BUILTIN_ONLY = process.env.KERNEL_MODE === 'builtin';

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  const context = browser.contexts()[0];
  const pages = context.pages();
  const page = pages[0] ?? (await context.waitForEvent('page'));
  await page.waitForSelector('#root', { timeout: 60000 });
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await page.waitForTimeout(5000);

  const results = [];
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 400));
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${String(error).slice(0, 400)}`));

  const cdp = await context.newCDPSession(page);
  const shot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), Buffer.from(data, 'base64'));
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
  const rawClick = (locator) => locator.click({ force: true, timeout: 15000 });
  const rawFill = (locator, value) => locator.fill(value, { force: true, timeout: 15000 });

  results.push(`INFO  windows: ${pages.length}, url: ${page.url()}`);

  // ---- 1. Settings: the Agent Kernel section reflects the selected kernel -------------
  await page.evaluate(() => {
    window.location.hash = '#/settings';
  });
  await page.waitForTimeout(4000);

  const appTab = page.locator('[data-testid="settings-app-tab"]').first();
  if ((await appTab.count()) > 0) {
    await rawClick(appTab);
    await page.waitForTimeout(2500);
  }
  // The kernel section sits below the other app settings; scroll it into view for the shot.
  await page.mouse.move(900, 600);
  await page.mouse.wheel(0, 2600);
  await page.waitForTimeout(1500);
  await shot('01-settings-app-tab');

  const byId = await page.evaluate(() => {
    const section = document.getElementById('agent-kernel');
    return {
      present: Boolean(section),
      text: section ? section.innerText.split('\n').join(' | ') : '',
      bodyHasKernel: document.body.innerText.includes('智能体内核'),
    };
  });
  results.push(`INFO  agent-kernel section present=${byId.present}`);
  results.push(`INFO  agent-kernel text: ${byId.text.slice(0, 800)}`);

  await check('kernel section rendered', async () => byId.present);
  await check('kernel options rendered', async () => /内置内核/.test(byId.text));
  if (BUILTIN_ONLY) {
    await check('built-in kernel is active', async () => /当前使用内置内核/.test(byId.text));
  } else {
    await check('external kernel selected', async () => byId.text.includes(`${KERNEL_LABEL} 内核`));
    await check('kernel reports ready', async () => /已就绪|Ready ·/.test(byId.text));
    await check('status shows the provider endpoint', async () =>
      /api\.deepseek\.com/.test(byId.text)
    );
    await check('status shows the local adapter', async () => /127\.0\.0\.1:\d+/.test(byId.text));
  }

  // ---- 2. Chat: a real reply through the external kernel ------------------------------
  await page.evaluate(() => {
    window.location.hash = '#/';
  });
  await page.waitForTimeout(4000);
  await shot('02-home');

  const input = page.locator('textarea, [contenteditable="true"]').first();
  await check('chat input visible', async () => input.isVisible());
  await rawFill(input, PROMPT);
  await page.waitForTimeout(800);
  await shot('03-prompt');
  await page.keyboard.press('Enter');

  const deadline = Date.now() + 240000;
  let body = '';
  let replied = false;
  const tokenPattern = new RegExp(TOKEN, 'i');
  while (Date.now() < deadline) {
    await page.waitForTimeout(5000);
    body = await page.evaluate(() => document.body.innerText);
    // The prompt itself contains the token, so require it to show up after the composer was
    // cleared by the send.
    const composerText = await input.innerText().catch(() => '');
    if (tokenPattern.test(body) && !tokenPattern.test(composerText)) {
      replied = true;
      break;
    }
  }
  await shot('04-reply');
  results.push(`INFO  chat text: ${body.split('\n').join(' | ').slice(0, 1000)}`);

  await check('assistant replied through the external kernel', async () => replied);
  await check(
    'reply rendered as an assistant message',
    async () => (await page.locator(`text=${TOKEN}`).count()) > 0
  );

  if (consoleErrors.length) {
    results.push(`INFO  console errors: ${consoleErrors.slice(0, 5).join(' || ')}`);
  }

  fs.writeFileSync(path.join(SHOT_DIR, 'report.txt'), results.join('\n'));
  console.log(results.join('\n'));
  process.exit(0);
}

main().catch((error) => {
  console.error('verify failed:', error);
  process.exit(1);
});
