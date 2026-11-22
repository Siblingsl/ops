// R8-D：窗口最小尺寸约束（main.ts minWidth 960/minHeight 640）
import { _electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const BASE = 'http://127.0.0.1:5287';
const profile = await mkdtemp(join(tmpdir(), 'ops-r8d-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: BASE }, timeout: 60_000,
});
const page = await app.firstWindow();
// 尝试缩到 400x300（低于最小值）——Electron 应钳制到 960x640
await page.setViewportSize({ width: 400, height: 300 });
await page.waitForTimeout(600);
const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
console.log('min-size clamp:', JSON.stringify(size), size.w >= 940 ? 'OK(>=minWidth)' : 'CHECK');
// 恢复正常尺寸
await page.setViewportSize({ width: 1580, height: 1000 });
await page.waitForTimeout(400);
const size2 = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
console.log('restore:', JSON.stringify(size2));
await app.close();
process.exit(0);
