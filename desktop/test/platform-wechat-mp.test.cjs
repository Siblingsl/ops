const assert = require('node:assert/strict');
const test = require('node:test');

const {
  articleIDFromURL,
  articleToObservation,
  buildExternalID,
  collectPublishedArticles,
  extractArticleURL,
  parseExternalID,
  parseIdentity,
  parsePublishPage,
  probeCapabilities,
  resolveArticleLink,
  stripSessionParams,
  verifyArticleOwner,
  verifyRegisteredOriginalID,
  WECHAT_MP_ADAPTER_VERSION,
  WechatAdapterError
} = require('../.build/platforms/wechat-mp.js');

// 全部为虚构样本：bizuin 与 appmsgid 均为编造值。
const bizuin = 'MzA5MDAwMDAwMQ==';
const originalID = 'gh_fixture0001';

function appmsg(overrides = {}) {
  return {
    appmsgid: '2247480001',
    itemidx: 1,
    title: '虚构样本：一篇公众号文章',
    content_url: 'https://mp.weixin.qq.com/s?__biz=MzA5MDAwMDAwMQ==&mid=2247480001&idx=1&sn=fixture',
    is_deleted: false,
    read_num: 0,
    like_num: 2,
    old_like_num: 1,
    share_num: 0,
    comment_num: 0,
    ...overrides
  };
}

function page(records) {
  return { publish_page: { publish_list: records, total_count: records.length, page: 0 } };
}

function record(infoList, overrides = {}) {
  return {
    publish_type: 1,
    sent_info: { time: '2026-10-19 08:00' },
    publish_info: { appmsg_info: infoList },
    ...overrides
  };
}

// 2026-10-21 真实账号实测：平台把 publish_page 与 publish_info 都作为**嵌套 JSON 字符串**返回，
// 且发送时间藏在 `publish_info.sent_info.time`（不在记录顶层——记录顶层只有
// `publish_type` 与 `publish_info`）。虚构样本只保留结构，不包含真实 bizuin/appmsgid。
test('嵌套 JSON 字符串：publish_page 与 publish_info 都要二次解析', () => {
  const inner = JSON.stringify({
    publish_list: [{
      publish_type: 101,
      publish_info: JSON.stringify({
        // 真实位置：sent_info 在 publish_info 内部。
        sent_info: { time: 1783745092 },
        appmsg_info: [{ appmsgid: '2247480009', itemidx: 1, title: '虚构', content_url: 'https://mp.weixin.qq.com/s?mid=2247480009&idx=1', is_deleted: false }]
      })
    }],
    total_count: 1,
    page: 0
  });
  const parsed = parsePublishPage({ base_resp: { ret: 0 }, publish_page: inner });
  assert.equal(parsed.articles.length, 1);
  assert.equal(parsed.articles[0].externalID, '2247480009_1');
  assert.equal(parsed.totalCount, 1);
  // 数字形态的 sent_info.time（Unix 秒）要转成 RFC3339，不能原样留着——
  // 后续要写进 work.published_at，必须是可解析的时间。
  assert.equal(parsed.articles[0].sentAt, '2026-07-11T04:44:52Z');
  // publish_type=101（仅发表未群发）仍算已发布作品。
  assert.equal(parsed.articles[0].status, 'published');

  // 非 0 base_resp.ret 视为会话无效，不能返回空列表冒充没有作品。
  assert.throws(
    () => parsePublishPage({ base_resp: { ret: 200040, err_msg: 'invalid csrf token' }, publish_page: inner }),
    (err) => err instanceof WechatAdapterError && err.code === 'platform_login_required'
  );
  // publish_page 是无法解析的字符串：结构变化，不静默当空。
  assert.throws(
    () => parsePublishPage({ base_resp: { ret: 0 }, publish_page: 'not json' }),
    (err) => err instanceof WechatAdapterError && err.code === 'platform_schema_changed'
  );
});

