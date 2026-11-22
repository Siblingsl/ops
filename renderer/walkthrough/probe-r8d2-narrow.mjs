// 400px 视口下内容横向溢出检查
import { _electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const BASE = 'http://127.0.0.1:5287';
const profile = await mkdtemp(join(tmpdir(), 'ops-r8d2-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: BASE }, timeout: 60_000,
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 400, height: 800 });
await page.goto(BASE + '/register');
await page.waitForTimeout(1200);
const overflow = await page.evaluate(() => ({
  overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  hasHorizontalBar: document.documentElement.scrollWidth > document.documentElement.clientWidth,
}));
console.log('400px overflow:', JSON.stringify(overflow));
await page.setViewportSize({ width: 700, height: 800 });
await page.waitForTimeout(500);
const o2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
console.log('700px overflow:', o2);
await app.close();
process.exit(0);
