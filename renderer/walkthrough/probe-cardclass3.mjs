// cardclass3：dump 消息区全部节点的类名（找卡片实际容器）
import { _electron, chromium } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const BASE = 'http://127.0.0.1:5287';
const USERNAME = 'wt2n' + Date.now().toString(36);
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
  await fetch('/api/v1/model-routes', { method: 'PUT', headers: { 'X-CSRF-Token': me.csrf_token, 'Content-Type': 'application/json' }, body: JSON.stringify([{ task_type: 'agent_chat', provider_id: mp.id, model: 'mock-agent-tested', fallback_provider_id: null, fallback_model: '' }]) });
  return (await (await fetch('/api/v1/accounts')).json())[0]?.id;
});
await browser.close();
const profile = await mkdtemp(join(tmpdir(), 'ops-wt2-cc3-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: BASE }, timeout: 60_000,
});
const native = await app.firstWindow();
await native.setViewportSize({ width: 1580, height: 1000 });
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
await native.waitForTimeout(1500);
for (let i = 0; i < 4; i++) {
  const dlg = native.getByRole('dialog').filter({ has: native.getByRole('button', { name: '我知道了', exact: true }) });
  if (await dlg.count() === 0) break;
  await dlg.first().getByRole('button', { name: '我知道了', exact: true }).click();
  await native.waitForTimeout(400);
}
await native.getByTestId('desktop-agent-list').getByRole('button', { name: '新对话', exact: true }).click();
await native.waitForTimeout(800);
await native.getByPlaceholder(/说说你想写什么/).fill(`请添加素材：类名探针3 ${Date.now()}\n#tool load_tool_domain {"domain":"materials"}\n#tool materials__create ${JSON.stringify({ account_id: account, kind: 'opinion', content: '类名探针3' })}`);
await native.getByRole('button', { name: '发送', exact: true }).click();
await native.waitForTimeout(8000);
const dump = await native.evaluate(() => {
  const el = [...document.querySelectorAll('h3')].find((h) => h.textContent?.includes('新增一条素材'));
  if (!el) return { found: false, pres: document.documentElement.dataset.presentation };
  // 向上找带 id 的卡片容器
  let cur = el, chain = [];
  while (cur && chain.length < 8) {
    chain.push({ tag: cur.tagName, id: cur.id?.slice(0, 20), cls: (cur.className ?? '').toString().slice(0, 90) });
    cur = cur.parentElement;
  }
  return { found: true, pres: document.documentElement.dataset.presentation, chain };
});
console.log(JSON.stringify(dump, null, 1));
await app.close();
process.exit(0);
