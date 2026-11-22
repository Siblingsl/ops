// R9-3：push_record 跨日重置边界（created_at >= s.today()，00:00 边界跨越）。
// 方法（如实登记）：不动系统时钟，采用与 agent_routines_test.go:681 相同的服务端时间控制思想，
// 但走 API + DB 组合：真实推送产生 status='ok' 记录后，把 push_record.created_at 回填为
// "今天 23:59" 与 "昨天 23:59" 两种形态，再分别触发 push 观察计数与 over_limit 判定：
//   - created_at >= today 00:00（今天 23:59）→ 计入当日 → 触达上限
//   - created_at < today 00:00（昨天 23:59）→ 不计入 → 配额重置（跨日边界正确性）
// 今天是 2026-11-22（Asia/Shanghai）。
const BASE = 'http://127.0.0.1:8388/api/v1';
import { spawnSync } from 'node:child_process';

function psql(sql) {
  const r = spawnSync('docker', ['exec', '-i', 'ops-dev-postgres-1', 'psql', '-U', 'ops', '-d', 'ops_e2e', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], {
    input: sql + '\n', encoding: 'utf8', timeout: 30000,
  });
  if (r.status !== 0) throw new Error('psql failed: ' + (r.stderr || r.stdout));
  return r.stdout.trim();
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

let r = await req('POST', '/auth/register', { body: { username: 'r9push' + Math.random().toString(36).slice(2, 9), password: '{{SECRET_s2wbnk4v}}' } });
const o = { cookie: cookieOf(r) };
r = await req('GET', '/auth/me', { rawCookie: o.cookie });
o.csrf = r.json?.csrf_token ?? null;

// 建号 + 凭证（mock 微信）
r = await req('POST', '/accounts', { body: { name: 'R9推送号', platform: 'wechat_mp', content_format: 'long_article' }, rawCookie: o.cookie, csrfHeader: o.csrf });
const acc = r.json?.id;
await req('PUT', `/accounts/${acc}/wechat-credential`, { body: { app_id: 'wx_r9c', app_secret: '{{SECRET_s2wbnk4v}}' }, rawCookie: o.cookie, csrfHeader: o.csrf });
await req('POST', `/accounts/${acc}/wechat-credential/test`, { body: {}, rawCookie: o.cookie, csrfHeader: o.csrf });
// 限额调到 1（更小的边界）
r = await req('PATCH', `/accounts/${acc}`, { body: { daily_push_limit: 1 }, rawCookie: o.cookie, csrfHeader: o.csrf });
console.log('limit set:', r.status, r.json?.daily_push_limit);

// 建作品走 ready（大纲→section→检查→resolve→complete）
async function makeReadyWork(idx) {
  r = await req('POST', `/accounts/${acc}/works`, { body: { title: `R9跨日推送作品${idx}（标题要够长占位）`, content_format: 'long_article', viewpoint: '跨日边界走查观点' }, rawCookie: o.cookie, csrfHeader: o.csrf });
  const w = r.json?.id;
  await req('PATCH', `/works/${w}`, { body: { content_md: '# 跨日推送\n\n第一节：事实与验证。\n\n## 第二节\n\n第二节内容。' }, rawCookie: o.cookie, csrfHeader: o.csrf });
  await req('PUT', `/works/${w}/outline`, { body: { items: [{ heading: '第一节', summary: '事实' }, { heading: '第二节', summary: '验证' }], confirm: true }, rawCookie: o.cookie, csrfHeader: o.csrf });
  await new Promise((res) => setTimeout(res, 900));
  r = await req('GET', `/works/${w}`, { rawCookie: o.cookie, csrfHeader: o.csrf });
  for (const s of r.json?.sections ?? []) {
    await req('PATCH', `/sections/${s.id}`, { body: { content_md: '第一节记录可核对的事实并说明验证方式，结论保持谨慎。', base_revision: s.revision }, rawCookie: o.cookie, csrfHeader: o.csrf });
  }
  await req('POST', `/works/${w}/checks`, { body: {}, rawCookie: o.cookie, csrfHeader: o.csrf });
  for (let i = 0; i < 25; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    const c = await req('GET', `/works/${w}/checks/latest`, { rawCookie: o.cookie, csrfHeader: o.csrf });
    if (c.json?.run && c.json.run.fact_status !== 'pending') { r = c; break; }
  }
  const run = r.json?.run;
  for (const item of run?.items ?? []) {
    if (item.category !== 'format' && !item.resolution) {
      await req('POST', `/check-items/${item.id}/resolve`, { body: { resolution: 'verified' }, rawCookie: o.cookie, csrfHeader: o.csrf }).catch(() => {});
    }
  }
  r = await req('POST', `/works/${w}/checks/complete`, { body: {}, rawCookie: o.cookie, csrfHeader: o.csrf });
  if (r.status !== 200) console.log('  complete:', r.status, r.json?.error?.code);
  r = await req('GET', `/works/${w}`, { rawCookie: o.cookie, csrfHeader: o.csrf });
  console.log(`  work${idx} status:`, r.json?.status, 'revision:', r.json?.revision);
  return { w, rev: r.json?.revision };
}

console.log('preparing work A...');
const A = await makeReadyWork(1);

// P1: 真实推送一次 → status ok
r = await req('POST', `/works/${A.w}/wechat/push`, { body: { revision: A.rev }, rawCookie: o.cookie, csrfHeader: o.csrf });
console.log('P1 push1:', r.status, r.json?.error?.code ?? '');
const pushOk = r.status === 200;
console.log('push_record:', psql(`SELECT action||'/'||status||'/'||over_limit FROM push_record WHERE work_id='${A.w}';`));

// P2: 回填 created_at=今天 23:59 → 仍是"今天" → 新 push 撞上限（limit=1, count>=1）
const now23 = psql(`SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai')::text FROM dual;`).trim();
console.log('today00:', now23);
psql(`UPDATE push_record SET created_at=(now() AT TIME ZONE 'Asia/Shanghai')::date::timestamp + interval '23 hours 59 minutes' AT TIME ZONE 'Asia/Shanghai' WHERE work_id='${A.w}';`);
console.log('backfilled created_at:', psql(`SELECT created_at FROM push_record WHERE work_id='${A.w}';`));

console.log('preparing work B...');
const B = await makeReadyWork(2);
r = await req('POST', `/works/${B.w}/wechat/push`, { body: { revision: B.rev }, rawCookie: o.cookie, csrfHeader: o.csrf });
console.log('P2 push@today23:59 ->', r.status, r.json?.error?.code ?? '', '(expect 409 push_limit_reached)');

// P3: 回填 created_at=昨天 23:59 → 跨过 00:00 边界 → 计数重置 → push 200
psql(`UPDATE push_record SET created_at=((now() AT TIME ZONE 'Asia/Shanghai')::date - interval '1 day')::timestamp + interval '23 hours 59 minutes' AT TIME ZONE 'Asia/Shanghai' WHERE work_id='${A.w}';`);
console.log('backfilled yesterday:', psql(`SELECT created_at FROM push_record WHERE work_id='${A.w}';`));
r = await req('POST', `/works/${B.w}/wechat/push`, { body: { revision: B.rev, confirm_over_limit: false }, rawCookie: o.cookie, csrfHeader: o.csrf });
console.log('P3 push@yesterday23:59 ->', r.status, r.json?.error?.code ?? '', '(expect 200 = 跨日重置生效)');

// P4: 恢复今天的记录，验证 reserveWechatPush 的 today_count 语义与 todayPushCount 一致
psql(`UPDATE push_record SET created_at=now() WHERE work_id='${A.w}';`);
console.log('today count after P3:', psql(`SELECT count(*) FROM push_record WHERE account_id='${acc}' AND status='ok' AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';`));

console.log('\nR9-3 done', { pushOk });
process.exit(0);
