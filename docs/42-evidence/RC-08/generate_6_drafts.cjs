'use strict';
// RC-08 真稿生成器：全部走产品 API（作品→观点→大纲→确认→逐段起草），模型为当前工作区真实供应商。
// 不写死密钥；复用桌面会话 cookie。产物写入 docs/42-evidence/RC-08/writing-real/。
const fs = require('node:fs');
const path = require('node:path');

const BASE = 'http://127.0.0.1:8080/api/v1';
const COOKIE_FILE = path.resolve(__dirname, '..', '..', '..', '.tmp-walkthrough', 'rc05-cookies.json');
const OUT = path.join(__dirname, 'writing-real');
const WC = 'bf07850c-7cfc-4b8b-b112-6ebc6eb00c4b';
const XHS = '6c320a1b-b6f1-4897-b39f-13b12e854271';

const ITEMS = [
  {
    key: 'wc-01', account: WC, format: 'long_article', platform: 'wechat',
    title: '把读书会从“打卡”变回“聊天”：我们试了三个月',
    viewpoint: '读书会的价值不在读完多少本，而在于让人敢说出没读懂的地方。',
  },
  {
    key: 'wc-02', account: WC, format: 'long_article', platform: 'wechat',
    title: '一周只读二十页，为什么反而记得住',
    viewpoint: '限制阅读量不是偷懒，是给注意力留出复述和联想的时间。',
  },
  {
    key: 'wc-03', account: WC, format: 'long_article', platform: 'wechat',
    title: '在青岛办一场海边读书会，需要准备什么',
    viewpoint: '海边读书会真正难的不是选景，而是让每个人都能开口；准备清单要围绕这一点。',
  },
  {
    key: 'xhs-01', account: XHS, format: 'image_note', platform: 'xiaohongshu',
    title: '青岛周末一个人也能去的3个读书角落',
    viewpoint: '一个人读书不需要仪式感，只需要一个不赶人的座位和一段固定的时间。',
  },
  {
    key: 'xhs-02', account: XHS, format: 'image_note', platform: 'xiaohongshu',
    title: '打工人重启阅读：每天10页的笨办法',
    viewpoint: '重启阅读靠的是把门槛降到不可能失败，而不是买更多书。',
  },
  {
    key: 'xhs-03', account: XHS, format: 'image_note', platform: 'xiaohongshu',
    title: '海边读书会清单｜不晒不累，坐一下午',
    viewpoint: '海边读书会要舒服，关键是防晒、坐垫和少带东西，不是布置得多好看。',
  },
  {
    key: 'xhs-04', account: XHS, format: 'image_note', platform: 'xiaohongshu',
    title: '在青岛找读书角落，我只看这三件事',
    viewpoint: '选读书角落不用追网红店，只看三件事：不赶人、能背风、光线不反光；具体去哪以现场为准。',
  },
];

const cookies = fs.readFileSync(COOKIE_FILE, 'utf8');
const ONLY = process.env.ONLY ? process.env.ONLY.split(',').map((s) => s.trim()).filter(Boolean) : null;
function cookieHeader() {
  return JSON.parse(cookies).map((c) => `${c.name}=${c.value}`).join('; ');
}

