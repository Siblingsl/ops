const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const toolPath = path.join(__dirname, '..', '..', 'tools', 'platform-acceptance.cjs');
const src = fs.readFileSync(toolPath, 'utf8');

// DEV-PS53：验收工具的样本量判定必须包含"每字段 ≥10 个有效对照"。
//
// 缺陷背景：工具最初只检查"篇数 ≥10"与"发布日 ≥3"，**漏了每字段对照数**，
// 而 §17.1 明确要求"每字段至少 10 个有效对照"。
//
// 这个漏检直接导致汇报出错：把"四个字段合计 28 个对照"当成"每字段 28 个"，
// 真实情况是每字段只有 7 篇（公众号）、1 篇（小红书）。
// 数字被重复采集放大了——同一篇采 8 次就有 8 个"对照"。

// evaluate 把工具里的判定逻辑原样取出来执行，而不是只做文本匹配。
//
// 为什么必须真跑：只断言"源码里有 fieldsEnough 这个词"是无效的——
// 把 `const fieldsEnough = ...` 改成 `= true` 后，正则照样匹配，
// 测试却仍然通过（这一版就踩过这个坑）。
function evaluateVerdict({ publishedCount, publishDays, fieldCounts }) {
  // 从工具源码里提取判定的三行，拼成一个可执行函数。
  const worksLine = src.match(/const worksEnough\s*=\s*([^;]+);/);
  const daysLine = src.match(/const daysEnough\s*=\s*([^;]+);/);
  const fieldsLine = src.match(/const fieldsEnough\s*=\s*([^;]+);/);
  assert.ok(worksLine && daysLine && fieldsLine, '应能找到三行判定');
  const published = { length: publishedCount };
  const bound = { publishDays };
  const fieldRows = fieldCounts.map(([label, count]) => [label, count]);
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'published', 'bound', 'fieldRows',
    `${worksLine[0]}\n${daysLine[0]}\n${fieldsLine[0]}\nreturn worksEnough && daysEnough && fieldsEnough;`
  );
  return { enough: fn(published, bound, fieldRows), works: worksLine[1], fields: fieldsLine[1] };
}

test('篇数与发布日都够、但每字段不足 10 时必须判为不达标', () => {
  // 这正是当前真实情况：7 个发布日（达标）、10 篇（假设达标）、
  // 但每字段只有 7 个对照。
  const r = evaluateVerdict({
    publishedCount: 10,
    publishDays: 7,
    fieldCounts: [['阅读数', 7], ['点赞', 7], ['评论', 7], ['分享', 7]]
  });
  assert.equal(r.enough, false,
    '每字段 7 个对照不足 10，整体必须判不达标');
});

test('三项全部达标时才判达标', () => {
  const r = evaluateVerdict({
    publishedCount: 12,
    publishDays: 5,
    fieldCounts: [['阅读数', 12], ['点赞', 12]]
  });
  assert.equal(r.enough, true, '三项都满足时应判达标');
});

test('篇数不足时即使每字段对照充足也不达标', () => {
  const r = evaluateVerdict({
    publishedCount: 7,
    publishDays: 7,
    fieldCounts: [['阅读数', 30], ['点赞', 30]]
  });
  assert.equal(r.enough, false, '篇数 7/10 不达标');
});

test('字段列表为空时不能判达标', () => {
  const r = evaluateVerdict({ publishedCount: 12, publishDays: 5, fieldCounts: [] });
  assert.equal(r.enough, false, '没有任何字段对照不能算达标');
});

test('每字段对照必须按作品去重，不能按观测条数', () => {
  // 若按观测行数统计，7 篇被采 8 次就成了 56，会假性达标。
  assert.equal(/observations\.size/.test(src), false,
    '不应使用观测条数（observations.size）作为对照数');
  assert.match(src, /for \(const r of rows\)[\s\S]{0,200}perField\.set/,
    '每字段计数应遍历去重后的作品行');
});
