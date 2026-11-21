import { _electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const BASE = 'http://127.0.0.1:5287';
const USERNAME = 'wt2d' + Date.now().toString(36);
const profile = await mkdtemp(join(tmpdir(), 'ops-wt2-b4-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: BASE }, timeout: 60_000,
});
const native = await app.firstWindow();
await native.goto(`${BASE}/register`);
await native.getByLabel('用户名', { exact: true }).fill(USERNAME);
await native.getByLabel('密码（至少 12 位）').fill('{{SECRET_s2wbnk4v}}');
await native.getByRole('button', { name: '创建账号', exact: true }).click();
await native.waitForTimeout(800);
const account = await native.evaluate(async () => {
  const me = await (await fetch('/api/v1/auth/me')).json();
  await fetch('/api/v1/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: JSON.stringify({ name: '弹回4号', platform: 'wechat_mp', content_format: 'long_article' }) });
  return (await (await fetch('/api/v1/accounts')).json())[0]?.id;
});
await native.goto(`${BASE}/agent`);
await native.waitForTimeout(2000);
const before = await native.evaluate(() => ({ path: location.pathname, pres: document.documentElement.dataset.presentation, list: Boolean(document.querySelector('[data-testid="desktop-agent-list"]')), bootstrap: null }));
const bootstrapBefore = await native.evaluate(async () => { const b = await (await fetch('/api/v1/agent/bootstrap')).json(); return { canUse: b.can_use, wb: b.features?.workbench_ui, privacySeen: undefined }; });
// 点'我知道了'
const privacy = native.getByRole('dialog').filter({ has: native.getByRole('heading', { name: '智能体隐私说明', exact: true }) });
await privacy.getByRole('button', { name: '我知道了', exact: true }).click();
await native.waitForTimeout(1800);
const after = await native.evaluate(() => ({ path: location.pathname, pres: document.documentElement.dataset.presentation, list: Boolean(document.querySelector('[data-testid="desktop-agent-list"]')), h1: document.querySelector('h1')?.textContent?.slice(0, 24) }));
console.log('BEFORE:', JSON.stringify(before), JSON.stringify(bootstrapBefore));
console.log('AFTER :', JSON.stringify(after));
await app.close();
process.exit(0);
