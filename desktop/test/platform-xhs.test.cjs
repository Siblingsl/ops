const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  attachNoteBodies,
  collectPostedNotes,
  commentDedupeId,
  extractShareURL,
  mapNoteStatus,
  mapNoteType,
  noteIDFromURL,
  noteToObservation,
  parseCommentFacts,
  parseCount,
  parseIdentity,
  parseNoteBody,
  parsePostedNotesPage,
  probeCapabilities,
  probeNoteContent,
  probePostedNotesCapabilities,
  probePostedNotesReadable,
  readCommentFacts,
  readNoteBody,
  resolveShareLink,
  stripSessionParams,
  toCommentResult,
  verifyNoteAuthor,
  XHS_ADAPTER_VERSION,
  XHS_API,
  XHS_COMMENT_FACT_SCHEMA,
  XhsAdapterError
} = require('../.build/platforms/xhs.js');

// 全部为虚构样本：编号是十六进制占位，标题与计数均为编造值。
const noteA = {
  id: '6f0000000000000000000001',
  display_title: '虚构样本：通勤路上的三件小事',
  time: '2026-10-18 09:12',
  type: 'normal',
  tab_status: 'published',
  view_count: 177,
  likes: 2,
  collected_count: 5,
  comments_count: 1,
  shared_count: 0
};
const noteB = {
  id: '6f0000000000000000000002',
  display_title: '虚构样本：视频笔记',
  time: '2026-10-19 20:00',
  type: 'video',
  tab_status: 'published',
  view_count: 320,
  likes: 0,
  collected_count: null,
  comments_count: null,
  shared_count: null
};

function page(notes, extra = {}) {
  return { success: true, data: { notes, page: -1, ...extra } };
}

test('身份解析必须有稳定 userId，昵称不能代替', () => {
  const id = parseIdentity({ data: { userId: 'fixture-self', redId: 'fx_1001', nickname: '虚构昵称' } });
  assert.equal(id.externalAccountKey, 'xhs_user_id:fixture-self');
  assert.equal(id.redId, 'fx_1001');
  assert.throws(() => parseIdentity({ data: { nickname: '只有昵称' } }), (e) => e.code === 'platform_identity_mismatch');
  assert.throws(() => parseIdentity({}), (e) => e.code === 'platform_login_required');
});

test('PS-T03：主站登录但创作中心未登录时只报告可读范围', () => {
  const caps = probeCapabilities({
    mainSiteLoggedIn: true, identity: null, postedNotesReadable: false, followerInfoReadable: false,
    now: '2026-10-20T10:00:00Z'
  });
  assert.equal(caps.mainSiteLogin, 'supported');
  assert.equal(caps.creatorLogin, 'denied');
  // 没有创作中心能力时不能声称能读作品或单篇指标。
  assert.equal(caps.workList, 'unknown');
  assert.equal(caps.perNoteMetrics, 'unknown');
  // 单篇曝光首版不承诺。
  assert.equal(caps.noteImpressions, 'unknown');
  assert.equal(caps.adapterVersion, XHS_ADAPTER_VERSION);
});

// CF-PS-04：xhs 适配器从未上报 noteContent，服务端 content 阶段因此固定
// content_capability_unverified（21 §十七点六十一 / 3091）。这里锁住「键存在且如实」，
// 防止有人用硬写 supported 冒充已实现正文采集（21 §2939 的凭空宣称能力红线）。
test('CF-PS-04 xhs 能力快照显式上报 noteContent 且不冒充已支持', () => {
  const caps = probeCapabilities({
    mainSiteLoggedIn: true,
    identity: { externalAccountKey: 'xhs_user_id:fixture', redId: 'fixture' },
    postedNotesReadable: true,
    followerInfoReadable: true,
    now: '2026-10-20T10:00:00Z'
  });
  assert.ok(Object.prototype.hasOwnProperty.call(caps, 'noteContent'), 'noteContent 键不得缺失');
  assert.equal(caps.noteContent, 'unknown', '正文采集未实现时不得声称 supported');

  // 跨语言键一致性：服务端 platformSyncCapabilityState 对 xhs content 读的必须仍是这个键。
  const go = fs.readFileSync(path.join(__dirname, '../../server/internal/app/platform_account_sync.go'), 'utf8');
  assert.match(go, /case "content":[\s\S]{0,240}?key = "noteContent"/,
    '服务端 content 键映射必须仍是 noteContent，改一处不改另一处等于永远判不可用');

  // 登录核验链路只覆盖身份/列表/指标，不得把未核验的正文能力带成 supported。
  const runtime = fs.readFileSync(path.join(__dirname, '../src/platform-login-runtime.ts'), 'utf8');
  assert.match(runtime, /noteContent:\s*'unknown'/, '登录核验链路必须显式钉住 unknown');

  // 适配器本身没有正文事实字段；这条断言防止「报了 supported 但根本没采正文」。
  const adapter = fs.readFileSync(path.join(__dirname, '../src/platforms/xhs.ts'), 'utf8');
  assert.ok(!/body_text|bodyText/.test(adapter), '当前适配器未实现正文事实字段，不得声称 supported');
});

