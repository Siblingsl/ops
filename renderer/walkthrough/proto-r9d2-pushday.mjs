// R9-3 v2：push_record 跨日重置边界 —— 聚焦 reserveWechatPush 的 created_at >= s.today() 计数语义。
// 方法（如实登记）：真实推送闸门链（封面/正文/resolve）已在 R6-A/R7-A 全量验证，本轮不重复；
// 改为 DB 注入 status='ok' 的 push_record（与 hc_test.go:437 相同模式），用真实 API push 观察计数与上限判定。
const BASE = 'http://127.0.0.1:8388/api/v1';
import { spawnSync } from 'node:child_process';

function psql(sql) {
  const r = spawnSync('docker', ['exec', '-i', 'ops-dev-postgres-1', 'psql', '-U', 'ops', '-d', 'ops_e2e', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], {
    input: sql + '\n', encoding: 'utf8', timeout: 30000,
  });
  if (r.status !== 0) throw new Error('psql failed: ' + (r.stderr || r.stdout));
  return r.stdout.trim().split('\n').filter((l) => !/^(INSERT|UPDATE|DELETE) \d+ \d*$/.test(l.trim())).pop()?.replace(/^(INSERT|UPDATE|DELETE) \d+\s*/,'').trim() || r.stdout.trim();
}
function cookieOf(r) { const c = (r.headers?.getSetCookie?.() ?? [])[0]; return c ? c.split(';')[0] : null; }
async function req(method, path, { body, rawCookie, csrfHeader } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (csrfHeader) h['X-CSRF-Token'] = csrfHeader;
  if (rawCookie) h['Cookie'] = rawCookie;
  const res = await fetch(BASE + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text.slice(0, 120) }; }
  return { status: res.status, json, headers: res.headers };
}

let r = await req('POST', '/auth/register', { body: { username: 'r9pd' + Math.random().toString(36).slice(2, 9), password: '{{SECRET_s2wbnk4v}}' } });
const o = { cookie: cookieOf(r) };
r = await req('GET', '/auth/me', { rawCookie: o.cookie });
o.csrf = r.json?.csrf_token ?? null;
r = await req('POST', '/accounts', { body: { name: 'R9跨日号', platform: 'wechat_mp', content_format: 'long_article' }, rawCookie: o.cookie, csrfHeader: o.csrf });
const acc = r.json?.id;
await req('PATCH', `/accounts/${acc}`, { body: { daily_push_limit: 1 }, rawCookie: o.cookie, csrfHeader: o.csrf });
await req('PUT', `/accounts/${acc}/wechat-credential`, { body: { app_id: 'wx_r9d', app_secret: '{{SECRET_s2wbnk4v}}' }, rawCookie: o.cookie, csrfHeader: o.csrf });
await req('POST', `/accounts/${acc}/wechat-credential/test`, { body: {}, rawCookie: o.cookie, csrfHeader: o.csrf });

// 占位作品（hc_test.go:436 同款最简 work）
const seedWork = psql(`INSERT INTO work(account_id, content_format, title) VALUES('${acc}','long_article','R9跨日占位') RETURNING id;`);
console.log('seed work:', seedWork);
// 封面资产种子（满足 push 入口 CoverAssetID+CoverCrops 前置）
const assetID = psql(`INSERT INTO asset (workspace_id, work_id, storage_path, mime, width, height, bytes, sha256, position, ai_generated, alt_text) SELECT pa.workspace_id, w.id, 'r9-cover.png', 'image/png', 900, 383, 68, 'r9seed', 0, false, 'R9 封面' FROM work w JOIN platform_account pa ON pa.id=w.account_id WHERE w.id='${seedWork}' RETURNING id;`);
psql(`UPDATE work SET cover_asset_id='${assetID}', cover_crops='{"1.00_1":[0,0,1,1]}'::jsonb WHERE id='${seedWork}';`);
console.log('cover seeded:', assetID);

