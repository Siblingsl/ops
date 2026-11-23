'use strict';
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(path.resolve(__dirname, '..', '..', 'renderer', 'node_modules', '@playwright/test'));
const { RECORDER_SOURCE } = require('./observe-platform.cjs');

(async () => {
  const profileDir = path.join(os.tmpdir(), 'ops-observe-profile');
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled', '--no-first-run']
  });
  const page = await context.newPage();
  await page.addInitScript(RECORDER_SOURCE);
  await page.goto('https://creator.xiaohongshu.com/new/home', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined);
  await page.waitForTimeout(2000);
  const target = page.getByText('笔记管理', { exact: true }).first();
  const count = await target.count();
  let clicked = false;
  if (count > 0) {
    await target.click({ timeout: 15000 }).then(() => { clicked = true; }).catch(() => undefined);
  }
  await page.waitForTimeout(2500);
  const steps = await page.evaluate(() => (window.__opsSteps || []).splice(0));
  console.log(JSON.stringify({ clicked, targetCount: count, steps }, null, 2));
  await context.close();
})();