test('多页按 total_count 收口：收集够总量就停，不因本页非空继续翻页', async () => {
  // 仿真实测：第 1 页 10 条、第 2 页 6 条、total=16。
  // 单看第 2 页会得出“还有更多”，但累计已达 16，必须收口。
  const pageOne = Array.from({ length: 10 }, (_, i) => appmsg({ appmsgid: `22474801${String(i).padStart(2, '0')}`, itemidx: 1 }));
  const pageTwo = Array.from({ length: 6 }, (_, i) => appmsg({ appmsgid: `22474802${String(i).padStart(2, '0')}`, itemidx: 1 }));
  const pages = [
    { publish_page: { publish_list: [record(pageOne)], total_count: 16, page: 0 } },
    { publish_page: { publish_list: [record(pageTwo)], total_count: 16, page: 1 } }
  ];
  let calls = 0;
  const source = {
    fetchJSON: async () => {
      const payload = pages[calls] ?? { publish_page: { publish_list: [], total_count: 16, page: calls } };
      calls += 1;
      return payload;
    }
  };
  const result = await collectPublishedArticles(source, { maxPages: 3 });
  assert.equal(result.articles.length, 16, '必须收满 16 篇');
  assert.equal(result.pagesRead, 2, '第 2 页收满后不能再请求第 3 页');
  assert.equal(result.hasMore, false);
  assert.equal(result.coverage.total_count, 16);
  assert.equal(result.duplicates, 0);
});

test('身份：多账号要求当前公众号证据，且必须同时有 bizuin 与原始 ID', () => {
  const payload = {
    biz_list: {
      list: [
        { bizuin: 'MzOTHER', username: 'gh_other', is_admin: 0, nickname: '非管理员' },
        { bizuin, username: originalID, is_admin: 1, nickname: '虚构公众号' }
      ]
    }
  };
  assert.throws(() => parseIdentity(payload), (error) => error.code === 'platform_identity_mismatch');
  const identity = parseIdentity(payload, originalID);
  assert.equal(identity.externalAccountKey, `wechat_biz:${bizuin}`);
  assert.equal(identity.originalID, originalID);
  assert.equal(identity.isAdmin, true);
  assert.equal(parseIdentity(payload, 'gh_other').externalAccountKey, 'wechat_biz:MzOTHER');

  // 只有昵称、拿不到原始 ID：不能启用自动采集。
  assert.throws(
    () => parseIdentity({ biz_list: { list: [{ bizuin, nickname: '只有昵称' }] } }),
    (e) => e.code === 'platform_identity_mismatch'
  );
  // 没有 bizuin：拿不到稳定身份。
  assert.throws(
    () => parseIdentity({ biz_list: { list: [{ username: originalID }] } }),
    (e) => e.code === 'platform_identity_mismatch'
  );
  assert.throws(() => parseIdentity({}), (e) => e.code === 'platform_login_required');
  assert.throws(() => parseIdentity({ biz_list: { list: [] } }), (e) => e.code === 'platform_login_required');
});

test('原始 ID 与 OPS 已登记值核对，大小写不敏感但不接受空值', () => {
  const identity = { externalAccountKey: `wechat_biz:${bizuin}`, originalID, isAdmin: true };
  assert.equal(verifyRegisteredOriginalID(identity, originalID.toUpperCase()), true);
  assert.equal(verifyRegisteredOriginalID(identity, 'gh_other'), false);
  assert.equal(verifyRegisteredOriginalID(identity, ''), false);
});

test('能力：未登录时只报未知，数据延迟记次日更新', () => {
  const caps = probeCapabilities({
    backendLoggedIn: false, identity: null, listReadable: false, now: '2026-10-20T10:00:00Z'
  });
  assert.equal(caps.backendLogin, 'unknown');
  assert.equal(caps.publishedList, 'unknown');
  assert.equal(caps.perArticleMetrics, 'unknown');
  // 单篇明细与账号趋势首版不承诺。
  assert.equal(caps.articleDetail, 'unknown');
  assert.equal(caps.accountTrend, 'unknown');
  assert.equal(caps.dataLatency, 'next_day');
  assert.equal(caps.adapterVersion, WECHAT_MP_ADAPTER_VERSION);

  const ready = probeCapabilities({
    backendLoggedIn: true, identity: { externalAccountKey: 'wechat_biz:x', originalID, isAdmin: true },
    listReadable: true, now: '2026-10-20T10:00:00Z'
  });
  assert.equal(ready.publishedList, 'supported');
  assert.equal(ready.perArticleMetrics, 'supported');
  // 即使列表可读，未实测的能力仍不能声称支持。
  assert.equal(ready.articleDetail, 'unknown');
});

