const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const srcDir = path.join(__dirname, '..', 'src');
const clientSrc = fs.readFileSync(path.join(srcDir, 'platform-client.ts'), 'utf8');
const mainSrc = fs.readFileSync(path.join(srcDir, 'main.ts'), 'utf8');

// DEV-PS48 源码契约：客户端必须消费服务端回执里的 adopt_errors / adopt_reason。
//
// 缺陷背景：服务端（DEV-PS46）在 auto_adopt 投影失败时会返回
// `adopt_errors` 与 `adopt_reason`，但客户端的 `PlatformReceipt` 接口
// 没有这两个字段，采集完成后也不输出——用户只看到 `accepted: 7`，
// 以为数据已全部进入正式指标。
//
// 这类"采到了但没生效"的静默半成功，比彻底失败更难发现：
// run 状态是 succeeded、观测表里也确实有记录，唯独正式指标里没有。

test('PlatformReceipt 必须声明 adopt_errors 与 adopt_reason', () => {
  // 从接口定义中截取字段块，避免匹配到别处的同名字符串。
  const start = clientSrc.indexOf('export interface PlatformReceipt');
  assert.ok(start > 0, '应存在 PlatformReceipt 接口');
  const block = clientSrc.slice(start, clientSrc.indexOf('}', start) + 1);
  assert.match(block, /adopt_errors\??:\s*number/, 'PlatformReceipt 应声明 adopt_errors');
  assert.match(block, /adopt_reason\??:\s*string/, 'PlatformReceipt 应声明 adopt_reason');
});

test('采集结果必须把 adopt_errors 透传到 outcome', () => {
  // 成功路径要把回执里的字段带进返回值。
  assert.match(mainSrc, /adoptErrors:\s*receipt\.adopt_errors\s*\?\?\s*0/,
    '成功路径应把 receipt.adopt_errors 透传为 adoptErrors');
  assert.match(mainSrc, /adoptReason:\s*receipt\.adopt_reason\s*\?\?\s*null/,
    '成功路径应把 receipt.adopt_reason 透传为 adoptReason');
});

test('PlatformCollectOutcome 的每个返回点都必须给出 adoptErrors', () => {
  // 找出所有 `accepted: ..., rejected: ...` 形式的返回值（outcome 构造点）。
  const returns = [...mainSrc.matchAll(/accepted:\s*[^,\n]+,\s*rejected:\s*[^,\n]+/g)];
  assert.ok(returns.length >= 5, `应至少有 5 处 outcome 构造点，实际 ${returns.length}`);
  // 每一处的后续 3 行内必须出现 adoptErrors。
  const missing = [];
  for (const m of returns) {
    const tail = mainSrc.slice(m.index, m.index + 260);
    if (!/adoptErrors/.test(tail)) {
      missing.push(m[0].slice(0, 60));
    }
  }
  assert.deepEqual(missing, [], `以下返回点缺少 adoptErrors：${missing.join(' | ')}`);
});

test('自动采集日志必须输出且告警 adoptErrors', () => {
  // 日志里要带上这两个字段。
  assert.match(mainSrc, /adoptErrors:\s*outcome\.adoptErrors/,
    '完成日志应输出 adoptErrors');
  // 失败时必须有一条明确的中文告警，不能只靠一行 JSON。
  assert.match(mainSrc, /if \(outcome\.adoptErrors > 0\)[\s\S]{0,400}未写入正式指标/,
    'adoptErrors > 0 时应打出明确的中文告警');
});