// CF-PS-07：单篇正文采集。详情读取由注入的只读源提供，全部为虚构 fixture，
// 不访问真实平台。「缺失」必须是 present:false + 原因码，不能落空串。
const capsInput = {
  mainSiteLoggedIn: true,
  identity: { externalAccountKey: 'xhs_user_id:fixture', redId: 'fixture' },
  postedNotesReadable: true,
  followerInfoReadable: true,
  now: '2026-10-20T10:00:00Z'
};
const detailSource = (payload) => ({
  fetchJSON: async () => { throw new Error('详情读取不得回退到列表 GET'); },
  fetchNoteDetail: async (noteId) => payload(noteId)
});

test('CF-PS-07 有正文：详情确实读到非空正文才把 noteContent 判为 supported', async () => {
  const body = '虚构正文：通勤路上的三件小事。';
  const source = detailSource((noteId) => ({ success: true, data: { note: { id: noteId, desc: body } } }));
  const fact = await readNoteBody(source, noteA.id);
  assert.equal(fact.noteId, noteA.id);
  assert.equal(fact.present, true);
  assert.equal(fact.text, body);
  assert.equal(fact.reason, null);

  const probe = await probeNoteContent(source, noteA.id);
  assert.equal(probe.readable, true);
  const caps = probeCapabilities({ ...capsInput, noteContent: probe });
  assert.equal(caps.noteContent, 'supported');
  assert.equal(caps.noteContentReason, null);

  // 回填逐篇进行：默认只探测第 1 篇，其余保持「尚未读详情」，且不就地改写原数组。
  const notes = parsePostedNotesPage(page([noteA, noteB])).notes;
  assert.equal(notes[0].body.present, false);
  assert.equal(notes[0].body.reason, 'detail_not_read');
  const attached = await attachNoteBodies(source, notes);
  assert.equal(attached[0].body.present, true);
  assert.equal(attached[0].body.text, body);
  assert.equal(attached[1].body.reason, 'detail_not_read');
  assert.equal(notes[0].body.present, false, '不得就地改写调用方的事实数组');

  const all = await attachNoteBodies(source, notes, { maxNotes: 2 });
  assert.equal(all[1].body.present, true, '调用方显式指定篇数时才逐篇读第 2 篇');
});

test('CF-PS-07 无正文：字段缺失与空串都用 present:false 表示，绝不落空串', async () => {
  const missing = parseNoteBody(noteA.id, { success: true, data: { note: { id: noteA.id, title: '只有标题' } } });
  assert.equal(missing.present, false);
  assert.equal(missing.text, null, '字段缺失不得当成空串正文');
  assert.equal(missing.reason, 'body_absent');

  const empty = parseNoteBody(noteA.id, { success: true, data: { note: { id: noteA.id, desc: '   ' } } });
  assert.equal(empty.present, false);
  assert.equal(empty.text, null);
  assert.equal(empty.reason, 'empty_body');

  const noSource = await probeNoteContent({ fetchJSON: async () => ({}) }, noteA.id);
  assert.equal(noSource.readable, false);
  assert.equal(noSource.reason, 'detail_source_missing');
  const caps = probeCapabilities({ ...capsInput, noteContent: noSource });
  assert.equal(caps.noteContent, 'unknown');
  assert.equal(caps.noteContentReason, 'detail_source_missing');
});