async function req(method, route, body, csrf, extra = {}) {
  const headers = { Cookie: cookieHeader(), ...(extra.headers || {}) };
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

async function me() {
  const r = await req('GET', '/auth/me');
  if (r.status !== 200) throw new Error(`auth/me ${r.status}`);
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
  if (!response.ok) throw new Error(`draft ${sectionId} HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = null;
  for (;;) {
    const { value, done: streamDone } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop();
    for (const block of blocks) {
      let event = 'message';
      const dataLines = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      let payload = null;
      try { payload = JSON.parse(dataLines.join('\n')); } catch { continue; }
      if (event === 'error') throw new Error(`draft ${sectionId} error: ${JSON.stringify(payload).slice(0, 500)}`);
      if (event === 'done') { done = payload; break; }
    }
    if (done || streamDone) break;
  }
  if (!done) throw new Error(`draft ${sectionId} 未收到 done 事件`);
  return done;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function retry(label, fn, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (!/429|rate_limited|限流|额度/.test(String(e.message)) || i === attempts - 1) throw e;
      const wait = 60000 * (i + 1);
      console.log(`  ${label} 限流，${wait / 1000}s 后重试（${i + 1}/${attempts}）`);
      await sleep(wait);
    }
  }
  throw last;
}
function expectOk(r, label) {
  if (r.status !== 200) throw new Error(`${label} ${r.status} ${r.text.slice(0, 300)}`);
  return r;
}

function sectionText(s) { return s.content_md || s.content || ''; }

function mdWork(item, work) {
  const body = (work.sections || []).map((s) => `## ${s.heading || s.title}\n\n${sectionText(s).trim()}`).join('\n\n');
  return `# ${work.title}\n\n- 平台：${item.platform === 'wechat' ? '公众号' : '小红书'}\n- 作品 ID：${work.id}\n- 核心观点：${work.viewpoint}\n- 模型：workbuddy-ai/hy4flash-free\n\n${body}\n`;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const m = await me();
  const csrf = m.csrf_token;
  const results = [];
  for (const item of ITEMS.filter((it) => !ONLY || ONLY.includes(it.key))) {
    console.log(`\n[${item.key}] ${item.title}`);
    const list = await req('GET', `/accounts/${item.account}/works`);
    if (list.status !== 200) throw new Error(`list works ${item.key}: ${list.status}`);
    const existing = (list.json || []).find((w) => w.title === item.title);
    let wid;
    let sections = [];
    if (existing) {
      wid = existing.id;
      console.log(`  resume ${wid}`);
      const detail = expectOk(await req('GET', `/works/${wid}`), 'get existing work').json;
      sections = detail.sections || [];
      if (sections.length) console.log(`  已有 ${sections.filter((s) => sectionText(s).length > 0).length}/${sections.length} 段，续写空段`);
    } else {
      const created = expectOk(await req('POST', `/accounts/${item.account}/works`, {
        title: item.title, content_format: item.format,
      }, csrf), `create ${item.key}`);
      wid = created.json.id;
    }

    expectOk(await req('PATCH', `/works/${wid}`, { viewpoint: item.viewpoint }, csrf), `viewpoint ${item.key}`);

    if (!sections.length) {
      console.log('  outline...');
      const outline = await retry('outline', async () => expectOk(
        await req('POST', `/works/${wid}/outline/generate`, undefined, csrf), `outline ${item.key}`));
      const items = (outline.json.items || []).slice(0, item.platform === 'wechat' ? 4 : 3);
      if (!items.length) throw new Error(`outline ${item.key} 无 items`);
      const saved = expectOk(await req('PUT', `/works/${wid}/outline`, { items, confirm: true }, csrf),
        `save outline ${item.key}`);
      sections = saved.json.sections || [];
      await sleep(15000);
    }

    for (let i = 0; i < sections.length; i++) {
      if (sectionText(sections[i]).length > 0) continue;
      console.log(`  draft ${i + 1}/${sections.length}...`);
      await retry(`draft ${i + 1}`, () => sseDraft(sections[i].id, csrf));
      await sleep(15000);
    }

    const final = expectOk(await req('GET', `/works/${wid}`), `get work ${item.key}`);
    const finalWork = final.json;
    fs.writeFileSync(path.join(OUT, `${item.key}.md`), mdWork(item, finalWork), 'utf8');
    results.push({
      key: item.key, work_id: wid, title: finalWork.title, platform: item.platform,
      sections: (finalWork.sections || []).map((s) => ({ id: s.id, title: s.heading || s.title, chars: sectionText(s).length })),
      total_chars: (finalWork.sections || []).reduce((n, s) => n + sectionText(s).length, 0),
    });
    console.log(`  done ${item.key}: ${results[results.length - 1].total_chars} 字`);
  }
  const worksFile = path.join(OUT, 'works.json');
  let history = [];
  if (fs.existsSync(worksFile)) {
    try { history = JSON.parse(fs.readFileSync(worksFile, 'utf8')); } catch { history = []; }
  }
  const merged = history.filter((h) => !results.some((r) => r.key === h.key)).concat(results);
  fs.writeFileSync(worksFile, JSON.stringify(merged, null, 2), 'utf8');
  console.log('\nALL DONE', results.map((r) => `${r.key}:${r.total_chars}`).join(' '));
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