test('PS-T12：多图文同一 appmsgid 不同 itemidx 逐篇独立，idx 缺失或非法整条拒绝', () => {
  assert.equal(buildExternalID('2247480002', 1), '2247480002_1');
  assert.equal(buildExternalID('2247480002', '2'), '2247480002_2');
  // 不默认成 1：缺失、0、负数、非数字、超范围都返回 null。
  for (const bad of [undefined, null, 0, -1, 'x', 1000, 1.5, '']) {
    assert.equal(buildExternalID('2247480002', bad), null, String(bad));
  }
  assert.equal(buildExternalID('not-a-number', 1), null);
  assert.deepEqual(parseExternalID('2247480002_3'), { appmsgID: '2247480002', itemIndex: 3 });
  assert.equal(parseExternalID('2247480002'), null);
  assert.equal(parseExternalID('2247480002_0'), null);

  const parsed = parsePublishPage(page([
    record([appmsg({ appmsgid: '2247480002', itemidx: 1 }), appmsg({ appmsgid: '2247480002', itemidx: 2 })]),
    // 缺 itemidx 的整条被拒，并计入无效行。
    record([appmsg({ appmsgid: '2247480003', itemidx: undefined })])
  ]));
  assert.equal(parsed.articles.length, 2);
  assert.equal(parsed.articles[0].externalID, '2247480002_1');
  assert.equal(parsed.articles[1].externalID, '2247480002_2');
  assert.notEqual(parsed.articles[0].externalID, parsed.articles[1].externalID);
  assert.equal(parsed.invalidRows, 1);
});

test('PS-T14：is_deleted 据此排除，列表缺失不推断删除', () => {
  const parsed = parsePublishPage(page([
    record([appmsg({ appmsgid: '2247480010', itemidx: 1 })]),
    record([appmsg({ appmsgid: '2247480011', itemidx: 1, is_deleted: true })])
  ]));
  assert.equal(parsed.articles.length, 2);
  const live = parsed.articles.find((a) => a.appmsgID === '2247480010');
  const deleted = parsed.articles.find((a) => a.appmsgID === '2247480011');
  assert.equal(live.status, 'published');
  assert.equal(deleted.status, 'deleted');
  // 已删除文章不生成观测。
  assert.equal(articleToObservation(deleted, { externalAccountKey: 'wechat_biz:x', observedAt: '2026-10-20T10:00:00Z' }), null);
  assert.ok(articleToObservation(live, { externalAccountKey: 'wechat_biz:x', observedAt: '2026-10-20T10:00:00Z' }));
});

test('“仅发表、未群发”同样当作已发布作品', () => {
  const parsed = parsePublishPage(page([
    record([appmsg({ appmsgid: '2247480020', itemidx: 1 })], { publish_type: 101 })
  ]));
  assert.equal(parsed.articles.length, 1);
  assert.equal(parsed.articles[0].publishOnly, true);
  assert.equal(parsed.articles[0].status, 'published');
  const observation = articleToObservation(parsed.articles[0], {
    externalAccountKey: 'wechat_biz:x', observedAt: '2026-10-20T10:00:00Z'
  });
  assert.ok(observation, '仅发表文章也应能生成观测');
  assert.equal(observation.external_id, '2247480020_1');
});

test('PS-T15/T16：0 保留，缺失与占位为未知；单位未确认的字段标 unknown', () => {
  const parsed = parsePublishPage(page([
    record([appmsg({ appmsgid: '2247480030', itemidx: 1, read_num: 0, like_num: 0, share_num: null, comment_num: '—' })])
  ]));
  const article = parsed.articles[0];
  assert.equal(article.readNum, 0);
  assert.equal(article.likes, 0);
  assert.equal(article.shares, null);
  assert.equal(article.comments, null);

  const observation = articleToObservation(article, {
    externalAccountKey: 'wechat_biz:x', observedAt: '2026-10-20T10:00:00Z'
  });
  assert.ok(observation);
  // read_num 与 share_num 单位未确认：标 unknown，不冒充次数。
  assert.equal(observation.values.read_times.unit, 'unknown');
  assert.equal(observation.values.like_count.unit, 'count');
  // 0 保留。
  assert.equal(observation.values.read_times.value, 0);
  // 缺失字段不出现（而不是 0）。
  assert.equal(observation.values.share_times, undefined);
  assert.equal(observation.values.comment_count, undefined);
  // old_like_num 含义未确认，不映射 wows。
  assert.equal(observation.values.wow_count, undefined);
});

