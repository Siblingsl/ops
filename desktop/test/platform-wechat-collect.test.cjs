const assert = require('node:assert/strict');
const test = require('node:test');

const {
  collectPublishedArticles,
  articleToObservation
} = require('../.build/platforms/wechat-mp.js');

// 虚构样本：bizuin/appmsgid 均为编造值，不包含任何真实账号数据。
const ACCOUNT_KEY = 'wechat_biz:MzFIXTURE0001==';

function appmsg(overrides = {}) {
  return {
    appmsgid: '2247480001',
    itemidx: 1,
    title: '虚构样本',
    content_url: 'https://mp.weixin.qq.com/s?__biz=MzFIXTURE0001==&mid=2247480001&idx=1',
    is_deleted: false,
    read_num: 0,
    like_num: 2,
    old_like_num: 1,
    share_num: 0,
    comment_num: 0,
    ...overrides
  };
}

function record(infoList, overrides = {}) {
  return {
    publish_type: 1,
    sent_info: { time: '2026-10-19 08:00' },
    publish_info: { appmsg_info: infoList },
    ...overrides
  };
}

// 这两个函数是采集接线的核心：适配器输出要能直接变成服务端可接受的观测。
test('采集接线：跨页结果能逐篇映射成观测，并带快照给的修订', async () => {
  const pageOne = [appmsg({ appmsgid: '2247480001', itemidx: 1 }), appmsg({ appmsgid: '2247480002', itemidx: 1 })];
  const pageTwo = [appmsg({ appmsgid: '2247480003', itemidx: 1 })];
  const pages = [
    { base_resp: { ret: 0 }, publish_page: { publish_list: [record(pageOne)], total_count: 3, page: 0 } },
    { base_resp: { ret: 0 }, publish_page: { publish_list: [record(pageTwo)], total_count: 3, page: 1 } }
  ];
  let calls = 0;
  const source = { fetchJSON: async () => pages[Math.min(calls++, pages.length - 1)] };
  const discovery = await collectPublishedArticles(source, { maxPages: 3 });
  assert.equal(discovery.articles.length, 3);
  assert.equal(discovery.pagesRead, 2);

  const observedAt = '2026-10-21T06:00:00.000Z';
  const drafts = discovery.articles.map((article, index) => {
    const draft = articleToObservation(article, {
      externalAccountKey: ACCOUNT_KEY,
      observedAt,
      bindingRevision: 4,
      publishRevision: 7
    });
    assert.ok(draft, `第 ${index} 篇必须生成观测`);
    return { ...draft, row_no: index };
  });
  assert.equal(drafts.length, 3);
  for (const draft of drafts) {
    assert.equal(draft.source, 'wechat_browser');
    assert.equal(draft.temporal_kind, 'cumulative');
    assert.equal(draft.external_account_key, ACCOUNT_KEY);
    assert.equal(draft.binding_revision, 4);
    assert.equal(draft.publish_revision, 7);
    // 编号必须是 appmsgid_itemidx 形态。
    assert.match(draft.external_id, /^\d+_\d+$/);
  }
  assert.deepEqual(drafts.map((d) => d.row_no), [0, 1, 2]);
});

test('采集接线：已删除文章不生成观测，阅读/分享单位保持 unknown', async () => {
  const deleted = appmsg({ appmsgid: '2247480004', itemidx: 1, is_deleted: true });
  const deletedDraft = articleToObservation(
    { externalID: '2247480004_1', title: '虚构', status: 'deleted', readNum: 1, likes: 0, comments: 0, shares: 0 },
    { externalAccountKey: ACCOUNT_KEY, observedAt: '2026-10-21T06:00:00.000Z' }
  );
  assert.equal(deletedDraft, null, '已删除文章不生成观测');
  void deleted;

  const draft = articleToObservation(
    { externalID: '2247480005_1', title: '虚构', status: 'published', readNum: 9, likes: 2, comments: 1, shares: 0 },
    { externalAccountKey: ACCOUNT_KEY, observedAt: '2026-10-21T06:00:00.000Z' }
  );
  assert.ok(draft);
  // read_num / share_num 单位未确认前按 unknown（D-129 v0.4），不投影正式 reads/shares。
  assert.equal(draft.values.read_times.unit, 'unknown');
  assert.equal(draft.values.share_times.unit, 'unknown');
  assert.equal(draft.values.like_count.unit, 'count');
  assert.equal(draft.values.like_count.value, 2);
  // 真实 0 保留为 0，不能变成缺失。
  assert.equal(draft.values.share_times.value, 0);
});
