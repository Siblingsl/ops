// R8-B：客户端状态合理性——localStorage 键空间/多账号隔离/深链路由
import { _electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const BASE = 'http://127.0.0.1:5287';
const profile = await mkdtemp(join(tmpdir(), 'ops-r8b-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: BASE }, timeout: 60_000,
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1580, height: 1000 });
const F=[];
const rec=(id,ok,detail)=>{F.push({id,ok});console.log(`${ok?'ok ':'FAIL'} ${id} :: ${detail}`);};
await page.goto(BASE + '/register');
await page.getByLabel('用户名', { exact: true }).fill('r8b' + Date.now().toString(36));
await page.getByLabel('密码（至少 12 位）').fill('{{SECRET_s2wbnk4v}}');
await page.getByRole('button', { name: '创建账号', exact: true }).click();
await page.waitForTimeout(2000);
// B1 localStorage 键空间抽查（不应有敏感明文）
const keys = await page.evaluate(() => Object.keys(localStorage));
const sensKeys = keys.filter(k => /token|secret|password|apikey/i.test(k) && !/has|seen|flag/i.test(k));
rec('B1-no-sensitive-keys',sensKeys.length===0,`keys=${keys.length} sensitive=${sensKeys.join(',')||'none'}`);
const vals = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)?.slice(0, 60)])));
const sensVals = Object.entries(vals).filter(([k,v]) => v && /sk-[A-Za-z0-9]{20,}|{{SECRET_/.test(v));
rec('B1-no-sensitive-values',sensVals.length===0,`leaks=${sensVals.map(([k])=>k).join(',')||'none'}`);
// B2 深链路由：/a/:id/works 直接打开（已登录态）
const me = await page.evaluate(async () => await (await fetch('/api/v1/auth/me')).json());
const accId = await page.evaluate(async () => { const me = await (await fetch('/api/v1/auth/me')).json(); const h = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }; const acc = await (await fetch('/api/v1/accounts', { method: 'POST', headers: h, body: JSON.stringify({ name: 'R8B号', platform: 'wechat_mp', content_format: 'long_article' }) })).json(); return acc.id; });
await page.goto(`${BASE}/a/${accId}/works`);
await page.waitForTimeout(1500);
const urlOk = page.url().includes('/works');
const h1 = await page.evaluate(() => document.querySelector('h1,h2')?.textContent?.slice(0,20) ?? 'none');
rec('B2-deep-link-works',urlOk&&h1!=='none',`url=${urlOk} h1=${h1}`);
// 深链 /agent
await page.goto(`${BASE}/agent`);
await page.waitForTimeout(1500);
const agentH = await page.evaluate(() => document.querySelector('h1,h2')?.textContent?.slice(0,20) ?? 'none');
rec('B2-deep-link-agent',agentH!=='none',`h=${agentH}`);
// B3 未登录深链 → 跳登录
await page.evaluate(async () => { const me = await (await fetch('/api/v1/auth/me')).json(); await fetch('/api/v1/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': me.csrf_token } }); localStorage.clear(); });
await page.goto(`${BASE}/a/${accId}/works`);
await page.waitForTimeout(1500);
const redirected = page.url().includes('/login');
rec('B3-logged-out-deep-link-redirect',redirected,`url=${page.url().slice(0,50)}`);
console.log(`\nR8B ${F.filter(x=>x.ok).length}/${F.length} pass`);
await app.close();
process.exit(0);