test('CF-PS-07 权限不足 / 解析失败：noteContent 保持 unknown 并留原因码', async () => {
  const denied = parseNoteBody(noteA.id, { success: false, code: 403, msg: '无权查看' });
  assert.equal(denied.present, false);
  assert.equal(denied.text, null);
  assert.equal(denied.reason, 'permission_denied');

  const deniedByThrow = await readNoteBody({
    fetchNoteDetail: async () => { throw new XhsAdapterError('platform_login_required', '未登录'); }
  }, noteA.id);
  assert.equal(deniedByThrow.reason, 'permission_denied');

  assert.equal(parseNoteBody(noteA.id, 'not-an-object').reason, 'parse_failed');
  assert.equal(parseNoteBody(noteA.id, { data: { note: { content: { nested: true } } } }).reason, 'parse_failed');

  const failedProbe = await probeNoteContent({
    fetchNoteDetail: async () => { throw new Error('network down'); }
  }, noteA.id);
  assert.equal(failedProbe.readable, false);
  assert.equal(failedProbe.reason, 'read_failed');
  const caps = probeCapabilities({ ...capsInput, noteContent: failedProbe });
  assert.equal(caps.noteContent, 'unknown');
  assert.equal(caps.noteContentReason, 'read_failed');
});

test('CF-PS-07 列表响应不含正文，未做详情探测时能力恒 unknown', () => {
  // 即使列表行里偶然出现 desc，也不采信：列表字段集合不含正文，必须走详情读取。
  const parsed = parsePostedNotesPage(page([{ ...noteA, desc: '列表里的 desc 不算正文' }]));
  assert.equal(parsed.notes[0].body.present, false);
  assert.equal(parsed.notes[0].body.text, null);
  assert.equal(parsed.notes[0].body.reason, 'detail_not_read');
  const caps = probeCapabilities(capsInput);
  assert.equal(caps.noteContent, 'unknown');
  assert.equal(caps.noteContentReason, 'detail_not_read');
});

test('作品列表能力只在签名列表响应结构完整时通过核验', async () => {
  const requested = [];
  const source = {
    fetchJSON: async () => { throw new Error('签名列表不得回退到普通 GET'); },
    fetchSigned: async (path) => { requested.push(path); return page([noteA]); }
  };

  assert.equal(await probePostedNotesReadable(source), true);
  assert.deepEqual(requested, ['/api/galaxy/v2/creator/note/user/posted?page=0&page_size=20']);
});

test('一次签名请求同时核验目录与单篇指标可读，不额外发请求', async () => {
  const requested = [];
  const source = {
    fetchJSON: async () => { throw new Error('签名列表不得回退到普通 GET'); },
    fetchSigned: async (path) => { requested.push(path); return page([noteA]); }
  };
  const probe = await probePostedNotesCapabilities(source);
  assert.equal(probe.listReadable, true);
  // noteA 已发布且带 view/like/collect/comment/share，指标确实可读。
  assert.equal(probe.perNoteMetricsReadable, true);
  assert.equal(requested.length, 1, '目录与指标必须在同一次签名请求里核验');
});

test('整页都没有可解释计数时不声称单篇指标可读', async () => {
  const noCounts = { ...noteA, view_count: null, likes: null, collected_count: null, comments_count: null, shared_count: null };
  const probe = await probePostedNotesCapabilities({ fetchSigned: async () => page([noCounts]) });
  assert.equal(probe.listReadable, true, '列表结构完好，目录仍算可读');
  assert.equal(probe.perNoteMetricsReadable, false, '没有计数就不能声称指标可读');

  // 草稿没有指标，不能拿它当指标可读的证据。
  const draftOnly = { ...noteA, tab_status: 'draft' };
  const draftProbe = await probePostedNotesCapabilities({ fetchSigned: async () => page([draftOnly]) });
  assert.equal(draftProbe.perNoteMetricsReadable, false);
});

test('合法空列表可以证明接口可读，缺列表或包含无效行不能通过能力核验', async () => {
  assert.equal(await probePostedNotesReadable({ fetchSigned: async () => page([]) }), true);
  await assert.rejects(
    () => probePostedNotesReadable({ fetchSigned: async () => ({ success: true, data: {} }) }),
    (error) => error.code === 'platform_schema_changed'
  );
  await assert.rejects(
    () => probePostedNotesReadable({ fetchSigned: async () => page([noteA, { id: 'bad-id' }]) }),
    (error) => error.code === 'platform_schema_changed'
  );
  await assert.rejects(
    () => probePostedNotesReadable({ fetchSigned: async () => ({ success: false }) }),
    (error) => error.code === 'platform_login_required'
  );
  await assert.rejects(
    () => probePostedNotesReadable({ fetchJSON: async () => page([noteA]) }),
    (error) => error.code === 'platform_capability_denied'
  );
});

