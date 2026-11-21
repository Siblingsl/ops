import { _electron, chromium } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const BASE = 'http://127.0.0.1:5287';
const USERNAME = 'wt2f' + Date.now().toString(36);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(BASE + '/register');
await page.getByLabel('用户名', { exact: true }).fill(USERNAME);
await page.getByLabel('密码（至少 12 位）').fill('{{SECRET_s2wbnk4v}}');
await page.getByRole('button', { name: '创建账号', exact: true }).click();
await page.waitForTimeout(600);
const account = await page.evaluate(async () => {
  const me = await (await fetch('/api/v1/auth/me')).json();
  await fetch('/api/v1/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: JSON.stringify({ name: '浏览器验收号', platform: 'wechat_mp', content_format: 'long_article' }) });
  // addLocalModel 等价：selftest + agent_chat 路由
  const provs = await (await fetch('/api/v1/model-providers')).json();
  const mp = (Array.isArray(provs) ? provs : provs.items)[0];
  await fetch(`/api/v1/model-providers/${mp.id}/selftest`, { method: 'POST', headers: { 'X-CSRF-Token': me.csrf_token, 'Content-Type': 'application/json' }, body: '{}' });
  await fetch('/api/v1/model-routes', { method: 'PUT', headers: { 'X-CSRF-Token': me.csrf_token, 'Content-Type': 'application/json' }, body: JSON.stringify([{ task_type: 'agent_chat', provider_id: mp.id, model: 'mock-writer', fallback_provider_id: null, fallback_model: '' }]) });
  return (await (await fetch('/api/v1/accounts')).json())[0]?.id;
});
await browser.close();
const profile = await mkdtemp(join(tmpdir(), 'ops-wt2-b6-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: BASE }, timeout: 60_000,
});
const native = await app.firstWindow();
await native.goto(`${BASE}/login`);
await native.getByLabel('用户名', { exact: true }).fill(USERNAME);
await native.getByLabel('密码', { exact: true }).fill('{{SECRET_s2wbnk4v}}');
await native.getByRole('button', { name: '登录', exact: true }).click();
await native.waitForTimeout(2200);
await native.evaluate(async (accountID) => {
  const me = await (await fetch('/api/v1/auth/me')).json();
  localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountID);
}, account);
await native.goto(`${BASE}/a/${account}`);
await native.waitForTimeout(1200);
await native.getByRole('button', { name: /用户菜单/ }).click();
await native.getByRole('menuitem', { name: '切换工作区与账号' }).click();
await native.getByTestId('desktop-context-menu').getByRole('tab', { name: /公众号/ }).click();
await native.getByTestId('desktop-context-menu').getByRole('button', { name: '浏览器验收号', exact: true }).click();
await native.waitForTimeout(1000);
await native.getByRole('link', { name: 'AI 对话', exact: true }).click();
await native.waitForTimeout(1800);
const privacy = native.getByRole('dialog').filter({ has: native.getByRole('heading', { name: '智能体隐私说明', exact: true }) });
if (await privacy.isVisible().catch(() => false)) {
  await privacy.getByRole('button', { name: '我知道了', exact: true }).click();
  await native.waitForTimeout(2000);
}
const p = await native.evaluate(() => ({ path: location.pathname, list: Boolean(document.querySelector('[data-testid="desktop-agent-list"]')), h1: document.querySelector('h1')?.textContent?.slice(0, 20) }));
const newBtn = await native.getByTestId('desktop-agent-list').getByRole('button', { name: '新对话', exact: true }).isVisible().catch(() => false);
console.log('FINAL:', JSON.stringify(p), 'newBtn:', newBtn);
await app.close();
process.exit(0);
