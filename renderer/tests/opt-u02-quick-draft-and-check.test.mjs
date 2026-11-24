import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(here, '..');

async function readSource(relative) {
  return fs.readFile(path.join(rendererRoot, relative), 'utf8');
}

// OPT-U02（docs/43 §4）：快写双模式 + 检查页分级减负 + 根治 Q-14。
// 只锁源码契约，不重跑界面：
// 1) 快写完全复用既有合法端点 `/organize-notes` 与 `/organize-notes/apply`，不新增 draft/batch 路由；
// 2) 观点卡、大纲入口、H-02/H-03 闸门、口述事件监听一律保留；
// 3) 检查页只做视觉分层：未通过格式进主列表，已通过格式默认折叠；人工项仍逐条确认，无「全部确认」。

test('快写模式：空稿首屏双模式切换复用既有 organize-notes 合法链路', async () => {
  const editor = await readSource('pages/work/Editor.tsx');
  // 只在「未确认大纲 + 还没有段落」的空稿首屏出现，且专注模式/只读态不打扰。
  assert.match(editor, /!focus && !readOnly && !work\.outline_confirmed_at && work\.sections\.length === 0 && <QuickDraftModeCard/);
  assert.match(editor, /data-testid="editor-writing-mode"/);
  assert.match(editor, /data-testid=\{m === 'quick' \? 'writing-mode-quick' : 'writing-mode-structured'\}/);
  // 平台/体裁默认选中：小红书与短图文默认快写，其余默认结构化深写。
  assert.match(editor, /if \(work\.platform === 'xhs'\) return 'quick'/);
  assert.match(editor, /work\.content_format === 'micro_post' \|\| work\.content_format === 'briefing' \? 'quick' : 'structured'/);
  // 复用现有合法端点：流式预览 + 一步写入，不新增任何路由。
  assert.ok(editor.includes('`/works/${work.id}/organize-notes`'));
  assert.ok(editor.includes('`/works/${work.id}/organize-notes/apply`'));
  assert.doesNotMatch(editor, /`\/works\/\$\{work\.id\}\/draft/);
  assert.doesNotMatch(editor, /`\/works\/\$\{work\.id\}\/batch/);
  // 生成、停止、重新生成、写入四个动作与统一 AI 失败提示。
  assert.match(editor, /一键生成完整初稿/);
  assert.match(editor, /停止生成/);
  assert.match(editor, /重新生成/);
  assert.match(editor, /确认并写入正文/);
  assert.match(editor, /aiError\(e, '快写生成', run\)/);
  // 首次空稿写入不弹覆盖确认；已有段落才确认，避免误覆盖。
  assert.match(editor, /if \(work\.sections\.length > 0 && !\(await confirm\(\{ title: '用整理结果覆盖当前正文？'/);
  // 写入后缺观点才兜底：取要点首句、≤120 字符、失败静默降级不影响正文。
  assert.match(editor, /if \(!applied\.viewpoint\.trim\(\)\)/);
  assert.match(editor, /Array\.from\(sentence \|\| cleaned\)\.slice\(0, 120\)\.join\(''\)/);
  assert.match(editor, /catch \{ \/\* 观点兜底失败静默降级，已写入的正文不受影响 \*\/ \}/);
  assert.match(editor, /toast\.success\('已生成大纲并写入正文，现在可逐段修改或生成标题'\)/);
});

test('快写模式不删旧入口：观点卡、大纲卡、H-03 闸门与顶栏口述事件监听保留', async () => {
  const editor = await readSource('pages/work/Editor.tsx');
  assert.match(editor, /function ViewpointCard\(/);
  assert.match(editor, /function OrganizeNotesCard\(/);
  assert.match(editor, /window\.addEventListener\('ops:organize-notes', open\)/);
  assert.match(editor, /window\.removeEventListener\('ops:organize-notes', open\)/);
  assert.match(editor, /<ViewpointCard work={work} setWork={setWorkStable}/);
  assert.match(editor, /<OutlineCard work={work} setWork={setWorkStable}/);
  assert.match(editor, /<HumanGate code="H-03"/);
  // H-02 仍由观点卡的保存链路承担；快写不在前端伪造观点。
  assert.match(editor, /Badge tone="gamboge">H-02 必须由你来写/);
});

test('检查页 Q-14：网格 items-start + 桌面出口内滚动 + 操作条不再遮挡', async () => {
  const check = await readSource('pages/work/Check.tsx');
  assert.match(check, /grid items-start gap-6 lg:grid-cols-\[1fr_420px\]/);
  // 桌面 .desktop-work-layout 固定高度 + overflow: clip，检查页必须自己当滚动出口。
  assert.match(check, /desktopPresentation && 'h-full overflow-y-auto scrollbar-thin'/);
  // 桌面出口只有 320px 高，右列再 sticky 会把下半段永久钉在视口外；浏览器形态保留 sticky + 显式 max-h。
  assert.match(check, /!desktopPresentation && 'lg:sticky lg:top-20 lg:max-h-\[calc\(100vh-6\.5rem\)\] lg:overflow-y-auto'/);
  assert.match(check, /document\.documentElement\.dataset\.presentation === 'ops-creative-desktop'/);
  assert.doesNotMatch(check, /lg:bottom-4/);
  // lg 起操作条随内容流排在最后，真实点击不会被渐变层拦截。
  assert.match(check, /lg:static lg:pt-2/);
});

test('检查页分级：必须处理汇总 + 已通过格式规则默认折叠 + 逐条确认红线不变', async () => {
  const check = await readSource('pages/work/Check.tsx');
  assert.match(check, /const formatFailed = run\?\.items\.filter\(\(i\) => i\.category === 'format' && !i\.passed\) \?\? \[\]/);
  assert.match(check, /const formatPassed = run\?\.items\.filter\(\(i\) => i\.category === 'format' && i\.passed === true\) \?\? \[\]/);
  assert.match(check, /const mustHandle = formatFailed\.length \+ \(run \? run\.total - run\.confirmed : 0\)/);
  // 汇总卡：必须处理数 + 待逐条确认数；归零时给清爽通过态。
  assert.match(check, /data-testid="check-priority-summary"/);
  assert.match(check, /必检项已全部处理完成/);
  assert.match(check, /待逐条确认 <span className="font-medium tabular-nums text-mist-900">\{run\.total - run\.confirmed\}/);
  assert.match(check, /已通过格式规则 \{formatPassed\.length\} 项（默认折叠）/);
  // 主列表只保留未通过格式项；已通过项收进底部 details，信息 100% 可查。
  assert.match(check, /i\.category === c && \(c !== 'format' \|\| !i\.passed\)/);
  assert.match(check, /data-testid="check-passed-format-section"/);
  assert.match(check, /已通过的格式规则（\{formatPassed\.length\} 项）/);
  // 红线：人工确认仍是单条 PATCH，fact 分组与 H-04 闸门原样保留，且没有批量入口。
  assert.match(check, /`\/check-items\/\$\{item\.id\}`/);
  assert.match(check, /data-testid=\{group\.label === '有素材支撑' \? 'fact-subgroup-supported' : 'fact-subgroup-unverified'\}/);
  assert.match(check, /<HumanGate code="H-04">每一条敏感词和事实都需要你单独确认，没有「全部确认」。<\/HumanGate>/);
  assert.doesNotMatch(check, /checks\/confirm-all|check-items\/batch|check-items\/all|resolveAll|confirmAllItems/);
});

test('E2E：Q-14 修复后恢复真实点击，注册流先展开实验平台再选头条', async () => {
  const g6 = await readSource('e2e/g6-review-import-quality.spec.ts');
  assert.match(g6, /await checkbox\.check\(\)/);
  assert.match(g6, /await native\.locator\(`input\[name="\$\{item\.id\}"\]`\)\.first\(\)\.check\(\)/);
  assert.doesNotMatch(g6, /evaluate\(\(el\) => \(el as HTMLInputElement\)\.click\(\)\)/);

  const support = await readSource('e2e/support.ts');
  assert.match(support,
    /if \(platform === 'toutiao'\) \{\n    await dialog\.getByTestId\('toggle-experimental-platforms'\)\.click\(\)\n  \}/);
});
