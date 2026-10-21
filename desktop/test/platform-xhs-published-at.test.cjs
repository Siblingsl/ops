const assert = require('node:assert/strict');
const test = require('node:test');

const xhs = require('../.build/platforms/xhs.js');

// DEV-PS50：小红书笔记时间的解析与上报。
//
// 缺陷背景与公众号（DEV-PS49）同源：适配器一直采到 `time` 字段（存在 `recordedAt`），
// 但**从未上报**给服务端，于是 `work.published_at` 只能落成绑定时刻，
// `metric_day_offset`（D1/D3/D7/D14 天数）全部算成 0，按天对比的指标失真。
//
// 小红书的时间形态比公众号更不统一：可能是 Unix 秒、Unix 毫秒，
// 也可能是北京时间裸串。三种都必须接受，但绝不能猜错。

test('normalizeXhsNoteTime 接受 Unix 秒', () => {
  // 1783745092 → 2026-07-11T04:44:52Z
  assert.equal(xhs.normalizeXhsNoteTime('1783745092'), '2026-07-11T04:44:52Z');
  assert.equal(xhs.normalizeXhsNoteTime(1783745092), '2026-07-11T04:44:52Z');
});

test('normalizeXhsNoteTime 接受 Unix 毫秒', () => {
  // 同一天的毫秒表示，必须得出同一时刻，不能因为位数多就当秒处理。
  assert.equal(xhs.normalizeXhsNoteTime('1783745092000'), '2026-07-11T04:44:52Z');
  assert.equal(xhs.normalizeXhsNoteTime(1783745092000), '2026-07-11T04:44:52Z');
});

test('normalizeXhsNoteTime 按北京时间解析裸串', () => {
  assert.equal(xhs.normalizeXhsNoteTime('2026-07-11 12:44'), '2026-07-11T04:44:00Z');
  assert.equal(xhs.normalizeXhsNoteTime('2026-07-11 12:44:52'), '2026-07-11T04:44:52Z');
  // 不补零也要能解析。
  assert.equal(xhs.normalizeXhsNoteTime('2026-7-4 8:30'), '2026-07-04T00:30:00Z');
});

test('normalizeXhsNoteTime 接受带时区的 ISO 串', () => {
  assert.equal(xhs.normalizeXhsNoteTime('2026-07-11T04:44:52Z'), '2026-07-11T04:44:52Z');
  assert.equal(xhs.normalizeXhsNoteTime('2026-07-11T12:44:52+08:00'), '2026-07-11T04:44:52Z');
});

test('normalizeXhsNoteTime 对无法识别的输入返回 null（宁可不写也不写错）', () => {
  assert.equal(xhs.normalizeXhsNoteTime(null), null);
  assert.equal(xhs.normalizeXhsNoteTime(''), null);
  assert.equal(xhs.normalizeXhsNoteTime('garbage'), null);
  assert.equal(xhs.normalizeXhsNoteTime('0'), null);
  // 溢出日期不能被 Date 悄悄进位。
  assert.equal(xhs.normalizeXhsNoteTime('2026-02-31 10:00'), null);
  // 明显超出合理区间的数值要拒绝（秒级 1 会落到 1970）。
  assert.equal(xhs.normalizeXhsNoteTime('1'), null);
  assert.equal(xhs.normalizeXhsNoteTime('999999999999999'), null);
});

test('noteToObservation 把发布时间放进 platform_published_at', () => {
  const note = {
    noteId: '6f0000000000000000000099',
    title: '样本',
    status: 'published',
    viewTimes: 120, likes: 5, favorites: 2, comments: 1, shares: 0,
    recordedAt: '1783745092'
  };
  const obs = xhs.noteToObservation(note, {
    externalAccountKey: 'xhs_user_id:fixture',
    observedAt: '2026-10-21T00:00:00Z'
  });
  assert.ok(obs, '已发布笔记应生成观测');
  assert.equal(obs.platform_published_at, '2026-07-11T04:44:52Z');
});

test('时间无法解析时不带 platform_published_at 字段', () => {
  const note = {
    noteId: '6f0000000000000000000098',
    title: '样本',
    status: 'published',
    viewTimes: 1, likes: 0, favorites: 0, comments: 0, shares: 0,
    recordedAt: '不是时间'
  };
  const obs = xhs.noteToObservation(note, {
    externalAccountKey: 'xhs_user_id:fixture',
    observedAt: '2026-10-21T00:00:00Z'
  });
  assert.ok(obs);
  assert.equal('platform_published_at' in obs, false,
    '解析失败时不应带该字段，避免写入错误时间');
});
