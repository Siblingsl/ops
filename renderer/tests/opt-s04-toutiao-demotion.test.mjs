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

// OPT-S04：今日头条入口降权折叠（docs/43 §2.2）。
// 只锁源码契约，不重跑界面：默认新建只突出公众号/小红书，头条收进「更多实验平台」，
// 但历史头条账号与只读/导出链路必须原样保留。

test('新建账号默认只突出公众号与小红书，头条折叠进更多实验平台', async () => {
  const source = await readSource('components/account-forms.tsx');
  assert.match(source, /const PRIMARY_PLATFORMS: Platform\[\] = \['wechat_mp', 'xhs'\]/);
  // 默认网格只遍历主推平台，不再把头条并列成默认卡片。
  assert.match(source, /\{PRIMARY_PLATFORMS\.map\(\(p\) => \(/);
  assert.doesNotMatch(source, /\(\[[\s\S]{0,40}'wechat_mp',[\s\S]{0,10}'xhs',[\s\S]{0,10}'toutiao'\] as Platform\[\]\)\.map/);
  // 折叠开关与两态文案。
  assert.match(source, /data-testid="toggle-experimental-platforms"/);
  assert.match(source, /aria-expanded=\{showExperimental\}/);
  assert.match(source, /显示更多实验平台（暂缓维护）/);
  assert.match(source, /收起更多实验平台/);
  // 展开区明示主推平台与实验平台的发布限制。
  assert.match(source, /当前主推微信公众号与小红书/);
  assert.match(source, /仅支持发布包与手动导入/);
  // 收起时若仍选中头条，必须回落主推平台，避免隐藏的选中项被误提交。
  assert.match(source, /if \(platform === 'toutiao'\) pick\('wechat_mp'\)/);
  // 深链带 defaultPlatform="toutiao" 时自动展开，不失效。
  assert.match(source, /useState\(defaultPlatform === 'toutiao'\)/);
  // matrix.toutiao 完整保留，历史头条账号的类型切换不受影响。
  assert.match(source, /toutiao: \[[\s\S]*?long_article[\s\S]*?micro_post[\s\S]*?\]/);
});

test('账号切换器按 hasToutiaoAccount 决定是否展示头条，已有头条账号保持原全量 tab', async () => {
  const source = await readSource('layout/WorkspaceAccountTree.tsx');
  assert.match(source, /const PLATFORMS: Platform\[\] = \['wechat_mp', 'xhs', 'toutiao'\]/);
  assert.match(source, /const PRIMARY_PLATFORMS: Platform\[\] = \['wechat_mp', 'xhs'\]/);
  // 含停用账号判定，保证停用历史号也能找回。
  assert.match(source, /const hasToutiaoAccount = \(accounts \?\? \[\]\)\.some\(\(a\) => a\.platform === 'toutiao'\)/);
  assert.match(source, /const visiblePlatforms: Platform\[\] = hasToutiaoAccount \? PLATFORMS : PRIMARY_PLATFORMS/);
  // 桌面 tablist 与键盘导航、非桌面列表都必须走 visiblePlatforms。
  assert.match(source, /\{visiblePlatforms\.map\(\(p\) => \(/);
  const desktopTablist = source.split('role="tablist"')[1] ?? '';
  assert.match(desktopTablist.slice(0, 1200), /visiblePlatforms\.map/);
  assert.match(source, /const index = visiblePlatforms\.indexOf\(p\)/);
  // 无头条号时才出现折叠入口，并可从其中添加头条账号。
  assert.match(source, /\{!hasToutiaoAccount && \(/);
  assert.match(source, /data-testid="desktop-toggle-experimental-platforms"/);
  assert.match(source, /添加今日头条账号/);
  assert.match(source, /void openAccountCreate\('toutiao'\)/);
  // 选中态保护：无头条号且停在 toutiao 时回落主推平台。
  assert.match(source, /if \(!hasToutiaoAccount && platform === 'toutiao'\) setPlatform\('wechat_mp'\)/);
});

test('已有头条账号的详情卡、类型与历史只读能力保持原样', async () => {
  const source = await readSource('pages/settings/Accounts.tsx');
  // 既有头条账号的连接卡/详情入口不得被降权改动波及。
  assert.match(source, /\['wechat_mp', 'xhs', 'toutiao'\] as string\[\]\)\.includes\(account\.platform\)/);
  assert.match(source, /const platformConnectionCard = /);
  // 头条账号的默认创作形态与「已有作品保持原形态」说明仍在。
  assert.match(source, /account\.platform === 'toutiao' \? '默认创作形态' : '账号类型'/);
  assert.match(source, /每篇可选文章或微头条；修改默认值不影响已有内容/);
  // 深链创建仍支持携带 toutiao，不做后端/入口删除。
  assert.match(source, /\['wechat_mp', 'xhs', 'toutiao'\] as Platform\[\]\)\.find\(/);
});
