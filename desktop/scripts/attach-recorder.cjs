'use strict';
// 附着到用户自己启动的 Chrome（open-recorder-chrome.cmd），注入 B-12 演示录制器。
// 运行：node scripts/attach-recorder.cjs --out "%TEMP%\ops-recorder-steps"
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(path.resolve(__dirname, '..', '..', 'renderer', 'node_modules', '@playwright/test'));
const { RECORDER_SOURCE } = require('./observe-platform.cjs');

async function main() {
  const outArg = process.argv.indexOf('--out');
  const out = outArg >= 0 && process.argv[outArg + 1] ? path.resolve(process.argv[outArg + 1]) : path.join(require('node:os').tmpdir(), 'ops-recorder-steps');
  fs.mkdirSync(out, { recursive: true });
  const stopFile = path.join(out, 'stop.flag');
  try { fs.unlinkSync(stopFile); } catch {}
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  } catch (error) {
    throw new Error(`无法连接 127.0.0.1:9222；请先双击 desktop/scripts/open-recorder-chrome.cmd。${error.message}`);
  }
  const steps = [];
  const installed = new WeakSet();
  const inject = async (page) => {
    if (installed.has(page)) return;
    installed.add(page);
    await page.addInitScript(RECORDER_SOURCE).catch(() => undefined);
    await page.evaluate(RECORDER_SOURCE).catch(() => undefined);
  };
  const drain = async () => {
    for (const page of browser.contexts().flatMap((c) => c.pages())) {
      await inject(page);
      try {
        const batch = await page.evaluate(() => (window.__opsSteps || []).splice(0));
        if (Array.isArray(batch) && batch.length) {
          steps.push(...batch);
          fs.writeFileSync(path.join(out, 'steps-live.json'), JSON.stringify({ steps }, null, 2));
        }
      } catch {}
    }
  };
  await drain();
  console.log(JSON.stringify({ ready: true, out, stopFile, pages: browser.contexts().flatMap((c) => c.pages()).length }));
  while (!fs.existsSync(stopFile)) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await drain();
  }
  await drain();
  fs.writeFileSync(path.join(out, 'steps.json'), JSON.stringify({ steps }, null, 2));
  console.log(JSON.stringify({ done: true, out, steps: steps.length }));
  await browser.close().catch(() => undefined);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
