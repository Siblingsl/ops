import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));

// DEV-PS09 静态与逻辑校验（20 文档 §14、§4.3）。
// 这些用例直接读源码与已构建产物：确认界面不存在批量采用/全部入库入口，
// 并确认连接卡片的在线判定与开关禁用理由与文档一致。

const repoRoot = path.resolve(here, '..');
const webSrc = path.join(repoRoot, '..', 'web', 'src');

async function readSource(relative) {
  return fs.readFile(path.join(webSrc, relative), 'utf8');
}

test('界面不存在批量采用/全部入库/全部绑定入口', async () => {
  const files = [
    'components/platform-connection.tsx',
    'components/backfill.tsx',
    'pages/settings/Accounts.tsx',
    'pages/Review.tsx',
    'pages/work/Pack.tsx',
    'pages/work/Push.tsx'
  ];
  // 红线：任何“全部确认/批量采用/一键入库”的按钮或接口调用都不允许出现。
  // 只匹配“作为操作入口”的写法：按钮文案、接口路径或批量 API 名。
  // 既有检查提示（例如“检查还没有全部确认”）是业务说明，不算入口。
  const forbidden = [
    /<Button[^>]*>[^<]*全部/, /<Button[^>]*>[^<]*批量/, /<Button[^>]*>[^<]*一键/,
    /['"`]\/[^'"`]*(?:confirm|adopt)-all/i, /confirmAll/, /adoptAll/, /batchConfirm/, /batchAdopt/,
    /title="[^"]*全部采用/, /title="[^"]*全部入库/, /title="[^"]*批量采用/
  ];
  for (const file of files) {
    const source = await readSource(file);
    for (const pattern of forbidden) {
      assert.equal(pattern.test(source), false, `${file} 不应出现 ${pattern}`);
    }
  }
});

test('确认观测只按单条 id 调用，没有列表级接口', async () => {
  const source = await readSource('components/platform-connection.tsx');
  // 逐条确认：URL 里必须带单条 observation id。
  assert.match(source, /\/metrics\/observations\/\$\{[^}]+\}\/confirm/);
  // 不得出现不带 id 的批量确认调用。
  assert.equal(/\/metrics\/observations\/confirm/.test(source), false);
});

test('自动采用开关显示但禁用，并写明原因', async () => {
  const source = await readSource('components/platform-connection.tsx');
  // 自动采用必须 disabled，且给出“待正式验收”的理由。
  assert.match(source, /autoAdoptDisabledReason/);
  assert.match(source, /待每平台 10 篇以上逐字段正式验收完成后开放/);
  assert.match(source, /checked=\{connection\.auto_adopt\}\s+disabled\s+readOnly/);
  // 自动采集允许 owner 操作，但仍受 canManage 控制。
  assert.match(source, /disabled=\{!canManage \|\| busy !== '' \|\| accountStatus !== 'active'\}/);
});

test('在线状态按 90 秒 TTL 如实显示，不猜测', async () => {
  const source = await readSource('components/platform-connection.tsx');
  assert.match(source, /90_000/);
  // 未知状态单独呈现，不能默认显示“在线”。
  assert.match(source, /在线状态未知/);
});

test('绑定冲突 409 逐条处理并给出跳转，不静默覆盖', async () => {
  const source = await readSource('components/backfill.tsx');
  assert.match(source, /platform_binding_conflict/);
  assert.match(source, /先在那里解除绑定/);
  // 绑定必须带两个版本，供服务端做 CAS。
  assert.match(source, /metric_binding_revision/);
  assert.match(source, /publish_revision/);
});

test('口径不明时界面明确提示不计入统计，而不是显示成 0', async () => {
  const review = await readSource('pages/Review.tsx');
  assert.match(review, /口径不明（未计入统计）/);
  const connection = await readSource('components/platform-connection.tsx');
  assert.match(connection, /口径不明/);
  // 单位标签必须覆盖 users/times/unknown。
  assert.match(connection, /users: '人数'/);
  assert.match(connection, /times: '次数'/);
  assert.match(connection, /unknown: '口径不明'/);
});

test('头条可打开官方登录页，但不读取连接与采集接口', async () => {
  const accounts = await readSource('pages/settings/Accounts.tsx');
  const connection = await readSource('components/platform-connection.tsx');
  assert.match(accounts, /\['wechat_mp', 'xhs', 'toutiao'\]/);
  assert.match(connection, /if \(platform === 'toutiao'\)/);
  assert.match(connection, /const canOpenToutiao = !adminOverride && accountStatus === 'active' && role !== 'viewer'/);
  assert.match(connection, /isToutiao \? '打开头条官方登录页' : '在本机扫码登录'/);
});

