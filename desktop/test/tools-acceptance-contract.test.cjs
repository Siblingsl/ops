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

// DEV-PS101：报告必须能区分"采集之后读数涨了"与"采集记错了"。
//
// 缺陷背景：2026-10-26 的实跑报告有 2 条不一致（平台=645 观测=644、平台=28 观测=27），
// 看起来像采集错误，实际观测是 2 小时前采的，平台计数在这段时间自然涨了 1。
// 旧报告不带观测时间，也没有任何提示，两种完全不同的处置被压成同一句话。
//
// 这里的测试都是**真跑函数**，不是文本匹配——把提示改成常量字符串后，
// 正则照样匹配，测试却仍然通过（本文件早先已踩过这个坑）。

// extractFunction 从工具源码里取出一个具名函数声明并求值，返回真正的函数对象。
function extractFunction(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `应能在工具源码里找到 function ${name}`);
  // 从函数头开始按花括号配平，取到函数结束。
  const open = src.indexOf('{', start);
  assert.ok(open > start, `${name} 应有函数体`);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        // eslint-disable-next-line no-new-func
        return new Function(`return (${src.slice(start, i + 1)})`)();
      }
    }
  }
  throw new Error(`未能配平 ${name} 的花括号`);
}

test('parseDbTimestamp 必须认得 psql 的 +00 偏移', () => {
  // psql -t -A 输出的 timestamptz 是 `2026-10-26 03:22:55.343+00`，
  // 而 JS 的 Date 只认 +00:00，直接传会得到 Invalid Date，
  // 报告就退回"观测时间未知"——那正是本次要修的问题。
  const parseDbTimestamp = extractFunction('parseDbTimestamp');
  const d = parseDbTimestamp('2026-10-26 03:22:55.343+00');
  assert.ok(d instanceof Date && !Number.isNaN(d.getTime()),
    'psql 的 +00 偏移必须能解析成有效时间');
  assert.equal(d.toISOString(), '2026-10-26T03:22:55.343Z');
  assert.equal(parseDbTimestamp('2026-10-26 03:22:55.343+00:00').toISOString(), '2026-10-26T03:22:55.343Z');
  assert.equal(parseDbTimestamp('2026-10-26T03:22:55Z').toISOString(), '2026-10-26T03:22:55.000Z');
});

test('parseDbTimestamp 解析不了时必须返回 null，不能编一个时间', () => {
  const parseDbTimestamp = extractFunction('parseDbTimestamp');
  for (const bad of ['', '   ', 'garbage', null, undefined]) {
    assert.equal(parseDbTimestamp(bad), null, `${JSON.stringify(bad)} 应返回 null`);
  }
});

test('平台读数更大时，历史单调递增才提示"像采集后增长"', () => {
  const growthHint = extractFunction('growthHint');
  const grew = growthHint({ grew: true, history: { values: [400, 400, 416], monotonic: true } });
  assert.match(grew, /采集后增长/, '单调递增应提示像采集后增长');
  assert.match(grew, /需重采后再对照/, '必须给出复核动作，不能只说"可能没问题"');
});

test('历史里出现过下降时，不能用"增长"解释', () => {
  // 计数器不会降。历史降过说明这个字段不是单调计数器，
  // 拿"会涨"糊过去就是掩盖一个真实缺陷。
  const growthHint = extractFunction('growthHint');
  const hint = growthHint({ grew: true, history: { values: [30, 28, 29], monotonic: false } });
  assert.match(hint, /按记错排查/, '非单调时必须按记错排查');
  assert.equal(/采集后增长/.test(hint), false, '非单调时不应说成增长');
});

test('没有历史时不能给出"增长"结论', () => {
  const growthHint = extractFunction('growthHint');
  const hint = growthHint({ grew: true, history: null });
  assert.match(hint, /无法判断/, '没有历史只能写无法判断');
  assert.equal(/采集后增长/.test(hint), false, '没有历史时不应说成增长');
});

test('平台读数更小时不产生任何增长提示', () => {
  const growthHint = extractFunction('growthHint');
  assert.equal(growthHint({ grew: false, history: null }), '');
});

test('不一致仍计入不一致：提示只是解释，不能把差值洗成一致', () => {
  // 这是本改动的红线：报告可以解释差值，但 `mismatched` 的计数与
  // 退出码都必须照旧由真实差值决定。
  assert.match(src, /let grewCount = 0;/);
  assert.match(src, /if \(verdict === 'match' \|\| verdict === 'both_missing'\) matched \+= 1;\s*\n\s*else mismatched \+= 1;/,
    'mismatch 必须计入 mismatched，不能被 grew 分支截走');
  assert.match(src, /process\.exit\(result\.mismatched > 0 \? 1 : 0\)/,
    '退出码必须仍由 mismatched 决定');
});

