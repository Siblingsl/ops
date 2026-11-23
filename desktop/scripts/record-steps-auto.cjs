'use strict';
// 在真实登录页面上触发少量导航点击，产出 B-12 演示录制步骤。
// 说明：当前环境 Playwright 启动的 Chrome 窗口在另一个桌面，用户看不到；
// 本脚本用 CDP 在真实页面点击，用于验证录制器选择器/事件链，不冒充人工点击。
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { chromium } = require(path.resolve(__dirname, '..', '..', 'renderer', 'node_modules', '@playwright/test'));
const { RECORDER_SOURCE } = require('./observe-platform.cjs');

(async () => {
  const out = path.join(os.tmpdir(), `ops-recorder-steps-${Date.now()}`);
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const steps = [];
  const pages = browser.contexts().flatMap((c) => c.pages());
  const drain = async () => {
    for (const page of pages) {
      try {
        const batch = await page.evaluate(() => (window.__opsSteps || []).splice(0));
        if (Array.isArray(batch) && batch.length) {
          steps.push(...batch);
          fs.writeFileSync(path.join(out, 'steps-live.json'), JSON.stringify({ steps }, null, 2));
        }
      } catch {}
    }
  };
  for (const page of pages) {
    await page.addInitScript(RECORDER_SOURCE).catch(() => undefined);
    await page.evaluate(RECORDER_SOURCE).catch(() => undefined);
  }
  await drain();
  const clickText = async (page, label) => {
    const target = page.getByText(label, { exact: true }).first();
    if (await target.count() === 0) return false;
    await target.click({ timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout(1800);
    await drain();
    return true;
  };
  const xhs = pages.find((p) => p.url().includes('creator.xiaohongshu.com'));
  const wx = pages.find((p) => p.url().includes('mp.weixin.qq.com'));
  const clicked = [];
  if (xhs) {
    clicked.push(['xhs:笔记管理', await clickText(xhs, '笔记管理')]);
    clicked.push(['xhs:数据看板', await clickText(xhs, '数据看板')]);
  }
  if (wx) {
    clicked.push(['wechat:发表记录', await clickText(wx, '发表记录')]);
    clicked.push(['wechat:数据分析', await clickText(wx, '数据分析')]);
  }
  await drain();
  fs.writeFileSync(path.join(out, 'steps.json'), JSON.stringify({ steps, clicked, operator: 'cdp-automated-real-page' }, null, 2));
  console.log(JSON.stringify({ out, steps: steps.length, clicked }));
  await browser.close().catch(() => undefined);
})();
