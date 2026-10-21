const assert = require('node:assert/strict');
const test = require('node:test');

const wx = require('../.build/platforms/wechat-mp.js');

// DEV-PS49：公众号发布时间的解析与上报。
//
// 缺陷背景：绑定作品时若没有真实发布时间，多篇作品会被写成**同一个**
// `published_at`（绑定时刻）。实测 7 篇已验证全部是 `06:16:47.671817`，
// 于是 `metric_day_offset` 对它们全部算成 0——D1/D3/D7/D14 节点塌成一个点，
// 所有按天对比的指标失真。
//
// 公众号适配器其实一直采到了 `sent_info.time`（`article.sentAt`），
// 只是没上报给服务端。这里验证解析与上报。

test('normalizeWechatSentAt 按北京时间解析', () => {
  // 平台给的是北京时间且无时区标记，必须显式按 +08:00 解释，
  // 否则机器时区不是 UTC+8 时会整体偏移。
  assert.equal(wx.normalizeWechatSentAt('2026-10-15 08:30'), '2026-10-15T00:30:00Z');
  assert.equal(wx.normalizeWechatSentAt('2026-10-15 00:30'), '2026-10-14T16:30:00Z');
  assert.equal(wx.normalizeWechatSentAt('2026-10-15 23:59'), '2026-10-15T15:59:00Z');
  // 带秒。
  assert.equal(wx.normalizeWechatSentAt('2026-10-15 08:30:45'), '2026-10-15T00:30:45Z');
});

test('normalizeWechatSentAt 接受平台可能的不补零格式', () => {
  assert.equal(wx.normalizeWechatSentAt('2026-1-5 9:05'), '2026-01-05T01:05:00Z');
  assert.equal(wx.normalizeWechatSentAt('2026-1-5 09:05'), '2026-01-05T01:05:00Z');
});

test('normalizeWechatSentAt 对无法识别的输入返回 null（宁可不写也不写错）', () => {
  assert.equal(wx.normalizeWechatSentAt(null), null);
  assert.equal(wx.normalizeWechatSentAt(''), null);
  assert.equal(wx.normalizeWechatSentAt('garbage'), null);
  assert.equal(wx.normalizeWechatSentAt('2026-13-40 99:99'), null);
  // 溢出日期不能被 Date 悄悄进位成下个月。
  assert.equal(wx.normalizeWechatSentAt('2026-02-31 10:00'), null);
});

test('articleToObservation 把发布时间放进 platform_published_at', () => {
  const article = {
    appmsgID: '2247480001',
    itemIndex: 1,
    externalID: '2247480001_1',
    title: '样本',
    contentURL: null,
    sentAt: '2026-10-15 08:30',
    status: 'published',
    publishOnly: false,
    readNum: 12,
    likes: 3,
    comments: 1,
    shares: 0
  };
  const obs = wx.articleToObservation(article, {
    externalAccountKey: 'wechat_biz:fixture',
    observedAt: '2026-10-21T00:00:00Z'
  });
  assert.ok(obs, '已发布文章应生成观测');
  assert.equal(obs.platform_published_at, '2026-10-15T00:30:00Z');
});

test('sentAt 无法解析时不带 platform_published_at 字段', () => {
  const article = {
    appmsgID: '2247480002', itemIndex: 1, externalID: '2247480002_1',
    title: '样本', contentURL: null, sentAt: '看起来像时间但其实不是',
    status: 'published', publishOnly: false,
    readNum: 1, likes: 0, comments: 0, shares: 0
  };
  const obs = wx.articleToObservation(article, {
    externalAccountKey: 'wechat_biz:fixture',
    observedAt: '2026-10-21T00:00:00Z'
  });
  assert.ok(obs);
  assert.equal('platform_published_at' in obs, false,
    '解析失败时不应带该字段，避免写入错误时间');
});
