// v2 目录阶段的三个纯函数：断点续采起始页、冻结范围上界、目录行构造。
//
// 为什么单独测：这三段决定"第二轮 run 从哪里接着读"和"哪些作品算在本次范围内"。
// 判错的两个方向都很贵——起始页读错会让续采永远停在第一页（39 篇永远读不完），
// 上界判错会把范围外的作品写进镜像、或者把范围内的作品全丢掉。
//
// 三个函数都是 main.ts 的模块内私有函数、没有导出，所以用
// `support/source-function.cjs` 把源码原样转译后求值，测的是真实实现。

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadFunction } = require('./support/source-function.cjs');

const loadStartPage = () => loadFunction('src/main.ts', 'platformV2StartPage');
const loadUpperBound = () => loadFunction('src/main.ts', 'platformV2ScopeUpperBound');
const loadCatalogItem = () => loadFunction('src/main.ts', 'platformV2CatalogItem');

test('PS-T41：断点续采的起始页只认非负整数', () => {
  const startPage = loadStartPage();
  assert.equal(startPage({ checkpoint: { next_page: 3 } }), 3, '服务端下发的 next_page 必须照用');
  assert.equal(startPage({ checkpoint: { next_page: 0 } }), 0);
  // 缺字段、类型不对、负数、小数、非对象一律回落到 0：宁可重读第一页，也不能从负页开始。
  assert.equal(startPage({ checkpoint: {} }), 0);
  assert.equal(startPage({}), 0);
  assert.equal(startPage(null), 0);
  assert.equal(startPage(undefined), 0);
  assert.equal(startPage('checkpoint'), 0);
  assert.equal(startPage({ checkpoint: { next_page: -1 } }), 0);
  assert.equal(startPage({ checkpoint: { next_page: 2.5 } }), 0);
  assert.equal(startPage({ checkpoint: { next_page: '3' } }), 0, '字符串不能当页码');
  assert.equal(startPage({ checkpoint: { next_page: Number.NaN } }), 0);
  assert.equal(startPage({ checkpoint: { next_page: Number.POSITIVE_INFINITY } }), 0);
});

test('PS-T42：冻结范围上界只认可解析的时间字符串', () => {
  const upperBound = loadUpperBound();
  const raw = '2026-10-26T05:49:05.180615Z';
  assert.equal(upperBound({ frozen_scope: { scope_upper_bound: raw } }), Date.parse(raw));
  // 缺字段或类型不对时必须回 null（= 不做范围裁剪），不能当成 0（= 全部裁掉）。
  assert.equal(upperBound({ frozen_scope: {} }), null);
  assert.equal(upperBound({}), null);
  assert.equal(upperBound(null), null);
  assert.equal(upperBound({ frozen_scope: { scope_upper_bound: 12345 } }), null);
  assert.equal(upperBound({ frozen_scope: { scope_upper_bound: 'not a time' } }), null);
  assert.equal(upperBound({ frozen_scope: 'nope' }), null);
});

test('PS-T43：晚于上界的目录行按范围外丢弃，不构造行体', () => {
  const catalogItem = loadCatalogItem();
  const upperBound = Date.parse('2026-10-26T05:49:05.180615Z');
  const base = {
    externalID: '6a7c6caf00000000005033', accountKey: 'xhs_user_id:fixture',
    contentType: 'image_note', title: '样本标题', authorDisplay: '巡检号', metrics: null, upperBound
  };

  const outside = catalogItem({ ...base, publishedAt: new Date(upperBound + 60_000).toISOString() });
  assert.equal(outside.outsideUpperBound, true);
  assert.equal(outside.item, null, '范围外的行不能构造行体');
  assert.equal(outside.missingPublishedAt, false);

  const inside = catalogItem({ ...base, publishedAt: new Date(upperBound - 60_000).toISOString() });
  assert.equal(inside.outsideUpperBound, false);
  assert.ok(inside.item);
  assert.equal(inside.item.external_id, base.externalID);
  assert.equal(inside.item.author_external_account_key, base.accountKey);
  assert.equal(inside.item.remote_status, 'published');
});

test('PS-T43：没有上界时不裁剪；没有发布时间时如实标记缺失', () => {
  const catalogItem = loadCatalogItem();
  const base = {
    externalID: '6a7c6caf00000000005034', accountKey: 'xhs_user_id:fixture',
    contentType: 'image_note', title: '样本标题', authorDisplay: '巡检号', metrics: null
  };
  // upperBound=null 表示这次操作没有冻结范围，任何时间都不该被裁掉。
  const noBound = catalogItem({ ...base, publishedAt: '2030-01-01T00:00:00.000Z', upperBound: null });
  assert.equal(noBound.outsideUpperBound, false);
  assert.ok(noBound.item);

  // 发布时间缺失：不能当成"在范围内"就完事，必须把 missingPublishedAt 报上去。
  const missing = catalogItem({ ...base, publishedAt: null, upperBound: Date.parse('2026-10-26T00:00:00Z') });
  assert.equal(missing.outsideUpperBound, false);
  assert.equal(missing.missingPublishedAt, true);
  assert.ok(missing.item);
  assert.equal(missing.item.field_states.published_at, 'unknown');
  assert.ok(!('published_at' in missing.item), '没有发布时间就不要带这个字段');
});

test('PS-T43：目录行的字段覆盖必须自报 unknown，不能假装 present', () => {
  const catalogItem = loadCatalogItem();
  const item = catalogItem({
    externalID: '6a7c6caf00000000005035', accountKey: 'xhs_user_id:fixture',
    contentType: 'image_note', title: '样本标题', authorDisplay: '巡检号', metrics: null, upperBound: null,
    publishedAt: '2026-10-20T00:00:00.000Z'
  }).item;
  const states = item.field_states;
  assert.equal(states.title, 'present');
  assert.equal(states.published_at, 'present');
  // 这五项列表页拿不到，只能是 unknown；写成 present 服务端会要求给出值。
  for (const field of ['summary', 'canonical_url', 'remote_updated_at', 'cover_ref', 'topics', 'tags']) {
    assert.equal(states[field], 'unknown', `${field} 在列表页拿不到，必须报 unknown`);
  }
  assert.deepEqual(item.topics, []);
  assert.deepEqual(item.tags, []);
});
