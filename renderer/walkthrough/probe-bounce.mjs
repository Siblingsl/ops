// 细查③：复刻 g7 openAgent 的完整上下文（含 Chromium page 并存 + 用户菜单切账号 + 隐私弹窗），
// 挂 URL 变更记录器，钉"进入 /agent 后弹回工作台"的触发者。
import { _electron, chromium } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BASE = 'http://127.0.0.1:5287';
const browser = await chromium.launch();
const page = await browser.newPage();
// registerAccount 等价（浏览器页）
await page.goto(BASE + '/register');
await page.getByLabel('用户名', { exact: true }).fill('wt2bounce' + Date.now());
await page.getByLabel('密码（至少 12 位）').fill('{{SECRET_s2wbnk4v}}');
await page.getByRole('button', { name: '创建账号', exact: true }).click();
const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '添加平台账号', exact: true }) });
await dialog.getByRole('button', { name: /公众号/ }).click();
await dialog.getByLabel('账号名称').fill('弹回验收号');
await page.evaluate(async () => {
  const me = await (await fetch('/api/v1/auth/me')).json();
  await fetch('/api/v1/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: JSON.stringify({ name: '弹回验收号', platform: 'wechat_mp', content_format: 'long_article' }) });
});
const account = (await page.evaluate(async () => await (await fetch('/api/v1/accounts')).json()))[0];
const username = 'wt2bounce' + page.url().match(/(\d+)/)?.[1];
console.log('browser-page registered, account=', account.id);

// Electron native
const profile = await mkdtemp(join(tmpdir(), 'ops-wt2-bounce-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: BASE }, timeout: 60_000,
});
const native = await app.firstWindow();
// URL 变更记录器（history pushState/replaceState + popstate 钩入）
await native.evaluate(() => {
  window.__nav = [];
  const origPush = history.pushState.bind(history);
  const origRep = history.replaceState.bind(history);
  history.pushState = (...a) => { window.__nav.push(['push', String(a[2])]); return origPush(...a); };
  history.replaceState = (...a) => { window.__nav.push(['replace', String(a[2])]); return origRep(...a); };
  addEventListener('popstate', () => window.__nav.push(['pop', location.pathname]));
});
await native.goto(`${BASE}/login`);
await native.getByLabel('用户名', { exact: true }).fill(username);
await native.getByLabel('密码', { exact: true }).fill('{{SECRET_s2wbnk4v}}');
await native.getByRole('button', { name: '登录', exact: true }).click();
await native.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 20000 });
await native.waitForTimeout(1500);
for (let i = 0; i < 20; i++) { const st = await native.evaluate(async () => (await fetch('/api/v1/auth/me')).status); if (st === 200) break; await native.waitForTimeout(500); }
// 用户菜单切账号（g7 流程）
await native.evaluate(async (accountID) => {
  const me = await (await fetch('/api/v1/auth/me')).json();
  localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountID);
}, account.id);
await native.goto(`${BASE}/a/${account.id}`);
await native.getByRole('button', { name: /用户菜单/ }).click();
await native.getByRole('menuitem', { name: '切换工作区与账号' }).click();
await native.getByTestId('desktop-context-menu').getByRole('tab', { name: /公众号/ }).click();
await native.getByTestId('desktop-context-menu').getByRole('button', { name: '弹回验收号', exact: true }).click();
await native.waitForTimeout(800);
// 进入 AI 对话
const navBefore = await native.evaluate(() => [...window.__nav]);
await native.getByRole('link', { name: 'AI 对话', exact: true }).click();
await native.waitForTimeout(1500);
const navAfter1 = await native.evaluate(() => [...window.__nav]);
const path1 = await native.evaluate(() => location.pathname);
// 隐私弹窗处理
const privacy = native.getByRole('dialog').filter({ has: native.getByRole('heading', { name: '智能体隐私说明', exact: true }) });
if (await privacy.isVisible().catch(() => false)) {
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click();
  await native.waitForTimeout(1200);
}
const path2 = await native.evaluate(() => location.pathname);
const navAfter2 = await native.evaluate(() => [...window.__nav]);
const listVisible = await native.getByTestId('desktop-agent-list').isVisible().catch(() => false);
console.log('path-after-link:', path1);
console.log('path-after-privacy:', path2, 'agent-list:', listVisible);
console.log('NAV before link:', JSON.stringify(navBefore.slice(-4)));
console.log('NAV after link:', JSON.stringify(navAfter1.slice(-6)));
console.log('NAV after privacy:', JSON.stringify(navAfter2.slice(-6)));
await app.close();
await browser.close();
process.exit(0);
