const BASE = 'http://127.0.0.1:5287';
import { _electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const profile = await mkdtemp(join(tmpdir(), 'ops-r8dbg-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: BASE }, timeout: 60_000,
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1580, height: 1000 });
await page.goto(BASE + '/register');
await page.getByLabel('用户名', { exact: true }).fill('r8dbg' + Date.now().toString(36));
await page.getByLabel('密码（至少 12 位）').fill('{{SECRET_s2wbnk4v}}');
await page.getByRole('button', { name: '创建账号', exact: true }).click();
await page.waitForFunction(async () => { const r = await fetch('/api/v1/auth/me'); return r.ok; }, { timeout: 15000 });
await page.waitForFunction(async () => { const r = await fetch('/api/v1/auth/me'); return r.ok; }, { timeout: 15000 });
const me = await page.evaluate(async () => {
  const r = await fetch('/api/v1/auth/me'); return await r.json();
});
const acc = await (await page.request.post(`/api/v1/accounts`, { headers: { 'X-CSRF-Token': me.csrf_token }, data: { name: 'DBG号', platform: 'wechat_mp', content_format: 'long_article' } })).json();
await page.goto(`${BASE}/a/${acc.id}/works`);
await page.waitForTimeout(2000);
console.log('URL:', page.url());
console.log('H1:', await page.evaluate(() => document.querySelector('h1')?.textContent ?? 'none'));
console.log('body len:', (await page.evaluate(() => document.body.innerText.length)));
console.log('body head:', (await page.evaluate(() => document.body.innerText.slice(0, 200))).replace(/\n/g, '|'));
await app.close();
process.exit(0);
