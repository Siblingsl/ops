// R9-2 phase C：§15.10 万条 delta + 410 游标过期路径（v2 —— SQL 走 stdin 管道，避免引号转义）。
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

let r = await req('POST', '/auth/register', { body: { username: 'r9floor' + Math.random().toString(36).slice(2, 9), password: '{{SECRET_s2wbnk4v}}' } });
const o = { cookie: cookieOf(r) };
r = await req('GET', '/auth/me', { rawCookie: o.cookie });
o.csrf = r.json?.csrf_token ?? null;
r = await req('POST', '/agent/conversations', { body: {}, rawCookie: o.cookie, csrfHeader: o.csrf });
const conv = r.json?.id;
console.log('conv:', conv);

// C0: 灌 10001 条 delta（seq 100..10100，避开基线事件 seq 1）
console.log('seeding...', psql(`INSERT INTO agent_event (conversation_id, event_seq, type, payload, expires_at) SELECT '${conv}', generate_series(100,10100), 'message.delta', json_build_object('message_key','seed-mk','chunk_index',gs,'text','chunk '||gs), now() + interval '7 days' FROM generate_series(100,10100) gs ON CONFLICT DO NOTHING;`) || 'inserted');
console.log('bump seq:', psql(`UPDATE agent_conversation SET next_event_seq=10101, read_upto_event_seq=10101 WHERE id='${conv}' RETURNING next_event_seq;`));

// C1: after=10100 正常读（无 410）
let res = await fetch(`${BASE}/agent/conversations/${conv}/events?after_event_seq=10100`, { headers: { Cookie: o.cookie, 'X-CSRF-Token': o.csrf } });
console.log('C1 after=10100 ->', res.status);
await res.body?.cancel?.();

// C2: 全部 delta 过期 → 调 SSE 触发 pruneAgentDeltaEvents → floor 推进
console.log('expire:', psql(`UPDATE agent_event SET expires_at=now()-interval '1 second' WHERE conversation_id='${conv}' AND type='message.delta';`) || 'updated');
res = await fetch(`${BASE}/agent/conversations/${conv}/events?after_event_seq=10100`, { headers: { Cookie: o.cookie, 'X-CSRF-Token': o.csrf } });
console.log('C2 prune trigger ->', res.status);
await res.body?.cancel?.();
console.log('floor after prune:', psql(`SELECT event_retention_floor FROM agent_conversation WHERE id='${conv}';`));
console.log('delta rows left:', psql(`SELECT count(*) FROM agent_event WHERE conversation_id='${conv}' AND type='message.delta';`));

// C3: after=0 → 410
res = await fetch(`${BASE}/agent/conversations/${conv}/events?after_event_seq=0`, { headers: { Cookie: o.cookie, 'X-CSRF-Token': o.csrf } });
const body3 = await res.text();
console.log('C3 after=0 ->', res.status, body3.slice(0, 150).replace(/\n/g, ' '));
console.log('C3 410-correct:', res.status === 410 && body3.includes('agent_event_cursor_expired'));

// C4: 快照可取（客户端恢复路径）
res = await fetch(`${BASE}/agent/conversations/${conv}`, { headers: { Cookie: o.cookie, 'X-CSRF-Token': o.csrf } });
const snap = await res.json();
console.log('C4 snapshot ->', res.status, 'last_event_seq=', snap.last_event_seq);

// C5: after=floor 边界可读
const floor = Number(psql(`SELECT event_retention_floor FROM agent_conversation WHERE id='${conv}';`));
res = await fetch(`${BASE}/agent/conversations/${conv}/events?after_event_seq=${floor}`, { headers: { Cookie: o.cookie, 'X-CSRF-Token': o.csrf } });
console.log('C5 after=floor ->', res.status);
await res.body?.cancel?.();

console.log('\nR9-2 phase C done');
process.exit(0);
