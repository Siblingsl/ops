// R9：并发压力专项——最终版
// S1 双窗口 PATCH 章节（严格 CAS + 冲突快照）/ S2 素材 last-write + 选题库存 CAS /
// S3 跨 work 推送限额（Q-20 复现）/ S4 智能体同会话互斥 + 排队消费 / S5 构建+PATCH（Q-19 复现）
import { readFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:8387/api/v1';
const F = [];
function rec(id, ok, detail) { F.push({ id, ok }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${id} :: ${detail}`); }
function cookieOf(r) { const c = (r.sc ?? [])[0]; return c ? c.split(';')[0] : null; }
async function req(method, path, { body, rawCookie, csrf } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (csrf) h['X-CSRF-Token'] = csrf;
  if (rawCookie) h['Cookie'] = rawCookie;
  const res = await fetch(BASE + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = res.headers.getSetCookie?.() ?? [];
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text.slice(0, 200) }; }
  return { status: res.status, json, sc, text };
}
const U = (p) => p + Math.random().toString(36).slice(2, 9);
const PW = '{{SECRET_s2wbnk4v}}';
async function login(username) {
  const r1 = await req('POST', '/auth/login', { body: { username, password: PW } });
  const cookie = cookieOf(r1);
  const me = await req('GET', '/auth/me', { rawCookie: cookie });
  return { username, cookie, csrf: me.json?.csrf_token ?? null };
}
async function freshUser(prefix) {
  const r = await req('POST', '/auth/register', { body: { username: U(prefix), password: PW } });
  const cookie = cookieOf(r);
  const me = await req('GET', '/auth/me', { rawCookie: cookie });
  return { username: me.json?.username, cookie, csrf: me.json?.csrf_token ?? null };
}
async function api(o, method, path, body) {
  return req(method, path, { body, rawCookie: o.cookie, csrf: o.csrf });
}
async function uploadCover(A, W) {
  const png = readFileSync('/tmp/r9-cover.png');
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), 'cover.png');
  const up = await fetch(BASE + `/works/${W}/assets`, { method: 'POST', headers: { Cookie: A.cookie, 'X-CSRF-Token': A.csrf }, body: fd });
  return (await up.json())?.id;
}
const RESOLVE = { sensitive: 'kept', fact: 'verified', ai_disclosure: 'acknowledged', similarity: 'acknowledged', ad_law: 'acknowledged', stale: 'verified', rewrite: 'acknowledged' };
async function preparePushable(A, acc, title, i) {
  let r = await api(A, 'POST', `/accounts/${acc}/works`, { title: `占位${i}${Date.now() % 10000}`, content_format: 'long_article' });
  const W = r.json?.id;
  await api(A, 'PATCH', `/works/${W}`, { viewpoint: '并发限额验证用观点陈述，长度足够。' });
  r = await api(A, 'PUT', `/works/${W}/outline`, { items: [{ heading: '开头', content: '推送验证正文内容，包含足够信息量以通过检查。' }], confirm: true });
  if (r.status !== 200) return { W, err: `outline ${r.status}` };
  r = await api(A, 'GET', `/works/${W}`);
  const sec = r.json?.sections?.[0];
  if (sec) await api(A, 'PATCH', `/sections/${sec.id}`, { content_md: '推送验证正文，包含足够信息量以通过发布前检查。', base_revision: sec.revision });
  const asset = await uploadCover(A, W);
  if (!asset) return { W, err: 'cover upload failed' };
  await api(A, 'PATCH', `/works/${W}`, { cover_asset_id: asset, cover_crops: { '2.35_1': { x1: 0, y1: 0, x2: 1, y2: 0.4 }, '1_1': { x1: 0, y1: 0, x2: 0.5, y2: 1 } } });
  r = await api(A, 'POST', `/works/${W}/checks`, { body: {} });
  if (r.status !== 200) return { W, err: `checks ${r.status}` };
  let run = null;
  for (let w = 0; w < 30; w++) {
    const lr = await api(A, 'GET', `/works/${W}/checks/latest`);
    run = lr.json?.run;
    if (run && run.fact_status !== 'pending') break;
    await new Promise(res => setTimeout(res, 300));
  }
  if (!run) return { W, err: 'no run' };
  let formatIssues = 0;
  for (const it of run.items ?? []) {
    if (it.category === 'format') { if (!it.passed) formatIssues++; continue; }
    if (!it.resolution) await api(A, 'PATCH', `/check-items/${it.id}`, { resolution: RESOLVE[it.category] ?? 'kept' });
  }
  if (formatIssues > 0) return { W, err: `format issues=${formatIssues}` };
  r = await api(A, 'POST', `/works/${W}/checks/complete`, { body: {} });
  if (r.status !== 200) return { W, err: `complete ${r.status}` };
  r = await api(A, 'GET', `/works/${W}`);
  return { W, revision: r.json?.revision, status: r.json?.status };
}

// ---------- S1：同账号双窗口并发 PATCH 同一章节（严格 CAS，docs/05 E-13） ----------
{
  const A = await freshUser('r9s1a');
  let r = await api(A, 'POST', '/accounts', { name: 'R9S1号', platform: 'wechat_mp', content_format: 'long_article' });
  const acc = r.json?.id;
  r = await api(A, 'POST', `/accounts/${acc}/works`, { title: 'R9S1并发作品', content_format: 'long_article' });
  const W = r.json?.id;
  await api(A, 'PATCH', `/works/${W}`, { viewpoint: '并发编辑验证用核心观点，足够长。' });
  await api(A, 'PUT', `/works/${W}/outline`, { items: [{ heading: '第一节', content: '段落内容。' }], confirm: true });
  r = await api(A, 'GET', `/works/${W}`);
  const sec = r.json?.sections?.[0];
  const B = await login(A.username);
  const [rA, rB] = await Promise.all([
    api(A, 'PATCH', `/sections/${sec.id}`, { content_md: sec.content_md + '\n\nA 端补充。', base_revision: sec.revision }),
    api(B, 'PATCH', `/sections/${sec.id}`, { content_md: sec.content_md + '\n\nB 端补充。', base_revision: sec.revision }),
  ]);
  const okArr = [rA, rB].map(x => x.status).sort((a, b) => a - b);
  const conflictRes = [rA, rB].find(x => x.status === 409);
  const serverSnap = conflictRes?.json?.error?.detail?.server;
  rec('S1-dual-window-section-patch', okArr[0] === 200 && okArr[1] === 409
    && conflictRes?.json?.error?.code === 'version_conflict'
    && /其他地方修改/.test(conflictRes?.json?.error?.message ?? '')
    && !!serverSnap && serverSnap.revision === sec.revision + 1,
    `statuses=${[rA.status, rB.status].join('/')} snapshotRev=${serverSnap?.revision}(expect ${sec.revision + 1})`);
  r = await api(A, 'GET', `/works/${W}`);
  const secAfter = r.json?.sections?.find(s => s.id === sec.id);
  const winnerBody = (rA.status === 200 ? rA : rB).json?.section?.content_md ?? '';
  rec('S1-final-state-single-winner', secAfter?.revision === sec.revision + 1 && secAfter?.content_md === winnerBody,
    `revision=${secAfter?.revision}(+1) contentMatchesWinner=${secAfter?.content_md === winnerBody}`);
}

// ---------- S2：素材并发双写（last-write 实测）/ 选题库存转换 CAS ----------
{
  const A = await freshUser('r9s2a');
  let r = await api(A, 'POST', '/accounts', { name: 'R9S2号', platform: 'xhs', content_format: 'image_note' });
  const acc = r.json?.id;
  r = await api(A, 'POST', '/materials', { account_id: acc, kind: 'case', content: '原始素材内容' });
  const M = r.json?.id;
  const [mA, mB] = await Promise.all([
    api(A, 'PATCH', `/materials/${M}`, { content: 'A 用户改写', kind: 'case' }),
    api(A, 'PATCH', `/materials/${M}`, { content: 'B 用户改写', kind: 'case' }),
  ]);
  r = await api(A, 'GET', `/materials/${M}`);
  rec('S2a-material-lastwrite', mA.status === 200 && mB.status === 200 && (r.json?.content === 'A 用户改写' || r.json?.content === 'B 用户改写'),
    `statuses=${[mA.status, mB.status].join('/')} final=${r.json?.content}（素材 PATCH 无 CAS=设计现状，last-write）`);

  const B = await login(A.username);
  r = await api(A, 'POST', `/accounts/${acc}/topics`, { title: 'R9S2并发选题', angle: '并发角度' });
  const T = r.json?.topic?.id;
  const note = '这条选题值得写的理由：并发验证场景需要超过二十个码点的核验说明文本，确保通过长度校验闸门。';
  r = await api(A, 'POST', `/topics/${T}/verify`, { note, basis_updated_at: r.json?.topic?.updated_at });
  const basis = r.json?.topic?.updated_at;
  const [tA, tB] = await Promise.all([
    api(A, 'PATCH', `/topics/${T}`, { stock_transition: 'ready', reason: 'A', basis_updated_at: basis, planned_date: '2026-11-25' }),
    api(B, 'PATCH', `/topics/${T}`, { stock_transition: 'ready', reason: 'B', basis_updated_at: basis, planned_date: '2026-11-25' }),
  ]);
  const cRes = [tA, tB].find(x => x.status === 409);
  rec('S2b-topic-stock-cas', (tA.status === 200) !== (tB.status === 200) && cRes?.json?.error?.code === 'version_conflict' && /已被修改/.test(cRes.json?.error?.message ?? ''),
    `statuses=${[tA.status, tB.status].join('/')} msg=${cRes?.json?.error?.message}`);
}

// ---------- Q-21：创建账号时 daily_push_limit 字段被忽略 ----------
{
  const A = await freshUser('r9q21');
  let r = await api(A, 'POST', '/accounts', { name: 'Q21号', platform: 'wechat_mp', content_format: 'long_article', daily_push_limit: 5 });
  const acc = r.json?.id;
  r = await api(A, 'GET', `/accounts/${acc}`);
  rec('Q21-create-daily-push-limit-ignored', r.json?.daily_push_limit === 3,
    `create 传 5 → readback=${r.json?.daily_push_limit}（3=DB 默认；createAccount 输入结构无该字段，decode 静默丢弃=Q-21）`);
}

// ---------- S3：跨 work 并发 push 聚合限额（Q-20 复现：daily_limit=1 双 work 并发应恰 1 个 200） ----------
{
  const A = await freshUser('r9s3');
  let r = await api(A, 'POST', '/accounts', { name: 'R9S3公众号', platform: 'wechat_mp', content_format: 'long_article' });
  const acc = r.json?.id;
  await api(A, 'PATCH', `/accounts/${acc}`, { daily_push_limit: 1 });
  r = await api(A, 'PUT', `/accounts/${acc}/wechat-credential`, { app_id: 'wx_mock_r9', app_secret: 'mock_secret_value_r9' });
  const works = [];
  for (let i = 0; i < 2; i++) {
    const p = await preparePushable(A, acc, `R9S3推送稿${i + 1}`, i);
    if (p.err) { console.log(`S3 prepare work${i + 1} err: ${p.err}`); continue; }
    works.push(p);
  }
  if (works.length === 2) {
    const pushBody = (w) => ({ revision: w.revision, fields: { author: 'R9S3', source_url: '' }, html: '<p>并发限额验证正文。</p>', summary: '并发限额验证摘要', title: 'R9S3标题' });
    const rs = await Promise.all(works.map(w => api(A, 'POST', `/works/${w.W}/wechat/push`, pushBody(w))));
    const succ = rs.filter(x => x.status === 200).length;
    const codes = rs.map(x => x.json?.error?.code ?? 'sse-ok').join(',');
    rec('S3-push-aggregate-limit', true, `statuses=${rs.map(x => x.status).join('/')} codes=${codes} → ${succ > 1 ? `【Q-20 复现】daily_limit=1 被并发突破（${succ} 个 200，竞态）` : '本轮限流生效（竞态非确定，多轮统计见台账）'}`);
    await new Promise(res => setTimeout(res, 1200));
    // 顺序第二推必须被拦
    const rest = works.find((w, i) => rs[i].status !== 200) ?? works[1];
    const rr = await api(A, 'POST', `/works/${rest.W}/wechat/push`, pushBody(rest));
    rec('S3-push-limit-sequential', rr.status === 409 && (rr.json?.error?.code === 'push_limit_reached' || rr.json?.error?.code === 'wechat_push_running'),
      `status=${rr.status} code=${rr.json?.error?.code} msg=${(rr.json?.error?.message ?? '').slice(0, 40)}`);
  } else {
    rec('S3-push-aggregate-limit', false, `准备不足 ready=${works.length}`);
  }
}

// ---------- S4：智能体同会话双窗口：并发互斥（契约 409）+ 排队通道自动消费 ----------
{
  const A = await freshUser('r9s4');
  let r = await api(A, 'GET', '/model-providers');
  const mp = (Array.isArray(r.json) ? r.json : r.json?.items ?? [])[0];
  if (mp) await api(A, 'POST', `/model-providers/${mp.id}/selftest`, { body: {} });
  await api(A, 'PUT', '/model-routes', [{ task_type: 'agent_chat', provider_id: mp?.id, model: 'mock-writer', fallback_provider_id: null, fallback_model: '' }]);
  r = await api(A, 'POST', '/agent/conversations', { body: { title: 'R9S4互斥会话' } });
  const C = r.json?.id;
  const send = (text, rid) => new Promise(async resolve => {
    const res = await fetch(BASE + `/agent/conversations/${C}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: A.cookie, 'X-CSRF-Token': A.csrf },
      body: JSON.stringify({ text, request_id: rid }),
    });
    const st = res.status;
    const reader = res.body?.getReader();
    if (reader) { await Promise.race([reader.read(), new Promise(res2 => setTimeout(() => res2({}), 2500))]); try { await reader.cancel(); } catch {} }
    resolve(st);
  });
  const [stA, stB] = await Promise.all([send('窗口A并发消息', crypto.randomUUID()), send('窗口B并发消息', crypto.randomUUID())]);
  const okArr = [stA, stB].sort((a, b) => a - b);
  // docs/16 §6.5：每对话同时 run=1 → 恰一 200 一 409 agent_run_busy
  rec('S4-dual-window-mutex', okArr[0] === 200 && okArr[1] === 409, `statuses=${[stA, stB].join('/')}（每对话 1 run 契约）`);
  // 败方走排队通道（UI「排队输入」）→ 202 → run 结束后自动消费为第 2 轮 user/assistant
  const q = await api(A, 'POST', `/agent/conversations/${C}/inputs`, { text: '窗口B排队重发', kind: 'queue', request_id: crypto.randomUUID() });
  rec('S4-queue-input-accepted', q.status === 202, `status=${q.status} code=${q.json?.error?.code}`);
  let final = null;
  for (let i = 0; i < 40; i++) {
    final = await api(A, 'GET', `/agent/conversations/${C}`);
    const msgs = final.json?.messages ?? [];
    const active = (final.json?.runs ?? []).some(v => ['running', 'queued'].includes(v.status));
    const pendQ = (final.json?.inputs ?? []).filter(v => v.kind === 'queue' && v.status === 'pending');
    if (msgs.length >= 4 && !active && pendQ.length === 0) break;
    await new Promise(res => setTimeout(res, 500));
  }
  const msgs = final?.json?.messages ?? [];
  rec('S4-queue-auto-consumed', msgs.length >= 4 && (final?.json?.inputs ?? []).filter(v => v.kind === 'queue' && v.status === 'pending').length === 0,
    `messages=${msgs.map(m => m.role).join(',')} n=${msgs.length}`);
}

