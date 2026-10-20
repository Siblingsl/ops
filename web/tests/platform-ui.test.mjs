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
  assert.match(source, /disabled=\{!canManage \|\| busy !== ''\}/);
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

test('连接卡片只对首版两个平台展示，头条不提供本机采集', async () => {
  const source = await readSource('pages/settings/Accounts.tsx');
  assert.match(source, /account\.platform === 'wechat_mp' \|\| account\.platform === 'xhs'/);
});

test('连接卡片调用的是固定端点，没有任意 URL 拼接', async () => {
  const source = await readSource('components/platform-connection.tsx');
  // 只允许这三条已知路径。
  const paths = [...source.matchAll(/\$\{accountId\}[^`'"]*/g)].map((m) => m[0]);
  for (const p of paths) {
    assert.ok(
      p.includes('/platform-connection') || p.includes('/metrics/observations') || p.includes('/platform-sync'),
      `出现未预期的端点拼接：${p}`
    );
  }
  assert.equal(/fetch\(|window\.open\(|eval\(/.test(source), false);
});

test('共享电脑与离线提示存在，关闭窗口等于暂停', async () => {
  const source = await readSource('components/platform-connection.tsx');
  assert.match(source, /客户端离线/);
  assert.match(source, /不会代你登录/);
});
