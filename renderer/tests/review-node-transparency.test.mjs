import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(here, '..');

async function readSource(relative) {
  return fs.readFile(path.join(rendererRoot, relative), 'utf8').then((text) => text.replace(/\r\n/g, '\n'));
}

// RC-19 修复：桌面复盘看板必须把“非第 7 天节点”说清楚；全 day_offset=7 时标题与 DOM 保持原样。
test('桌面复盘看板：非第 7 天/未知节点逐行标注，day7 行零多余提示', async () => {
  const review = await readSource('pages/Review.tsx');
  assert.match(review, /const reviewNodeNote = \(m: Pick<Metric, 'day_offset'> \| null \| undefined\) => \{/);
  assert.match(review, /if \(!m \|\| m\.day_offset === 7\) return ''/);
  assert.ok(review.includes("m.day_offset == null ? '按发布时间未知节点' : `按第 ${m.day_offset} 天`"));
  assert.match(review, /const nodeNote = reviewNodeNote\(row\.d7\)/);
  assert.match(review, /nodeNote && 'desktop-review-source-cell--node'/);
  assert.match(review, /nodeNote && <span className="desktop-review-node-label">\{nodeNote\}<\/span>/);
});

test('桌面复盘看板：混合节点标题单行提示，全 day7 保持默认文案与 DOM', async () => {
  const review = await readSource('pages/Review.tsx');
  assert.match(review, /const hasNonSevenNode = rows\.some\(\(r\) => r\.d7 && r\.d7\.day_offset !== 7\)/);
  assert.ok(review.includes("'作品数据 · 默认第 7 天（缺第 7 天按实采节点）'"));
  assert.ok(review.includes("'作品数据 · 发布后第 7 天'"));
  assert.ok(review.includes("className={hasNonSevenNode ? 'desktop-review-board-heading-mixed' : undefined}"));
  // 默认文案只在混合节点分支出现，不能无条件替换掉原 h2 文本。
  assert.equal(review.split("'作品数据 · 发布后第 7 天'").length - 1, 1);
});

test('桌面看板节点标注样式：仅非第 7 天行预留右侧按钮空间，标题单行不换行', async () => {
  const css = await readSource('styles/desktop-creative.css');
  assert.match(css, /\.desktop-review-source-cell--node \{ padding-right: 22px; \}/);
  assert.match(css, /\.desktop-review-node-label \{ margin-left: 6px; color: var\(--ops-muted\); font-size: 11px; \}/);
  assert.match(css, /\.desktop-review-board-heading-mixed \{ white-space: nowrap; \}/);
});

test('指标导入：带格式错误且被强行选作品的行不得提交，预览展示采集时间', async () => {
  const review = await readSource('pages/Review.tsx');
  assert.match(review, /if \(rows\.some\(\(r\) => r\.work_id && r\.error\)\) \{/);
  assert.match(review, /toast\.error\('存在格式错误的行，请先修正或跳过后再导入'\)/);
  // 匹配结论必须是独立文本节点，CSV/复盘 E2E 仍按「已精确匹配」精确文本定位；
  // 采集时间另起 span，不能把整行拼成一个含「· 采集」的节点。
  assert.ok(review.includes("<span>{r.match_type === 'exact' ? '已精确匹配'"));
  assert.ok(review.includes('{!r.error && r.captured_at && <span>{` · 采集 ${r.captured_at}`}</span>}'));
});
