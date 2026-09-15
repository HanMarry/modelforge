const { chromium } = require('@playwright/test');

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  await page.waitForSelector('#root', { timeout: 60000 });

  const before = await page.evaluate(() => ({
    hash: window.location.hash,
    ids: Array.from(document.querySelectorAll('[id]')).map((el) => el.id).slice(0, 60),
  }));
  console.log('before:', JSON.stringify(before, null, 1));

  await page.evaluate(() => {
    window.location.hash = '#/settings';
  });
  await page.waitForTimeout(4000);
  const after = await page.evaluate(() => {
    const root = document.getElementById('root');
    const text = root ? root.innerText : '';
    return {
      hash: window.location.hash,
      ids: Array.from(document.querySelectorAll('[id]')).map((el) => el.id).slice(0, 80),
      hasAgentKernelText: text.includes('智能体内核') || text.includes('Agent Kernel'),
      hasTelemetryText: text.includes('遥测') || text.includes('telemetry'),
      tabs: Array.from(document.querySelectorAll('button, [role="tab"]'))
        .map((el) => el.innerText.trim())
        .filter((t) => t && t.length < 12)
        .slice(0, 40),
    };
  });
  console.log('after:', JSON.stringify(after, null, 1));
  await browser.close().catch(() => {});
}

main().catch((error) => {
  console.error('diagnose failed:', error);
  process.exit(1);
});