test('连接卡片通过共享封装调用固定平台意图，没有任意 URL 拼接', async () => {
  const source = await readSource('components/platform-connection.tsx');
  const intentHelper = await readSource('lib/desktop-platform-intent.ts');
  for (const endpoint of [
    /`\/accounts\/\$\{accountId\}\/platform-connection`/,
    /`\/accounts\/\$\{accountId\}\/metrics\/observations`/,
    /`\/accounts\/\$\{accountId\}\/platform-sync-operations\?limit=20`/,
    /`\/metrics\/observations\/\$\{observationId\}\/confirm`/,
  ]) assert.match(source, endpoint);
  assert.match(source, /requestDesktopPlatformIntent\(\{\s*type: 'platform-account-sync'/);
  assert.match(source, /requestDesktopPlatformIntent\(\{\s*type: 'platform-metrics-refresh'/);
  assert.match(source, /requestDesktopPlatformIntent\(\{\s*type: 'platform-sync-resume'/);
  assert.match(intentHelper, /ops-desktop:\/\/ui\/platform-account-sync/);
  assert.match(intentHelper, /ops-desktop:\/\/ui\/platform-metrics-refresh/);
  assert.match(intentHelper, /ops-desktop:\/\/ui\/platform-sync-resume/);
  assert.match(intentHelper, /result\.kind !== request\.type \|\| result\.accountId !== request\.accountId \|\| result\.requestId !== requestId/);
  assert.match(intentHelper, /result\.operationId !== request\.operationId/);
  assert.match(source, /window\.open\(`ops-desktop:\/\/ui\/platform-login\/\$\{accountId\}\/\$\{platform\}`/);
  assert.equal(/opsDesktopSettings/.test(source), false, '业务窗口不应引用 opsDesktopSettings');
  assert.equal(/\bfetch\(|\beval\(/.test(source), false);
});

test('平台作品详情只按明确选中的镜像 ID 请求单篇指标刷新', async () => {
  const source = await readSource('pages/platform-works.tsx');
  const desktopClient = await fs.readFile(path.join(repoRoot, '..', 'desktop', 'src', 'desktop-client.ts'), 'utf8');
  const intents = await fs.readFile(path.join(repoRoot, '..', 'desktop', 'src', 'ui-intents.ts'), 'utf8');
  assert.match(source, /刷新此篇指标/);
  assert.match(source, /platformWorkId: mirrorID/);
  assert.equal(/opsDesktopSettings/.test(source), false, '业务窗口不应引用 opsDesktopSettings');
  // 单篇 work ID 只进入固定的单个可选深链段，并转为 explicit 目标。
  assert.match(intents, /platformWorkId\?: string/);
  assert.match(intents, /\(\?:\(\$\{UUID\}\)\/\)\?/);
  assert.match(desktopClient, /platformWorkIds\?: string\[\]/);
  assert.match(desktopClient, /target_scope: input\.platformWorkIds\?\.length \? 'explicit' : 'due_and_recent'/);
});

test('共享电脑与离线提示存在，关闭窗口等于暂停', async () => {
  const source = await readSource('components/platform-connection.tsx');
  assert.match(source, /客户端离线/);
  assert.match(source, /不会代你登录/);
});

// DEV-PS30：熔断恢复的管理页界面（20 文档 §12）。
// 浏览器实测受业务窗口路由守卫限制，改用源码契约测试锁住关键约束。
test('熔断卡片：必须让用户手填新 mapping_version，不得静默自增', async () => {
  const source = await readSource('pages/settings/Admin.tsx');
  // 必须有恢复入口与查询。
  assert.match(source, /\/admin\/platform\/breakers/);
  assert.match(source, /breakers\/\$\{[^}]+\}\/resolve/);
  // 必须要求用户输入版本号（prompt），而不是直接写死 +1 提交。
  assert.match(source, /window\.prompt\(/);
  assert.match(source, /mapping_version/);
  // 恢复前必须有二次确认。
  assert.match(source, /确认恢复熔断/);
  // 红线：不得出现“全部恢复/批量恢复”这类操作。
  for (const pattern of [/<Button[^>]*>[^<]*全部恢复/, /<Button[^>]*>[^<]*批量恢复/, /resolveAll/, /batchResolve/]) {
    assert.equal(pattern.test(source), false, `不应出现 ${pattern}`);
  }
});

test('熔断卡片：明确告知恢复后不会自动重开自动采集', async () => {
  const source = await readSource('pages/settings/Admin.tsx');
  // 这是恢复动作最容易被误解的一点：用户以为“恢复了就一切照旧”。
  assert.match(source, /不会自动重开/);
  // 必须显示熔断原因与影响范围，便于判断该不该恢复。
  assert.match(source, /error_code/);
  assert.match(source, /affected_connections/);
});

// DEV-AS15：同步启用条件的收口（20 文档 §17.2、§21.15）。
// 每平台同步能力此前只能由 fixture 直写 system_setting；工作区策略只有 PUT 接口
// 没有 UI。这里锁定两处新入口的契约：逐项开关、无批量语义、带版本号提交。
test('工作区平台数据读取开关：owner 逐工作区提交并带授权版本', async () => {
  const source = await readSource('components/platform-connection.tsx');
  // owner 的开关在“尚未连接”分支也必须出现（设备登记要求策略先开启）。
  assert.match(source, /启用本工作区平台数据读取/);
  // PUT 必须带当前 authorization_revision 做版本比较，不得盲写。
  assert.match(source, /authorization_revision:\s*policy\.authorization_revision/);
  // 禁止出现一次改多个策略键的批量调用。
  assert.equal(/platform-collection\/policy['"`]\s*,\s*\{[^}]*allow_member_connections:\s*true[^}]*enabled:\s*true/.test(source), false);
});

test('超管平台同步能力开关：按功能×平台逐项提交', async () => {
  const source = await readSource('pages/settings/Admin.tsx');
  assert.match(source, /platform_feature:\s*\{\s*feature,\s*platform,\s*enabled/);
  // 只允许两个 feature 与两个平台的固定组合，一次一项。
  assert.match(source, /'account_sync', 'metrics_refresh'/);
  assert.match(source, /'xhs', 'wechat_mp'/);
  // 红线：不得出现“全部开启/一键开启”入口。
  for (const pattern of [/<Button[^>]*>[^<]*全部开启/, /<Button[^>]*>[^<]*一键开启/, /enableAllPlatforms/]) {
    assert.equal(pattern.test(source), false, `不应出现 ${pattern}`);
  }
});
