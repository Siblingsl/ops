'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { chromium } = require(path.resolve(__dirname, '..', '..', 'renderer', 'node_modules', '@playwright/test'));

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const pages = browser.contexts().flatMap((c) => c.pages());
  for (const page of pages) {
    console.log('URL', page.url());
    console.log('TITLE', await page.title().catch(() => ''));
    const text = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    console.log('TEXT', String(text).slice(0, 800).replace(/\n+/g, ' | '));
  }
  await browser.close().catch(() => undefined);
})();
