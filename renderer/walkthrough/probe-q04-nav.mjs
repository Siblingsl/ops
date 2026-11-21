// Q-04 探针：native.goto('/works/:id/check') 后页面落在哪
import { _electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BASE='http://127.0.0.1:5287';
const profile = await mkdtemp(join(tmpdir(), 'ops-probe-q04-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: BASE }, timeout: 60_000,
});
const page = await app.firstWindow();
await page.goto(`${BASE}/register`);
await page.getByLabel('用户名', { exact: true }).fill('q04probe'+Date.now());
await page.getByLabel('密码（至少 12 位）').fill('{{SECRET_g8qmvk3p}}');
await page.getByRole('button', { name: '创建账号', exact: true }).click();
await page.waitForTimeout(1200);
await page.evaluate(async () => { const me=await (await fetch('/api/v1/auth/me')).json(); const r=await fetch('/api/v1/accounts',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':me.csrf_token},body:JSON.stringify({name:'Q04XHS号',platform:"xhs",content_format:"image_note"})}); });
const me = await page.evaluate(async () => await (await fetch('/api/v1/auth/me')).json());
const accs = await page.evaluate(async () => await (await fetch('/api/v1/accounts')).json());
console.log("ACCOUNTS-RAW:", JSON.stringify(accs).slice(0,200));
const acc = Array.isArray(accs)?accs[0]:accs.accounts?.[0];
console.log('account:', acc?.id);
// 直接 API 建作品（long_article 走图文检查页）
const w = await page.evaluate(async (aid) => {
  console.log('create payload ok');
  const me2 = await (await fetch('/api/v1/auth/me')).json();
  const r = await fetch(`/api/v1/accounts/${aid}/works`, { method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':me2.csrf_token}, body: JSON.stringify({title:'Q04探针作品', content_format:'image_note'}) });
  return await r.json();
}, acc.id);
console.log('work:', w?.id, JSON.stringify(w).slice(0,200));
await page.goto(`${BASE}/works/${w.id}/check`);
await page.waitForTimeout(3500);
const loc = await page.evaluate(() => ({ path: location.pathname, h1: document.querySelector('h1')?.textContent?.slice(0,30) ?? null }));
console.log('AFTER-GOTO:', JSON.stringify(loc));
await app.close();
process.exit(0);
