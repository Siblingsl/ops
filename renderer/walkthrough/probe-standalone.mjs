// 独立探针：不经 playwright config webServer，直接 _electron.launch
import { _electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const profile = await mkdtemp(join(tmpdir(), 'ops-probe-mcp-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: 'http://127.0.0.1:5287' }, timeout: 60_000,
});
const page = await app.firstWindow();
await page.goto('http://127.0.0.1:5287/settings/plugins');
await page.waitForTimeout(2500);
const keys = await page.evaluate(() => {
  const b = window.opsDesktopUI;
  if (!b) return { exists: false, ua: navigator.userAgent.slice(0, 80) };
  return { exists: true, methods: Object.keys(b).sort() };
});
console.log('BRIDGE:', JSON.stringify(keys));
await app.close();
process.exit(0);