test('PS-T15/T16：0 保留，缺失与占位为未知，不合理的数值不落成精确值', () => {
  assert.deepEqual(parseCount(0), { value: 0, precision: 'exact' });
  assert.deepEqual(parseCount('0'), { value: 0, precision: 'exact' });
  assert.deepEqual(parseCount(177), { value: 177, precision: 'exact' });
  // 大数写法只能按 rounded 展示。
  assert.deepEqual(parseCount('1.2万'), { value: 12000, precision: 'rounded' });
  for (const unknown of [null, undefined, '', '—', '-', '加载中', 'loading', NaN, Infinity, 1.5, -3, true, {}, '12.5', 'abc']) {
    assert.equal(parseCount(unknown), null, String(unknown));
  }
  assert.equal(parseCount(1e13), null);
});

test('状态与类型映射：未知值保持 unknown，不推断删除', () => {
  assert.equal(mapNoteStatus('published'), 'published');
  assert.equal(mapNoteStatus('draft'), 'draft');
  assert.equal(mapNoteStatus('reviewing'), 'reviewing');
  assert.equal(mapNoteStatus('hidden'), 'hidden');
  assert.equal(mapNoteStatus('deleted'), 'deleted');
  assert.equal(mapNoteStatus('something_new'), 'unknown');
  assert.equal(mapNoteStatus(null), 'unknown');

  // 平台实际返回的是数字：2026-10-21 真实账号实测 tab_status=1 对应“已发布”。
  // 只映射已确认的数值，其它数值保持 unknown，不能猜成已发布。
  assert.equal(mapNoteStatus(1), 'published');
  assert.equal(mapNoteStatus('1'), 'published');
  for (const unknown of [0, 2, 3, 99, '0', '2']) {
    assert.equal(mapNoteStatus(unknown), 'unknown', String(unknown));
  }
  // 非有限数与非数字类型不能崩。
  assert.equal(mapNoteStatus(Number.NaN), 'unknown');
  assert.equal(mapNoteStatus(Infinity), 'unknown');
  assert.equal(mapNoteStatus(true), 'unknown');
  assert.equal(mapNoteStatus({}), 'unknown');

  assert.equal(mapNoteType('normal'), 'image');
  assert.equal(mapNoteType('video'), 'video');
  assert.equal(mapNoteType(0), 'image');
  assert.equal(mapNoteType(1), 'video');
  assert.equal(mapNoteType('other'), 'unknown');
});

test('列表解析：坏行被计数，整页无效时判结构变化而不是“没有作品”', () => {
  const parsed = parsePostedNotesPage(page([noteA, { id: 'bad-id' }, noteB]));
  assert.equal(parsed.notes.length, 2);
  assert.equal(parsed.invalidRows, 1);
  // page:-1 表示没有更多页。
  assert.equal(parsed.page, -1);
  assert.equal(parsed.hasMore, false);

  assert.throws(() => parsePostedNotesPage(page([{ id: 'bad' }])), (e) => e.code === 'platform_schema_changed');
  // 平台明确失败不能用空列表冒充成功。
  assert.throws(() => parsePostedNotesPage({ success: false }), (e) => e.code === 'platform_login_required');
});