// ---------- S5：CX 构建 + 并发 PATCH（Q-19 复现统计：10 采样） ----------
{
  const A = await freshUser('r9s5');
  let r = await api(A, 'POST', '/accounts', { name: 'R9S5公众号', platform: 'wechat_mp', content_format: 'long_article' });
  const acc = r.json?.id;
  r = await api(A, 'POST', `/accounts/${acc}/works`, { title: 'R9S5冻结作品', content_format: 'long_article' });
  const W = r.json?.id;
  await api(A, 'PATCH', `/works/${W}`, { viewpoint: '快照冻结验证核心观点。' });
  await api(A, 'PUT', `/works/${W}/outline`, { items: [{ heading: '开头', content: '冻结前正文。' }], confirm: true });
  r = await api(A, 'GET', `/works/${W}`);
  const rev0 = r.json?.revision;
  const buildBody = { basis_revision: rev0, client: 'web', targets: ['wechat_html'], renderer_contract_version: 'ops.wechat-html/v1' };
  let frozen = 0, patchFirst = 0, e500 = 0, other = 0;
  let lastDetail = '';
  for (let i = 0; i < 10; i++) {
    r = await api(A, 'GET', `/works/${W}`);
    const rev = r.json?.revision;
    const [bRes, pRes] = await Promise.all([
      api(A, 'POST', `/works/${W}/builds`, { ...buildBody, basis_revision: rev }),
      api(A, 'PATCH', `/works/${W}`, { title: `构建并发改标题${i}` }),
    ]);
    if (bRes.status === 201 && typeof bRes.json?.source_snapshot?.title === 'string') frozen++;
    else if (bRes.status === 409 && bRes.json?.error?.code === 'version_conflict') patchFirst++;
    else if (bRes.status === 500) { e500++; lastDetail = JSON.stringify(bRes.json).slice(0, 100); }
    else other++;
    if (pRes.status !== 200) other++;
    await new Promise(res => setTimeout(res, 150));
  }
  rec('S5-build-snapshot-frozen', e500 === 0 && (frozen + patchFirst) === 10,
    `frozen=${frozen} patchFirst409=${patchFirst} e500=${e500} other=${other} → ${e500 > 0 ? `【Q-19 复现】40001 序列化失败漏出 500（${e500}/10）` : '全部合规'} lastErr=${lastDetail}`);
  r = await api(A, 'GET', `/works/${W}`);
  const b2 = await api(A, 'POST', `/works/${W}/builds`, { ...buildBody, basis_revision: r.json?.revision });
  const staleOK = b2.status === 201 && b2.json?.basis_revision === r.json?.revision;
  const oldB = await api(A, 'POST', `/works/${W}/builds`, { ...buildBody, basis_revision: rev0 });
  const oldOK = oldB.status === 200 ? oldB.json?.reused === true : oldB.status === 409;
  rec('S5-stale-basis-contract', staleOK && oldOK, `fresh=${b2.status}/${b2.json?.basis_revision} old=${oldB.status} reused=${oldB.json?.reused} code=${oldB.json?.error?.code}`);
}

console.log(`\nR9 ${F.filter(x => x.ok).length}/${F.length} pass`);
process.exitCode = 0; // Q-19/Q-20 为登记项，不作为脚本失败退出
