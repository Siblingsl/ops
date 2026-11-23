'use strict';
const path = require('node:path');
const { chromium } = require(path.resolve(__dirname, '..', '..', 'renderer', 'node_modules', '@playwright', 'test'));
const { RECORDER_SOURCE } = require('./observe-platform.cjs');

(async () => {
  const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const page = await browser.newPage();
  await page.addInitScript(RECORDER_SOURCE);
  await page.goto('data:text/html,<button id="x">hello</button><input id="i" />');
  await page.click('#x');
  await page.fill('#i', 'abc');
  const steps = await page.evaluate(() => window.__opsSteps);
  console.log(JSON.stringify(steps, null, 2));
  await browser.close();
})();