test('PS-T14：只有已发布笔记能生成作品观测，草稿与隐藏不产生指标也不改状态', () => {
  const published = noteToObservation({ ...normalize(noteA) }, {
    externalAccountKey: 'xhs_user_id:fixture-self', observedAt: '2026-10-20T10:04:00Z', bindingRevision: 2, publishRevision: 1
  });
  assert.ok(published);
  assert.equal(published.external_id, noteA.id);
  assert.equal(published.source, 'xhs_browser');
  assert.equal(published.temporal_kind, 'cumulative');
  // view_count 单位未知：带 unit=unknown，不冒充次数。
  assert.equal(published.values.view_times.unit, 'unknown');
  assert.equal(published.values.like_count.unit, 'count');
  // 0 必须保留。
  assert.equal(published.values.share_times.value, 0);
  // 缺失字段不出现（而不是 0）：视频样本的 collected/comments/shared 为 null。
  const video = noteToObservation(normalize(noteB), {
    externalAccountKey: 'xhs_user_id:fixture-self', observedAt: '2026-10-20T10:04:00Z'
  });
  assert.ok(video);
  assert.equal(video.values.favorite_count, undefined);
  assert.equal(video.values.comment_count, undefined);
  assert.equal(video.values.share_times, undefined);
  assert.equal(video.values.view_times.unit, 'unknown');
  assert.equal(published.field_paths.view_times, 'fixture.note.view_count');

  for (const status of ['draft', 'reviewing', 'hidden', 'deleted', 'unknown']) {
    const fact = normalize(noteA);
    fact.status = status;
    assert.equal(noteToObservation(fact, { externalAccountKey: 'xhs_user_id:fixture-self', observedAt: '2026-10-20T10:04:00Z' }), null, status);
  }
});

test('PS-T32：分页按 note_id 去重，到页数上限如实报告未完成覆盖', async () => {
  const pages = [
    page([noteA, noteB], { page: 0, cursor: 'c1' }),
    // 第二页重复了 A，并多一条新笔记。
    { success: true, data: { notes: [noteA, { ...noteB, id: '6f0000000000000000000003', view_count: 5 }], cursor: 'c2' } },
    page([noteA], { cursor: null })
  ];
  let index = 0;
  const source = { fetchJSON: async () => pages[Math.min(index++, pages.length - 1)] };
  const result = await collectPostedNotes(source, { maxPages: 2 });
  assert.equal(result.pagesRead, 2);
  assert.equal(result.duplicates, 1);
  assert.equal(result.notes.length, 3);
  assert.equal(result.hasMore, true);
  assert.equal(result.coverage.incomplete_reason, 'page_budget');
  assert.equal(result.coverage.has_more, true);
  // 读取完所有页时不应声称还有下一页。
  index = 0;
  const full = await collectPostedNotes({ fetchJSON: async () => ({ success: true, data: { notes: [noteA], page: -1 } }) }, { maxPages: 3 });
  assert.equal(full.hasMore, false);
  assert.equal(full.coverage.incomplete_reason, null);
});

test('混合有效和无效作品行时目录不能报告完整', async () => {
  const result = await collectPostedNotes({ fetchJSON: async () => page([noteA, { id: 'bad-id' }]) });
  assert.equal(result.notes.length, 1, '保留同页成功解析的作品');
  assert.equal(result.invalidRows, 1);
  assert.equal(result.coverage.incomplete_reason, 'catalog_inconsistent');
  assert.equal(result.enumerationComplete, false);
});

test('PS-T32 加固：平台恒回同一页时按内容重复收口，不空转到页数上限', async () => {
  // 实测小红书只有一页时回 page:-1（已被 hasMore 拦住）。
  // 但若平台忽略 page 参数、恒回同一批且 page>=0，不拦就会重复请求到页数上限。
  let calls = 0;
  const source = {
    fetchJSON: async () => {
      calls += 1;
      // 每一页都声称还有下一页，内容完全相同。
      return { success: true, data: { notes: [noteA, noteB], page: calls, cursor: null } };
    }
  };
  const result = await collectPostedNotes(source, { maxPages: 3 });
  assert.equal(result.pagesRead, 2, '第 2 页全是重复即停，不做第 3 次请求');
  assert.equal(result.notes.length, 2);
  assert.equal(result.duplicates, 2, '第 2 页两条都算重复');
  assert.equal(result.coverage.incomplete_reason, 'page_repeated');
});

test('PS-T38：有滚动续读能力时第一页导航、后续页滚动，不重复导航回第一页', async () => {
  // 2026-10-26 实测：重新导航只会拿到第一页，滚动列表容器才能拿到后续页。
  const pages = [
    page([noteA, noteB], { page: 1 }),
    page([{ ...noteB, id: '6f0000000000000000000003' }], { page: 2 }),
    page([{ ...noteB, id: '6f0000000000000000000004' }], { page: -1 })
  ];
  const calls = [];
  let index = 0;
  const source = {
    fetchSigned: async (path) => {
      calls.push(['nav', path]);
      return pages[index++];
    },
    fetchSignedNextPage: async (path) => {
      calls.push(['scroll', path]);
      return pages[index++];
    }
  };
  const result = await collectPostedNotes(source, { maxPages: 3 });
  assert.deepEqual(calls.map(([kind]) => kind), ['nav', 'scroll', 'scroll'], '只有第一页走导航');
  assert.equal(result.pagesRead, 3);
  assert.equal(result.notes.length, 4);
  assert.equal(result.duplicates, 0, '滚动续读不应该拿到重复页');
  assert.equal(result.hasMore, false);
  assert.equal(result.coverage.incomplete_reason, null);
  assert.equal(result.enumerationComplete, true);
});

