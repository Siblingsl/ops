const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// 服务端源码在仓库根的 server/internal/app 下（本文件在 desktop/test）。
const appDir = path.join(__dirname, '..', '..', 'server', 'internal', 'app');

function readGo(name) {
  return fs.readFileSync(path.join(appDir, name), 'utf8');
}

// DEV-PS44 源码契约：聚合查询必须按 read_unit 分组（20 文档 §8.4）。
//
// 为什么用源码契约而不是行为测试：这些聚合都在 `generateBriefForDay` / `dailyStats` /
// `tagSuggest` 内部，需要构造完整上下文（AI 调用、推荐记录、议题关联），
// 行为测试成本极高且不稳定。而缺陷本质就是"SQL 里少了单位判断"，
// 直接断言 SQL 文本既可靠又低成本。
//
// 实测缺陷：`brief.go` 的 `sum(reads)`、`daily_stats.go` 的两处 `avg(reads)`、
// `smart.go` 的 `avg(mx.reads)` 都不区分 read_unit，
// 会把 `times`（次数）和 `users`（人数）直接相加/平均，得出没有含义的数字。

test('服务端聚合查询必须按 read_unit 分组（brief / daily_stats / smart）', () => {
  const brief = readGo('brief.go');
  // 求和必须排除 unknown 单位。
  assert.match(brief, /coalesce\(d\.read_unit,'unknown'\) <> 'unknown'/,
    'brief 的求和必须排除 unknown 单位');
  // 必须按单位分组：不止一种已知单位时返回 NULL。
  assert.match(brief, /CASE WHEN count\(DISTINCT unit\) > 1 THEN NULL/,
    'brief 在已知单位混在一起时必须返回 NULL');

  const daily = readGo('daily_stats.go');
  const guarded = daily.match(/count\(DISTINCT unit\) FILTER \(WHERE reads IS NOT NULL AND unit <> 'unknown'\) > 1/g) ?? [];
  assert.ok(guarded.length >= 2,
    `daily_stats 的两处 avg 都要按单位分组，实际找到 ${guarded.length} 处`);
  const filtered = daily.match(/avg\(reads\) FILTER \(WHERE unit <> 'unknown'\)/g) ?? [];
  assert.ok(filtered.length >= 2,
    `daily_stats 的两处 avg 都要排除 unknown，实际找到 ${filtered.length} 处`);

  const smart = readGo('smart.go');
  assert.match(smart, /count\(DISTINCT unit\) FILTER \(WHERE reads IS NOT NULL AND unit <> 'unknown'\) > 1/,
    'smart 的话题均值必须按单位分组');
  // 不允许再出现不区分单位的 avg。
  assert.equal(/avg\(mx\.reads\)/.test(smart), false,
    '不应存在不区分单位的 avg(mx.reads)');
});
