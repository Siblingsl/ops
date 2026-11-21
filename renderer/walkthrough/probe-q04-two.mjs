// Q-04 两轮复现：round1 全流程（建作品→check），round2 再建→check，
// round2 结束后回 /a/:id（模拟 spec 的 for 循环）再看 round2 的 check 是否被弹回
import { _electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BASE='http://127.0.0.1:5287';
const profile = await mkdtemp(join(tmpdir(), 'ops-probe-q04b-'));
const app = await _electron.launch({
  executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
  args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
  env: { ...process.env, OPS_DESKTOP_DEV_URL: BASE }, timeout: 60_000,
});
const page = await app.firstWindow();
await page.goto(`${BASE}/register`);
await page.getByLabel('用户名', { exact: true }).fill('q04two'+Date.now());
await page.getByLabel('密码（至少 12 位）').fill('{{SECRET_g8qmvk3p}}');
await page.getByRole('button', { name: '创建账号', exact: true }).click();
await page.waitForTimeout(1200);
await page.evaluate(async () => { const me=await (await fetch('/api/v1/auth/me')).json(); await fetch('/api/v1/accounts',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':me.csrf_token},body:JSON.stringify({name:'Q04二轮号',platform:'xhs',content_format:'image_note'})}); });
const acc = (await page.evaluate(async () => await (await fetch('/api/v1/accounts')).json()))[0];
async function makeWork(){
  return await page.evaluate(async (aid) => {
    const me=await (await fetch('/api/v1/auth/me')).json();
    const r = await fetch(`/api/v1/accounts/${aid}/works`, { method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':me.csrf_token}, body: JSON.stringify({title:'Q04两轮作品', content_format:'image_note'}) });
    return (await r.json()).id;
  }, acc.id);
}
for (const round of [1,2]) {
  await page.goto(`${BASE}/a/${acc.id}`);
  await page.waitForTimeout(600);
  const w = await makeWork();
  await page.goto(`${BASE}/works/${w}/check`);
  await page.waitForTimeout(2500);
  const loc = await page.evaluate(() => ({ path: location.pathname, h1: document.querySelector('h1')?.textContent?.slice(0,24) ?? null }));
  console.log(`ROUND${round}:`, JSON.stringify(loc));
}
await app.close();
process.exit(0);
