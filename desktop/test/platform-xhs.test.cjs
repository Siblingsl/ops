const assert = require('node:assert/strict');
const test = require('node:test');

const {
  collectPostedNotes,
  extractShareURL,
  mapNoteStatus,
  mapNoteType,
  noteIDFromURL,
  noteToObservation,
  parseCount,
  parseIdentity,
  parsePostedNotesPage,
  probeCapabilities,
  resolveShareLink,
  stripSessionParams,
  verifyNoteAuthor,
  XHS_ADAPTER_VERSION,
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
