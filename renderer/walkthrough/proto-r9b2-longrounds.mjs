// R9-2 phase B：真实 110 轮对话（mock 模型），验证事件流线性增长 + compact 真实触发。
const BASE = 'http://127.0.0.1:8388/api/v1';
const CONV = process.argv[2];
import { spawnSync } from 'node:child_process';

function psql(sql) {
  const r = spawnSync('docker', ['exec', '-i', 'ops-dev-postgres-1', 'psql', '-U', 'ops', '-d', 'ops_e2e', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], { input: sql + '\n', encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) throw new Error('psql: ' + (r.stderr || '').slice(0, 200));
  return r.stdout.trim().replace(/^(INSERT|UPDATE|DELETE) \d+\s*/m, '').split('\n').filter(Boolean).pop() ?? '';
}
function cookieOf(r) { const c = (r.headers?.getSetCookie?.() ?? [])[0]; return c ? c.split(';')[0] : null; }
async function req(method, path, { body, rawCookie, csrfHeader } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (csrfHeader) h['X-CSRF-Token'] = csrfHeader;
  if (rawCookie) h['Cookie'] = rawCookie;
  const res = await fetch(BASE + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await res.text();
  let j = null;
  try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: res.status, json: j, headers: res.headers };
}

const owner = psql(`SELECT u.username FROM agent_conversation c JOIN app_user u ON u.id=c.user_id WHERE c.id='${CONV}'`);
let r = await req('POST', '/auth/login', { body: { username: owner, password: '{{SECRET_s2wbnk4v}}' } });
const o = { cookie: cookieOf(r) };
r = await req('GET', '/auth/me', { rawCookie: o.cookie });
const csrf = r.json?.csrf_token ?? null;
console.log('owner login:', r.status);

const t0 = Date.now();
let okRuns = 0, busy409 = 0;
const ROUNDS = Number(process.argv[3] ?? 110);
for (let i = 0; i < ROUNDS; i++) {
  const resp = await req('POST', `/agent/conversations/${CONV}/messages`, {
    body: { text: `R9-2B 长对话第 ${i + 1} 轮：请确认收到本轮序号 ${i + 1}，并复述本轮要点（固定回复）。`, request_id: crypto.randomUUID(), protocol_version: 2 },
    rawCookie: o.cookie, csrfHeader: csrf,
  });
  if (resp.status === 202) okRuns++; else { busy409++; if (i < 3 || busy409 < 3) console.log(`  round ${i + 1}: ${resp.status} ${resp.json?.error?.code ?? ''}`); }
  // 等 run 结束：轮询 conversation 详情直到无 active_run（简单等待）
  await new Promise((res) => setTimeout(res, 700));
}
console.log(`rounds: ok=${okRuns} busy=${busy409} elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s`);

// 事件统计
console.log('event count by type:');
console.log(psql(`SELECT type || ': ' || count(*) FROM agent_event WHERE conversation_id='${CONV}' GROUP BY type ORDER BY count(*) DESC;`));
console.log('total:', psql(`SELECT count(*) FROM agent_event WHERE conversation_id='${CONV}';`));
console.log('messages:', psql(`SELECT count(*) FROM agent_message WHERE conversation_id='${CONV}';`));
console.log('seq range:', psql(`SELECT min(event_seq) || '..' || max(event_seq) FROM agent_event WHERE conversation_id='${CONV}';`));

// compact 真实触发（110 轮 40000 chars 窗口可能仍不够 —— 每轮约 60 字 → 6600 字 < 40000；can_compact 预期 false，如实记录）
r = await req('GET', `/agent/conversations/${CONV}/compact-preview`, { rawCookie: o.cookie, csrfHeader: csrf });
console.log('compact-preview:', r.status, JSON.stringify(r.json));
r = await req('POST', `/agent/conversations/${CONV}/compact`, { body: { request_id: crypto.randomUUID(), protocol_version: 2 }, rawCookie: o.cookie, csrfHeader: csrf });
console.log('compact:', r.status, r.json?.error?.code ?? '(accepted)');

console.log('\nR9-2 phase B done');
process.exit(0);