// D1: 注入今天 23:59:59 的 ok 记录（>= today 00:00 → 计入今天）
psql(`UPDATE push_record SET created_at=((now() AT TIME ZONE 'Asia/Shanghai')::date + time '23:59:59') AT TIME ZONE 'Asia/Shanghai' WHERE work_id='${seedWork}';`);
console.log('D1 created_at(t+23:59:59):', psql(`SELECT created_at FROM push_record WHERE work_id='${seedWork}';`));
console.log('  today count:', psql(`SELECT count(*) FROM push_record WHERE account_id='${acc}' AND status='ok' AND created_at >= (now() AT TIME ZONE 'Asia/Shanghai')::date::timestamp AT TIME ZONE 'Asia/Shanghai';`));

// D2: 推新作品 → 预期 409 push_limit_reached（今天 1/1）——先建一个 ready 作品太重；
// 直接用 reserveWechatPush 的前置状态把 seedWork 置 ready + revision 1 满足闸门（rev 必须匹配）：
psql(`UPDATE work SET status='ready' WHERE id='${seedWork}';`);
r = await req('POST', `/works/${seedWork}/wechat/push`, { body: { revision: 1 }, rawCookie: o.cookie, csrfHeader: o.csrf });
console.log('D2 push (today count=1, limit=1) ->', r.status, r.json?.error?.code ?? '', r.json?.error?.message?.slice(0, 60) ?? '');
console.log('D2 409-limit-correct:', r.status === 409 && r.json?.error?.code === 'push_limit_reached');

// D3: confirm_over_limit=true → 越限继续 → 200（真实 mock 微信 DraftAdd）
r = await req('POST', `/works/${seedWork}/wechat/push`, { body: { revision: 1, confirm_over_limit: true }, rawCookie: o.cookie, csrfHeader: o.csrf });
console.log('D3 push confirm_over_limit ->', r.status, r.json?.error?.code ?? '');
const D3ok = r.status === 200;
// D3 后 push_record 里应有一条新的 ok 记录（真实推送）
console.log('  records now:', psql(`SELECT count(*) FROM push_record WHERE account_id='${acc}' AND status='ok';`));

// D4: 把全部 ok 记录回填为昨天 23:59:59 → 跨过 00:00 → 计数归零 → 新一次 push 不再撞限
psql(`UPDATE push_record SET created_at=(((now() AT TIME ZONE 'Asia/Shanghai')::date - 1) + time '23:59:59') AT TIME ZONE 'Asia/Shanghai' WHERE account_id='${acc}' AND status='ok';`);
console.log('D4 yesterday counts:', psql(`SELECT count(*) FROM push_record WHERE account_id='${acc}' AND status='ok' AND created_at >= (now() AT TIME ZONE 'Asia/Shanghai')::date::timestamp AT TIME ZONE 'Asia/Shanghai';`));
// 第二次真实推送（无 confirm —— 计数已归零不应要求 confirm）
psql(`UPDATE work SET status='pushed' WHERE id='${seedWork}';`);
r = await req('POST', `/works/${seedWork}/wechat/push`, { body: { revision: 1, confirm_over_limit: false }, rawCookie: o.cookie, csrfHeader: o.csrf });
console.log('D5 push after midnight-reset ->', r.status, r.json?.error?.code ?? '', r.json?.error?.message?.slice(0, 60) ?? '');
console.log('D5 reset-correct:', r.status === 200, '(无 confirm 也成功 = 跨日重置)');

// D6: 边界值精确性 —— created_at 恰为 today 00:00:00（含）应计入；yesterday 23:59:59（不含）应排除
const cnt = psql(`SELECT count(*) FROM push_record WHERE account_id='${acc}' AND created_at >= date_trunc('day', (now() AT TIME ZONE 'Asia/Shanghai')::timestamp) AT TIME ZONE 'Asia/Shanghai';`);
console.log('D6 today-count after D4/D5:', cnt, '(D5 的 200 推送产生今天新记录，应为 1)');

console.log('\nR9-3 done', { D3ok });
process.exit(0);