test('PS-T32：跨页按稳定编号去重，页数上限如实报告未完成覆盖', async () => {
  const first = { publish_page: { publish_list: [record([appmsg({ appmsgid: '2247480040', itemidx: 1 })])], total_count: 5, page: 0 } };
  const second = { publish_page: { publish_list: [
    record([appmsg({ appmsgid: '2247480040', itemidx: 1 })]),
    record([appmsg({ appmsgid: '2247480041', itemidx: 1 })])
  ], total_count: 5, page: 1 } };
  const pages = [first, second];
  let index = 0;
  const result = await collectPublishedArticles({ fetchJSON: async () => pages[Math.min(index++, pages.length - 1)] }, { maxPages: 2 });
  assert.equal(result.pagesRead, 2);
  assert.equal(result.duplicates, 1);
  assert.equal(result.articles.length, 2);
  assert.equal(result.coverage.incomplete_reason, 'page_budget');
  assert.equal(result.hasMore, true);
});

test('文章链接：只认公众号域名，编号取 mid/idx，展示链接清掉 token', () => {
  const url = extractArticleURL('https://mp.weixin.qq.com/s?__biz=MzA5MDAwMDAwMQ==&mid=2247480050&idx=2&sn=x&token=SECRET');
  assert.ok(url);
  assert.equal(articleIDFromURL(url), '2247480050_2');
  assert.equal(stripSessionParams(url).includes('token'), false);
  // __biz 必须与连接的 bizuin 一致。
  assert.equal(verifyArticleOwner(url, bizuin), true);
  assert.equal(verifyArticleOwner(url, 'MzOTHER'), false);

  assert.equal(extractArticleURL('https://evil.example.com/s?mid=1&idx=1'), null);
  assert.equal(extractArticleURL('http://127.0.0.1/s?mid=1&idx=1'), null);
  assert.equal(extractArticleURL('file:///C:/x'), null);
  // 短链不带编号。
  const short = extractArticleURL('https://mp.weixin.qq.com/s/AbCdEf123');
  assert.ok(short);
  assert.equal(articleIDFromURL(short), null);
});

test('短链解析：有界跳转后取编号，跳转到非允许地址时拒绝', async () => {
  const resolved = await resolveArticleLink('https://mp.weixin.qq.com/s/AbCdEf123', async () => ({
    url: `https://mp.weixin.qq.com/s?__biz=${bizuin}&mid=2247480060&idx=1&token=SECRET`
  }));
  assert.equal(resolved.externalID, '2247480060_1');
  assert.equal(resolved.displayURL.includes('token'), false);

  await assert.rejects(
    () => resolveArticleLink('https://mp.weixin.qq.com/s/AbCdEf123', async () => ({ url: 'https://evil.example.com/x' })),
    (e) => e.code === 'platform_network_unavailable'
  );
  await assert.rejects(
    () => resolveArticleLink('https://mp.weixin.qq.com/s/AbCdEf123', async () => null),
    (e) => e.code === 'platform_historical_unavailable'
  );
  // 解析不到稳定编号时给可操作提示，不按标题猜。
  await assert.rejects(
    () => resolveArticleLink('https://mp.weixin.qq.com/s/AbCdEf123', async () => ({ url: 'https://mp.weixin.qq.com/s/Next' })),
    (e) => e.code === 'platform_historical_unavailable' && /手工输入/.test(e.message)
  );
});

test('PS-T48：解析失败不能退化成按标题匹配', () => {
  // 结构缺失时明确报错，而不是返回空列表让调用方以为“没有文章”。
  assert.throws(() => parsePublishPage({}), (e) => e instanceof WechatAdapterError);
  assert.throws(() => parsePublishPage(null), (e) => e.code === 'platform_login_required');
  // 记录里没有 appmsg_info 时计入无效行，不生成任何“按标题”候选。
  const parsed = parsePublishPage(page([{ publish_type: 1, sent_info: { time: '2026-10-19 08:00' } }]));
  assert.equal(parsed.articles.length, 0);
  assert.equal(parsed.invalidRows, 1);
});
