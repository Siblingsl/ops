// 精简复刻：native 登录 → dump 状态 → 切账号 → /agent 弹回记录
import { _electron, chromium } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BASE = 'http://127.0.0.1:5287';
const USERNAME = 'wt2b' + Date.now().toString(36);
// 浏览器页注册 + API 建号
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(BASE + '/register');
await page.getByLabel('用户名', { exact: true }).fill(USERNAME);
await page.getByLabel('密码（至少 12 位）').fill('{{SECRET_s2wbnk4v}}');
await page.getByRole('button', { name: '创建账号', exact: true }).click();
await page.waitForTimeout(800);
const account = await page.evaluate(async () => {
  const me = await (await fetch('/api/v1/auth/me')).json();
  await fetch('/api/v1/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: JSON.stringify({ name: '弹回2号', platform: 'wechat_mp', content_format: 'long_article' }) });
  return (await (await fetch('/api/v1/accounts')).json())[0]?.id;
});
console.log('registered', USERNAME, account);
await browser.close();

const profile = await mkdtemp(join(tmpdir(), 'ops-wt2-b2-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: BASE }, timeout: 60_000,
});
const native = await app.firstWindow();
await native.evaluate(() => {
  window.__nav = [];
  const p = history.pushState.bind(history), rp = history.replaceState.bind(history);
  history.pushState = (...a) => { window.__nav.push(['push', String(a[2])]); return p(...a); };
  history.replaceState = (...a) => { window.__nav.push(['rep', String(a[2])]); return rp(...a); };
});
await native.goto(`${BASE}/login`);
await native.getByLabel('用户名', { exact: true }).fill(USERNAME);
await native.getByLabel('密码', { exact: true }).fill('{{SECRET_s2wbnk4v}}');
await native.getByRole('button', { name: '登录', exact: true }).click();
await native.waitForTimeout(2500);
const st1 = await native.evaluate(async () => ({ path: location.pathname, me: (await (await fetch('/api/v1/auth/me')).json()).username }));
console.log('after-login:', JSON.stringify(st1));
// 直接去 /agent（绕过切账号，先看纯导航是否弹回）
await native.evaluate(() => { window.__nav = []; });
await native.goto(`${BASE}/agent`);
await native.waitForTimeout(2000);
const st2 = await native.evaluate(() => ({ path: location.pathname, nav: [...(window.__nav ?? [])], presentation: document.documentElement.dataset.presentation, hasBridge: Boolean(window.opsDesktopUI), agentList: Boolean(document.querySelector('[data-testid=\"desktop-agent-list\"]')) }));
console.log('after-direct-agent:', JSON.stringify(st2));
// 隐私弹窗
const privacy = native.getByRole('dialog').filter({ has: native.getByRole('heading', { name: '智能体隐私说明', exact: true }) });
if (await privacy.isVisible().catch(() => false)) {
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click();
  await native.waitForTimeout(1500);
}
const st3 = await native.evaluate(() => ({ path: location.pathname, nav: [...(window.__nav ?? [])] }));
const listVisible = await native.getByTestId('desktop-agent-list').isVisible().catch(() => false);
console.log('after-privacy:', JSON.stringify(st3), 'agentList:', listVisible);
await app.close();
process.exit(0);
