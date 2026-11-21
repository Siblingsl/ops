// D1 补测：AI 选题建议按钮在选题池页
import { _electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const BASE = 'http://127.0.0.1:5287';
const profile = await mkdtemp(join(tmpdir(), 'ops-wt2-r3d2-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: BASE }, timeout: 60_000,
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1580, height: 1000 });
await page.goto(`${BASE}/register`);
await page.getByLabel('用户名', { exact: true }).fill('r3d2' + Date.now().toString(36));
await page.getByLabel('密码（至少 12 位）').fill('{{SECRET_s2wbnk4v}}');
await page.getByRole('button', { name: '创建账号', exact: true }).click();
await page.waitForTimeout(900);
const account = await page.evaluate(async () => {
  const me = await (await fetch('/api/v1/auth/me')).json();
  await fetch('/api/v1/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: JSON.stringify({ name: 'R3D2号', platform: 'wechat_mp', content_format: 'long_article' }) });
  return (await (await fetch('/api/v1/accounts')).json())[0]?.id;
});
await page.goto(`${BASE}/a/${account}/topics`);
await page.waitForTimeout(1000);
let suggestReq = 0;
page.on('request', (rq) => { if (rq.url().includes('/topics/suggest') && rq.method() === 'POST') suggestReq++; });
const sugBtn = page.getByRole('button', { name: /AI 选题建议|生成建议/ }).first();
if (await sugBtn.isVisible().catch(() => false)) {
  for (let i = 0; i < 5; i++) { try { await sugBtn.click({ timeout: 400 }); } catch { break; } }
  await page.waitForTimeout(2500);
  console.log('D1 suggest rapid clicks:', suggestReq, suggestReq <= 2 ? 'OK(loading 禁点)' : 'DOUBLE-SUBMIT?');
  const btnDisabled = await sugBtn.isDisabled().catch(() => 'gone');
  console.log('post-click button state:', btnDisabled);
} else console.log('button not found on topics page');
await app.close();
process.exit(0);
