import { _electron, chromium } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const BASE = 'http://127.0.0.1:5287';
const USERNAME = 'wt2g' + Date.now().toString(36);
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
  const provs = await (await fetch('/api/v1/model-providers')).json();
  const mp = (Array.isArray(provs) ? provs : provs.items)[0];
  await fetch(`/api/v1/model-providers/${mp.id}/selftest`, { method: 'POST', headers: { 'X-CSRF-Token': me.csrf_token, 'Content-Type': 'application/json' }, body: '{}' });
  await fetch('/api/v1/model-routes', { method: 'PUT', headers: { 'X-CSRF-Token': me.csrf_token, 'Content-Type': 'application/json' }, body: JSON.stringify([{ task_type: 'agent_chat', provider_id: mp.id, model: 'mock-writer', fallback_provider_id: null, fallback_model: '' }]) });
  return (await (await fetch('/api/v1/accounts')).json())[0]?.id;
});
await browser.close();
const profile = await mkdtemp(join(tmpdir(), 'ops-wt2-b7-'));
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
await native.getByRole('link', { name: 'AI 对话', exact: true }).click();
await native.waitForTimeout(2200);
const dump = await native.evaluate(() => {
  const aside = document.querySelector('[data-testid="desktop-agent-list"]');
  if (!aside) return { aside: false };
  const btns = [...aside.querySelectorAll('button')].map((b) => ({ t: b.textContent?.trim().slice(0, 12), visible: b.offsetParent != null, hidden: b.getAttribute('aria-hidden') }));
  const parent = aside.parentElement;
  return { aside: true, btnCount: btns.length, btns: btns.slice(0, 6), asideW: aside.getBoundingClientRect().width, asideH: aside.getBoundingClientRect().height, asideDisplay: getComputedStyle(aside).display, parentAttrs: parent?.getAttribute('data-list-collapsed') };
});
console.log(JSON.stringify(dump, null, 1));
await app.close();
process.exit(0);
