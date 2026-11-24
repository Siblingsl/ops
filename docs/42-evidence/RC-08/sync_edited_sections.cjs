'use strict';
// 将人工清理过占位符的 Markdown 回写到产品作品，保证桌面端看到同一份真稿。
const fs = require('node:fs');
const path = require('node:path');
const { request, me } = require('../../../desktop/scripts/rc05-api.cjs');

const OUT = path.join(__dirname, 'writing-real');
const TARGETS = [
  { key: 'wc-01', work: '8327d05e-7e29-4ddb-aa45-0fc6b8227071' },
  { key: 'xhs-01', work: 'bac3ed83-2738-4e11-a0d5-3b50ba01ca3d' },
  { key: 'xhs-04', work: 'ccc9ba68-e7a8-408c-830d-d6e196cc7fd5' },
];

function parseMd(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return raw.split(/^## /m).slice(1).map((block) => {
    const nl = block.indexOf('\n');
    return { heading: block.slice(0, nl).trim(), content: block.slice(nl + 1).trim() };
  });
}

(async () => {
  const m = await me();
  const csrf = m.csrf_token;
  for (const target of TARGETS) {
    const wanted = parseMd(path.join(OUT, `${target.key}.md`));
    const session = await me();
    const csrf = session.csrf_token;
    let work = (await request('GET', `/works/${target.work}`)).json;
    if (target.ensure && (work.sections || []).length < wanted.length) {
      const created = await request('POST', `/works/${target.work}/sections`, { heading: target.ensure }, { csrf });
      if (created.status !== 200) throw new Error(`create section ${target.key}: ${created.status} ${created.text.slice(0, 200)}`);
      work = (await request('GET', `/works/${target.work}`)).json;
    }
    const sections = work.sections || [];
    if (sections.length !== wanted.length) throw new Error(`${target.key} 段数不一致：产品 ${sections.length} / 文稿 ${wanted.length}`);
    for (let i = 0; i < sections.length; i++) {
      const body = {
        heading: wanted[i].heading,
        content_md: wanted[i].content,
        base_revision: sections[i].revision,
      };
      const r = await request('PATCH', `/sections/${sections[i].id}`, { csrf, body });
      if (r.status !== 200) throw new Error(`patch ${target.key} 段 ${i + 1}: ${r.status} ${r.text.slice(0, 300)}`);
      console.log(`${target.key} 段 ${i + 1} 已回写`);
    }
  }
  console.log('SYNC_OK');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
