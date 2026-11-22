// R9-2 phase C 验证：410 游标过期 + prune 推进 floor（种子已在 DB 就位：10001 delta @ conv 5595615c-9c11-4d79-8bf5-e2e36e312d7d 由 r9floor 系列用户持有）。
// 本脚本用最后注册的 r9floor 用户会话直接访问。
const BASE = 'http://127.0.0.1:8388/api/v1';
const CONV = process.argv[2];
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

// 用会话归属用户登录（从 DB 反查 username）
const owner = psql(`SELECT u.username FROM agent_conversation c JOIN app_user u ON u.id=c.user_id WHERE c.id='${CONV}'`);
console.log('owner:', owner);
let r = await req('POST', '/auth/login', { body: { username: owner, password: '{{SECRET_s2wbnk4v}}' } });
const o = { cookie: cookieOf(r) };
r = await req('GET', '/auth/me', { rawCookie: o.cookie });
o.csrf = r.json?.csrf_token ?? null;
console.log('login:', r.status);

const state = psql(`SELECT next_event_seq||'/'||event_retention_floor FROM agent_conversation WHERE id='${CONV}'`);
console.log('conv seq/floor:', state);

// C1: after=10100 正常读（无 410）
let res = await fetch(`${BASE}/agent/conversations/${CONV}/events?after_event_seq=10100`, { headers: { Cookie: o.cookie, 'X-CSRF-Token': o.csrf }, signal: AbortSignal.timeout(8000) });
console.log('C1 after=10100 ->', res.status);
await res.body?.cancel?.().catch(() => {});

// C2: 全部 delta 过期 → 调 SSE 触发 pruneAgentDeltaEvents → floor 推进
console.log('expire:', psql(`UPDATE agent_event SET expires_at=now()-interval '1 second' WHERE conversation_id='${CONV}' AND type='message.delta';`) || 'updated');
res = await fetch(`${BASE}/agent/conversations/${CONV}/events?after_event_seq=10100`, { headers: { Cookie: o.cookie, 'X-CSRF-Token': o.csrf }, signal: AbortSignal.timeout(8000) });
console.log('C2 prune trigger ->', res.status);
await res.body?.cancel?.().catch(() => {});
const floor = psql(`SELECT event_retention_floor FROM agent_conversation WHERE id='${CONV}'`);
console.log('floor after prune:', floor);
console.log('delta rows left:', psql(`SELECT count(*) FROM agent_event WHERE conversation_id='${CONV}' AND type='message.delta';`));

// C3: after=0 → 410
res = await fetch(`${BASE}/agent/conversations/${CONV}/events?after_event_seq=0`, { headers: { Cookie: o.cookie, 'X-CSRF-Token': o.csrf }, signal: AbortSignal.timeout(8000) });
const body3 = await res.text();
console.log('C3 after=0 ->', res.status, body3.slice(0, 150).replace(/\n/g, ' '));
console.log('C3 410-correct:', res.status === 410 && body3.includes('agent_event_cursor_expired'));

// C4: 快照可取（客户端恢复路径）
res = await fetch(`${BASE}/agent/conversations/${CONV}`, { headers: { Cookie: o.cookie, 'X-CSRF-Token': o.csrf }, signal: AbortSignal.timeout(8000) });
const snap = await res.json();
console.log('C4 snapshot ->', res.status, 'last_event_seq=', snap.last_event_seq);

// C5: after=floor 边界可读
res = await fetch(`${BASE}/agent/conversations/${CONV}/events?after_event_seq=${floor}`, { headers: { Cookie: o.cookie, 'X-CSRF-Token': o.csrf }, signal: AbortSignal.timeout(8000) });
console.log('C5 after=floor ->', res.status);
await res.body?.cancel?.().catch(() => {});

console.log('\nR9-2 phase C done');
process.exit(0);
