// R9-2：智能体长对话事件膨胀与 compact。
// 方法：真实 API 跑多轮消息（protocol_version=2），然后：
//   A) 统计 agent_event 行数与类型分布（事件流不无限膨胀：delta 7 天过期，snapshot 每秒限一条）
//   B) compact-preview / compact 契约
//   C) DB 灌 >10000 delta 后验证 410 游标过期路径（agent_events.go:298）
const BASE = 'http://127.0.0.1:8388/api/v1';
const F = [];
function rec(id, ok, detail) { F.push({ id, ok }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${id} :: ${detail}`); }
function cookieOf(r) { const c = (r.sc ?? [])[0]; return c ? c.split(';')[0] : null; }

async function req(method, path, { body, rawCookie, csrfHeader } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (csrfHeader) h['X-CSRF-Token'] = csrfHeader;
  if (rawCookie) h['Cookie'] = rawCookie;
  const res = await fetch(BASE + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = res.headers.getSetCookie?.() ?? [];
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text.slice(0, 100) }; }
  return { status: res.status, json, sc };
}

let r = await req('POST', '/auth/register', { body: { username: 'r9ev' + Math.random().toString(36).slice(2, 9), password: '{{SECRET_s2wbnk4v}}' } });
const o = { cookie: cookieOf(r), csrf: null };
r = await req('GET', '/auth/me', { rawCookie: o.cookie });
o.csrf = r.json?.csrf_token ?? null;
console.log('register:', r.status, 'csrf:', o.csrf ? 'yes' : 'no');

// 1) 建会话
r = await req('POST', '/agent/conversations', { body: {}, rawCookie: o.cookie, csrfHeader: o.csrf });
rec('A0-create-conv', r.status === 200 || r.status === 201, `status=${r.status}`);
const conv = r.json?.id;
console.log('conv:', conv);

// 0) 模型自检（mock-writer tools_ok）+ 确认 agent 模型可选
r = await req('GET', '/model-providers', { rawCookie: o.cookie, csrfHeader: o.csrf });
const providers = r.json ?? [];
let providerID = null;
for (const p of providers) {
  if (!(p.models ?? []).includes('mock-writer')) continue;
  providerID = p.id;
  const cap = (p.capabilities ?? []).find((c) => c.model === 'mock-writer');
  if (!(cap?.tools_ok)) {
    const st = await req('POST', `/model-providers/${p.id}/selftest`, { body: { model: 'mock-writer' }, rawCookie: o.cookie, csrfHeader: o.csrf });
    console.log('  selftest:', st.status);
  }
  break;
}
console.log('provider:', providerID);
r = await req('GET', '/agent/bootstrap', { rawCookie: o.cookie, csrfHeader: o.csrf });
console.log('agent bootstrap models:', r.status, JSON.stringify((r.json?.models ?? []).map((m) => `${m.model}:${m.available}:${m.is_default}`)).slice(0, 200), 'default:', r.json?.default_model ?? r.json?.default);
const boot = r.json ?? {};
console.log('bootstrap keys:', Object.keys(boot).join(','));

// 2) 真实多轮 run（每轮等 done）
async function sendMessage(text, requestID) {
  let resp = await req('POST', `/agent/conversations/${conv}/messages`, {
    body: { text, request_id: requestID, protocol_version: 2 }, rawCookie: o.cookie, csrfHeader: o.csrf,
  });
  if (resp.status !== 202) return { resp, events: null };
  const eventsURL = resp.json?.events_url;
  const events = [];
  // 拉事件（SSE）直到 run.ended 或 15s
  const res = await fetch(BASE + eventsURL.replace('/api/v1', ''), { headers: { Cookie: o.cookie, Accept: 'text/event-stream' } });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    if (buf.includes('event: run.ended') || buf.includes('event: message.saved')) break;
  }
  reader.cancel().catch(() => {});
  for (const line of buf.split('\n')) {
    const m = line.match(/^event: (.+)$/);
    if (m) events.push(m[1]);
  }
  return { resp, events };
}

const rounds = 12;
const typeCount = {};
let roundOK = 0;
for (let i = 0; i < rounds; i++) {
  const { resp, events } = await sendMessage(`R9 长对话压测第 ${i + 1} 轮：请直接确认收到。`, crypto.randomUUID());
  if (resp.status === 202) roundOK++;
  (events ?? []).forEach((e) => { typeCount[e] = (typeCount[e] ?? 0) + 1; });
  if (i === 0 && resp.status !== 202) console.log('  first msg:', resp.status, JSON.stringify(resp.json).slice(0, 200));
}
rec('A1-multi-round-runs', roundOK === rounds, `runs accepted ${roundOK}/${rounds}`);
console.log('  SSE event types:', JSON.stringify(typeCount));

// 3) compact 契约
r = await req('GET', `/agent/conversations/${conv}/compact-preview`, { rawCookie: o.cookie, csrfHeader: o.csrf });
rec('A2-compact-preview', r.status === 200, `status=${r.status} can=${r.json?.can_compact} through=${r.json?.through_seq}`);
r = await req('POST', `/agent/conversations/${conv}/compact`, { body: { request_id: crypto.randomUUID(), protocol_version: 2 }, rawCookie: o.cookie, csrfHeader: o.csrf });
rec('A3-compact-or-409', r.status === 202 || r.status === 409, `status=${r.status} code=${r.json?.error?.code}`);

// 4) DB 检查事件行数与分布
console.log('\n--- B. DB 事件分布 ---');
console.log('(查询由外部 psql 执行，见后续输出)');

console.log('\nR9-2 phase A done');

// ---- phase A2: selftest + retry（若 first msg 422） ----
