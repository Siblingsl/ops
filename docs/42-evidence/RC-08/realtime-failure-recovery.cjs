'use strict';
// RC-08 真实 429 与切模型恢复：全部走产品 API。
// 1) 临时作品 + 静态大纲；2) section_draft 指向当前 429 的 OpenCode；3) 起稿得到真实错误；
// 4) 切回 WorkBuddy；5) 同一段重试成功。最后恢复原始 routes。
const fs = require('node:fs');
const path = require('node:path');

const BASE = 'http://127.0.0.1:8080/api/v1';
const COOKIE_FILE = path.resolve(__dirname, '..', '..', '..', '.tmp-walkthrough', 'rc05-cookies.json');
const OUT = path.join(__dirname, 'realtime-failure-recovery.json');
const WC = 'bf07850c-7cfc-4b8b-b112-6ebc6eb00c4b';
const OPENCODE = '017ee409-0282-4a01-a102-1e911bbbe80f';
const WORKBUDDY = '9bf53a15-005e-4eef-ab9e-e6ad7e9c7f1a';
const OPENCODE_MODEL = 'opencode-zen-free/deepseek-v4.1-flash-free';
const WORKBUDDY_MODEL = 'workbuddy-ai/hy4flash-free';

const cookies = fs.readFileSync(COOKIE_FILE, 'utf8');
const cookieHeader = () => JSON.parse(cookies).map((c) => `${c.name}=${c.value}`).join('; ');

async function req(method, route, body, csrf) {
  const headers = { Cookie: cookieHeader() };
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(BASE + route, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, json, text };
}
function expectOk(r, label) {
  if (r.status !== 200) throw new Error(`${label} HTTP ${r.status}: ${r.text.slice(0, 400)}`);
  return r.json;
}

async function sseDraft(sectionId, csrf) {
  const response = await fetch(`${BASE}/sections/${sectionId}/draft`, {
    method: 'POST',
    headers: {
      Cookie: cookieHeader(), 'X-CSRF-Token': csrf,
      'Content-Type': 'application/json', Accept: 'text/event-stream',
    },
    body: '{}',
  });
  const raw = await response.text();
  const events = [];
  for (const block of raw.split('\n\n')) {
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (!data.length) continue;
    let payload;
    try { payload = JSON.parse(data.join('\n')); } catch { continue; }
    events.push({ event, payload });
  }
  return { status: response.status, events, raw: raw.slice(0, 4000) };
}

function routeBody(routes) {
  return routes.map((r) => ({
    task_type: r.task_type,
    provider_id: r.provider_id || null,
    model: r.model || '',
    fallback_provider_id: r.fallback_provider_id || null,
    fallback_model: r.fallback_model || '',
  }));
}
async function setDraftRoute(routes, provider, model, csrf) {
  const body = routeBody(routes);
  const draft = body.find((r) => r.task_type === 'section_draft');
  draft.provider_id = provider;
  draft.model = model;
  draft.fallback_provider_id = null;
  draft.fallback_model = '';
  expectOk(await req('PUT', '/model-routes', body, csrf), 'set section_draft route');
  return body;
}

(async () => {
  const me = expectOk(await req('GET', '/auth/me'), 'auth/me');
  const csrf = me.csrf_token;
  const originalRoutes = expectOk(await req('GET', '/model-routes'), 'get routes');
  let workId = null;
  const result = {
    at: new Date().toISOString(),
    model_before: 'workbuddy-ai/hy4flash-free',
    model_failing: 'opencode-zen-free/deepseek-v4.1-flash-free',
    note: '真实第三方网关上游；失败由 OpenCode 免费额度 429 触发；恢复由同一产品段落在 WorkBuddy 上重试成功。',
  };
  try {
    const created = expectOk(await req('POST', `/accounts/${WC}/works`, {
      title: 'RC-08 真实 429 恢复验证（临时）', content_format: 'long_article',
    }, csrf), 'create work');
    workId = created.id;
    expectOk(await req('PATCH', `/works/${workId}`, {
      viewpoint: '限流不是写作失败，桌面端应给出可读原因，并在切换可用模型后继续。',
    }, csrf), 'set viewpoint');
    const saved = expectOk(await req('PUT', `/works/${workId}/outline`, {
      items: [{ heading: '真实 429 与切模型恢复', key_point: '先失败，再切换到可用模型完成同一段。', material_ids: [] }],
      confirm: true,
    }, csrf), 'save outline');
    const sectionId = (saved.sections || [])[0] && saved.sections[0].id;
    if (!sectionId) throw new Error('outline 未生成 section');
    result.work_id = workId;
    result.section_id = sectionId;

    await setDraftRoute(originalRoutes, OPENCODE, OPENCODE_MODEL, csrf);
    const failed = await sseDraft(sectionId, csrf);
    result.failure = {
      http_status: failed.status,
      events: failed.events.map((e) => ({
        event: e.event,
        code: e.payload && e.payload.code,
        message: e.payload && e.payload.message,
      })),
      raw_head: failed.raw,
    };
    if (!failed.events.some((e) => e.event === 'error')) throw new Error('OpenCode 未返回错误，无法形成真实 429 证据');

    await setDraftRoute(originalRoutes, WORKBUDDY, WORKBUDDY_MODEL, csrf);
    const recovered = await sseDraft(sectionId, csrf);
    const done = recovered.events.find((e) => e.event === 'done');
    result.recovery = {
      http_status: recovered.status,
      has_done: !!done,
      done: done ? done.payload : null,
    };
    const detail = expectOk(await req('GET', `/works/${workId}`), 'get recoved work');
    const section = (detail.sections || [])[0] || {};
    result.recovery.section_chars = (section.content_md || section.content || '').length;
    if (!done || result.recovery.section_chars <= 0) throw new Error('切回 WorkBuddy 后未生成正文');
    result.verdict = 'PASS：真实 429 可读错误 + 切回可用模型同段落重试成功';
  } catch (error) {
    result.error = String(error && error.message || error);
    result.verdict = 'FAIL';
  } finally {
    try {
      expectOk(await req('PUT', '/model-routes', routeBody(originalRoutes), csrf), 'restore routes');
      result.routes_restored = true;
    } catch (error) {
      result.routes_restored = false;
      result.restore_error = String(error && error.message || error);
    }
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
    if (workId) result.work_id = workId;
  }
  console.log(JSON.stringify(result, null, 2));
  if (!String(result.verdict).startsWith('PASS') || result.routes_restored !== true) process.exit(1);
})().catch((error) => { console.error(error); process.exit(1); });
