import { _electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const BASE = 'http://127.0.0.1:5287';
const USERNAME = 'wt2c' + Date.now().toString(36);
const profile = await mkdtemp(join(tmpdir(), 'ops-wt2-b3-'));
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
  await fetch('/api/v1/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: JSON.stringify({ name: '弹回3号', platform: 'wechat_mp', content_format: 'long_article' }) });
  return (await (await fetch('/api/v1/accounts')).json())[0]?.id;
});
await native.goto(`${BASE}/agent`);
await native.waitForTimeout(2000);
const info = await native.evaluate(() => ({
  path: location.pathname,
  presentation: document.documentElement.dataset.presentation,
  ua: navigator.userAgent.slice(0, 60),
  hasBridge: Boolean(window.opsDesktopUI),
  agentList: Boolean(document.querySelector('[data-testid="desktop-agent-list"]')),
  workbenchUI: document.querySelector('[class*="desktop-agent-workbench"]') != null,
  featuresWorkbench: (window.__wbfeatures ?? null),
}));
console.log(JSON.stringify(info, null, 1));
const bootstrap = await native.evaluate(async () => (await (await fetch('/api/v1/agent/bootstrap')).json()));
console.log('bootstrap.features.workbench_ui=', bootstrap?.features?.workbench_ui, 'canUse=', bootstrap?.can_use);
await app.close();
process.exit(0);