test('PS-T38：滚动到底不再有响应时按“没有更多”收口，不虚增页数', async () => {
  const pages = [page([noteA, noteB], { page: 1 })];
  let index = 0;
  const source = {
    fetchSigned: async () => pages[index++],
    // 列表到底后页面不再发请求，响应源返回 null。
    fetchSignedNextPage: async () => null
  };
  const result = await collectPostedNotes(source, { maxPages: 3 });
  assert.equal(result.pagesRead, 1, 'null 响应不计入 pages_read');
  assert.equal(result.notes.length, 2);
  assert.equal(result.hasMore, false);
  assert.equal(result.coverage.incomplete_reason, null);
});

test('PS-T38：滚动续读到页数上限时如实报告 page_budget 与下一页', async () => {
  const source = {
    fetchSigned: async () => page([noteA, noteB], { page: 1 }),
    fetchSignedNextPage: async () => page([{ ...noteB, id: '6f0000000000000000000003' }], { page: 2 })
  };
  const result = await collectPostedNotes(source, { maxPages: 2 });
  assert.equal(result.pagesRead, 2);
  assert.equal(result.hasMore, true);
  assert.equal(result.coverage.incomplete_reason, 'page_budget');
  assert.equal(result.enumerationComplete, false);
});

test('PS-T38：断点续采跳过起始页之前的数据，不把它们重复计入覆盖', async () => {
  // 服务端把 checkpoint.next_page 传回 startPage，续跑的 run 必须滚过前几页再开始收。
  const pages = [
    page([noteA, noteB], { page: 1 }),
    page([{ ...noteB, id: '6f0000000000000000000003' }], { page: 2 }),
    page([{ ...noteB, id: '6f0000000000000000000004' }], { page: -1 })
  ];
  let index = 0;
  const source = {
    fetchSigned: async () => pages[index++],
    fetchSignedNextPage: async () => pages[index++]
  };
  const result = await collectPostedNotes(source, { maxPages: 1, startPage: 2 });
  assert.equal(result.pagesRead, 1, '只统计断点之后的页');
  assert.deepEqual(result.notes.map((note) => note.noteId), ['6f0000000000000000000004']);
  assert.equal(result.coverage.skipped_pages, 2);
  assert.equal(result.coverage.has_more, false);
});

test('分享文本：可取短链或完整链接，跳出允许域名与私网一律拒绝', () => {
  const short = extractShareURL('57 虚构标题 http://xhslink.com/a/AbCd 复制本条信息，打开【小红书】App查看精彩内容！');
  assert.ok(short);
  assert.equal(short.protocol, 'https:');
  assert.equal(short.hostname, 'xhslink.com');

  assert.equal(extractShareURL('没有链接的一段话'), null);
  assert.equal(extractShareURL('https://evil.example.com/note'), null);
  assert.equal(extractShareURL('file:///C:/secret'), null);
  assert.equal(extractShareURL('https://127.0.0.1/x'), null);
  assert.equal(extractShareURL('https://user:pass@xhslink.com/a/1'), null);

  const full = extractShareURL(`https://www.xiaohongshu.com/explore/${noteA.id}?xsec_token=SECRET&xsec_source=pc_share`);
  assert.equal(noteIDFromURL(full), noteA.id);
  // 对外展示链接必须清掉会话参数。
  assert.equal(stripSessionParams(full).includes('xsec_token'), false);
});

