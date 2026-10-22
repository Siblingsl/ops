const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// 服务端源码在仓库根的 server/internal/app 下（本文件在 desktop/test）。
const appDir = path.join(__dirname, '..', '..', 'server', 'internal', 'app');

function readGo(name) {
  return fs.readFileSync(path.join(appDir, name), 'utf8');
}

// DEV-PS58 源码契约：日常统计消费单位安全投影，未知单位不写入正式读数。
//
// 为什么用源码契约而不是行为测试：这些聚合都在 `generateBriefForDay` / `dailyStats` /
// `tagSuggest` 内部，需要构造完整上下文（AI 调用、推荐记录、议题关联），
// 行为测试成本极高且不稳定。brief 直接汇总节点时仍需按单位隔离；daily_stats
// 和 smart 则读取 projectObservation 产出的公开节点，不重复过滤 unknown。
//
// DEV-PS44 曾给 daily_stats 增加 unknown 过滤，导致旧记录的均值为空；DEV-PS58
// 将单位保护收回投影层，且保留 brief 的多单位隔离。

test('服务端统计保留 brief 单位隔离并在其他聚合中消费单位安全投影', () => {
  const brief = readGo('brief.go');
  // 求和必须排除 unknown 单位。
  assert.match(brief, /coalesce\(d\.read_unit,'unknown'\) <> 'unknown'/,
    'brief 的求和必须排除 unknown 单位');
  // 必须按单位分组：不止一种已知单位时返回 NULL。
  assert.match(brief, /CASE WHEN count\(DISTINCT unit\) > 1 THEN NULL/,
    'brief 在已知单位混在一起时必须返回 NULL');

  const daily = readGo('daily_stats.go');
  assert.match(daily, /metric_node_d7_public\(w\.id\)/,
    'daily_stats 必须使用已投影并按节点选出的公开指标');
  assert.equal(/FROM\s+metric_snapshot/i.test(daily), false,
    'daily_stats 不应绕过公开指标投影直接读取原始快照');

  const smart = readGo('smart.go');
  assert.match(smart, /metric_node_d7_public\(w\.id\)/,
    'smart 必须使用已投影并按节点选出的公开指标');
  assert.equal(/FROM\s+metric_snapshot/i.test(smart), false,
    'smart 不应绕过公开指标投影直接读取原始快照');

  const projection = readGo('metric_projection.go');
  assert.match(projection, /ReadUnit:\s+metricUnitUnknown/,
    '正式读数的单位默认必须未知');
  assert.match(projection, /if probe\.Unit == metricUnitUnknown/,
    '观测单位未知时不得投影正式读数');
  assert.match(projection, /proj\.ReadUnit = rule\.Unit/,
    '投影后的正式读数必须保留其已确认单位');
});
