// CF-PS-07 正文行的构造逻辑：决定「读到什么就如实报什么」的状态映射。
// platformV2ContentItem 是 main.ts 的模块内私有函数，按本仓惯例用
// support/source-function.cjs 原样转译求值，测的是真实实现而不是复制品。
const assert = require('node:assert/strict');
const test = require('node:test');
const { loadFunction } = require('./support/source-function.cjs');

const loadContentItem = () => loadFunction('src/main.ts', 'platformV2ContentItem');
const input = (body, extra = {}) => ({
  externalID: '6f0000000000000000000001', accountKey: 'xhs_user_id:fixture',
  contentRevision: 3, contentType: 'image_note',
  note: { title: '虚构标题', body }, observedAt: '2026-11-15T00:00:00Z',
  ...extra
});

test('P0-1 读到非空正文：complete + title/body_text 都声明 present，修订号原样回传', () => {
  const item = loadContentItem()(input({ present: true, text: '正文内容', reason: null }));
  assert.equal(item.state, 'complete');
  assert.equal(item.title, '虚构标题');
  assert.equal(item.body_text, '正文内容');
  assert.equal(item.content_revision, 3, '冻结目标的修订号必须原样回传');
  assert.equal(item.field_states.title, 'present');
  assert.equal(item.field_states.body_text, 'present');
  assert.deepEqual(item.topics, []);
  assert.deepEqual(item.tags, []);
  assert.deepEqual(item.media_refs, []);
});

test('P0-1 无详情源（detail_source_missing）：failed，正文不冒充完整', () => {
  const item = loadContentItem()(input({ present: false, text: null, reason: 'detail_source_missing' }));
  assert.equal(item.state, 'failed');
  assert.equal(item.body_text, undefined, '正文缺失不得落空串');
  assert.equal(item.field_states.body_text, 'unknown');
});

test('P0-1 权限不足与正文缺失/空串：分别映射 denied 与 unsupported', () => {
  const denied = loadContentItem()(input({ present: false, text: null, reason: 'permission_denied' }));
  assert.equal(denied.state, 'denied');
  const absent = loadContentItem()(input({ present: false, text: null, reason: 'body_absent' }));
  assert.equal(absent.state, 'unsupported');
  const empty = loadContentItem()(input({ present: false, text: null, reason: 'empty_body' }));
  assert.equal(empty.state, 'unsupported');
});

test('P0-1 complete 但没有标题：返回 null（服务端 complete 校验要求标题在场）', () => {
  const item = loadContentItem()(input({ present: true, text: '正文', reason: null }, {
    note: { title: '', body: { present: true, text: '正文', reason: null } }
  }));
  assert.equal(item, null);
});

test('P0-1 冻结目标缺修订号时按 0 上报，不自己猜修订', () => {
  const item = loadContentItem()(input({ present: true, text: '正文', reason: null }, { contentRevision: null }));
  assert.equal(item.content_revision, 0);
});