test('短链解析：有界跳转后取编号，跳转到非允许地址时拒绝', async () => {
  const resolved = await resolveShareLink(' http://xhslink.com/a/AbCd ', async () => ({
    url: `https://www.xiaohongshu.com/explore/${noteA.id}?xsec_token=SECRET`
  }));
  assert.equal(resolved.noteId, noteA.id);
  assert.equal(resolved.displayURL.includes('xsec_token'), false);

  await assert.rejects(
    () => resolveShareLink('http://xhslink.com/a/AbCd', async () => ({ url: 'https://127.0.0.1/x' })),
    (e) => e.code === 'platform_network_unavailable'
  );
  await assert.rejects(
    () => resolveShareLink('http://xhslink.com/a/AbCd', async () => null),
    (e) => e.code === 'platform_historical_unavailable'
  );
  // 一直解析不出编号时给出可操作提示，不按标题猜。
  await assert.rejects(
    () => resolveShareLink('http://xhslink.com/a/AbCd', async () => ({ url: 'https://xhslink.com/a/Next' })),
    (e) => e.code === 'platform_historical_unavailable' && /手工输入/.test(e.message)
  );
});

test('PS-T11：作者不符的编号不能当作本人作品', () => {
  assert.equal(verifyNoteAuthor({ data: { userId: 'fixture-self' } }, 'fixture-self'), true);
  assert.equal(verifyNoteAuthor({ data: { user: { userId: 'fixture-self' } } }, 'fixture-self'), true);
  assert.equal(verifyNoteAuthor({ data: { userId: 'fixture-other' } }, 'fixture-self'), false);
  assert.equal(verifyNoteAuthor({ data: { nickname: '同昵称' } }, 'fixture-self'), false);
  assert.equal(verifyNoteAuthor({}, 'fixture-self'), false);
});

// normalize 复用适配器的列表解析，避免测试里另写一套字段映射。
function normalize(raw) {
  const parsed = parsePostedNotesPage(page([raw]));
  assert.equal(parsed.notes.length, 1, '样本应能解析');
  return parsed.notes[0];
}

// ---------- CF-P2-CXEF-06：评论授权读取的 mock 适配器集成（续 CF-P2-CXEF-02） ----------
// 全部为虚构样本；共享 fixture 同时驱动 Go 与 Node，两侧各自核对 present 标记与去重键。
const cxef06Fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/cxef06-comment-facts.json'), 'utf8')
);

test('CF-P2-CXEF-06 共享 fixture：六字段 present 标记与去重键跨语言一致', () => {
  assert.equal(XHS_COMMENT_FACT_SCHEMA, cxef06Fixture.schema);
  const parsed = parseCommentFacts(cxef06Fixture.note_id, cxef06Fixture.raw);
  assert.equal(parsed.reason, null, '正常列表不得带原因码');
  assert.equal(parsed.facts.length, cxef06Fixture.expected.length);

  cxef06Fixture.expected.forEach((expected, index) => {
    const { dedupe_id: dedupeId, ...factShape } = expected;
    assert.deepEqual(parsed.facts[index], factShape, `第 ${index + 1} 条事实必须与共享 fixture 逐字段一致`);
    assert.equal(
      commentDedupeId(cxef06Fixture.platform, cxef06Fixture.external_account_key, expected.comment_id),
      dedupeId,
      `第 ${index + 1} 条去重键必须与共享 fixture 一致`
    );
  });

  // 缺字段不当空串：第 2 条没给作者，第 3 条正文是空白。
  assert.equal(parsed.facts[1].author, null);
  assert.equal(parsed.facts[1].present.author, false);
  assert.equal(parsed.facts[1].present.parent_comment_id, false);
  assert.equal(parsed.facts[2].body, null);
  assert.equal(parsed.facts[2].present.body, false);
  assert.equal(parsed.facts[2].reason, 'empty_body');
  assert.equal(parsed.facts[2].present.parent_comment_id, true);

  // 单条结果信封与服务端 platformCommentResult 同形；一次只出一条，不打包整批。
  const result = toCommentResult(cxef06Fixture.platform, cxef06Fixture.external_account_key, parsed.facts);
  assert.ok(result, '可读事实应产出结果信封');
  assert.deepEqual(Object.keys(result).sort(), ['external_account_key', 'items', 'platform', 'schema']);
  assert.equal(result.schema, cxef06Fixture.schema);
  assert.equal(result.platform, cxef06Fixture.platform);
  assert.equal(result.external_account_key, cxef06Fixture.external_account_key);
  assert.equal(result.items.length, 1, '不得批量携带整批评论（D-117）');
  assert.equal(result.items[0].comment_id, cxef06Fixture.expected[0].comment_id);
  assert.equal(toCommentResult(cxef06Fixture.platform, cxef06Fixture.external_account_key, parsed.facts, 2), null,
    'empty_body 事实不得进结果信封');
  assert.equal(toCommentResult(cxef06Fixture.platform, cxef06Fixture.external_account_key, parsed.facts, 9), null,
    '越界下标不得凭空造事实');
  assert.equal(toCommentResult(cxef06Fixture.platform, cxef06Fixture.external_account_key, parsed.facts, 1).items.length, 1,
    '逐条调用仍恒为单条');
});

test('CF-P2-CXEF-06 注入式只读源：缺源 / 拒绝 / 读失败 / 空列表 / 结构坏均留原因码', async () => {
  const noteId = cxef06Fixture.note_id;
  assert.equal((await readCommentFacts({}, noteId)).reason, 'comment_source_missing',
    '没有注入源不得冒充已授权读取');
  assert.equal(parseCommentFacts(noteId, cxef06Fixture.deniedPayload).reason, cxef06Fixture.expectedDeniedReason);
  assert.equal(parseCommentFacts(noteId, cxef06Fixture.absentPayload).reason, cxef06Fixture.expectedAbsentReason);
  assert.equal(parseCommentFacts(noteId, cxef06Fixture.malformedPayload).reason, cxef06Fixture.expectedMalformedReason);
  assert.equal(parseCommentFacts(noteId, null).reason, 'parse_failed');
  assert.equal(parseCommentFacts('', cxef06Fixture.raw).reason, 'parse_failed');

  let seenNoteId = null;
  const source = {
    fetchJSON: async () => { throw new Error('不应调用列表接口'); },
    fetchComments: async (id) => { seenNoteId = id; return cxef06Fixture.raw; }
  };
  const read = await readCommentFacts(source, noteId);
  assert.equal(read.reason, null);
  assert.equal(read.facts.length, 3);
  assert.equal(seenNoteId, noteId, '只读源必须只针对用户所选笔记，不得扩大读取范围');

  const broken = { fetchComments: async () => { throw new Error('mock transport failure'); } };
  assert.equal((await readCommentFacts(broken, noteId)).reason, 'read_failed');
  const denied = {
    fetchComments: async () => { throw new XhsAdapterError('platform_capability_denied', 'mock 权限不足'); }
  };
  assert.equal((await readCommentFacts(denied, noteId)).reason, 'permission_denied');
});

test('CF-P2-CXEF-06 守卫：不臆造 endpoint、不批量、不落真实昵称', () => {
  // 适配器接口白名单不因本项扩大：评论 endpoint 仍未实测，宿主按注入源提供。
  assert.equal(Object.prototype.hasOwnProperty.call(XHS_API, 'comments'), false,
    '不得凭空新增未实测的评论 endpoint');
  const adapter = fs.readFileSync(path.join(__dirname, '../src/platforms/xhs.ts'), 'utf8');
  assert.ok(!/body_text|bodyText/.test(adapter), 'CF-PS-04 守卫仍不得被绕过');
  assert.match(adapter, /fetchComments\?\(noteId: string\)/, '评论源必须是可注入的可选方法');

  // 服务端同形约束：单条、幂等、schema、不落真实昵称。
  const go = fs.readFileSync(path.join(__dirname, '../../server/internal/app/platform_comment_facts.go'), 'utf8');
  assert.match(go, /platformCommentFactSchema = "cxef06-comment-facts-v1"/, '两端 schema 必须一致');
  assert.match(go, /len\(result\.Items\) != 1/, '服务端必须拒绝批量结果');
  assert.match(go, /ON CONFLICT \(id\) DO NOTHING/, '确定性主键必须幂等');
  assert.match(go, /不持久化真实昵称/, '隐私边界必须显式登记');
  assert.match(go, /VALUES \(\$1,\$2,\$3,NULL,'',\$4,\$5,NULL\)/, 'author_alias / work_id / created_by 不得落库');
  const ddl = fs.readFileSync(
    path.join(__dirname, '../../server/internal/db/migrations/00082_cx_comment_inbox.sql'), 'utf8');
  assert.ok(!/author_raw\s+\w/.test(ddl), 'comment_inbox 不得出现真实昵称列');
});
