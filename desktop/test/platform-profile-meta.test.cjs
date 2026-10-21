const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  readAccountProfile,
  saveAccountProfile,
  accountProfileSlot,
  connectionProfileDir
} = require('../.build/platform-profile.js');

// DEV-PS38：账号 profile 归属校验的历史兼容。
//
// `accountId` 是后来才加入 meta 的字段。早期版本写的 profile 没有它，
// 如果严格要求一致，升级后所有老用户都会被判"归属不一致"而无法采集——
// 表现成"明明登录了却说没登录"。这在实际验证中真实发生过。

const origin = 'http://localhost:5174';
const userId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const deviceId = '33333333-3333-4333-8333-333333333333';
const accountId = '44444444-4444-4444-8444-444444444444';
const otherAccount = '55555555-5555-4555-8555-555555555555';
const platform = 'xhs';

function scope(overrides = {}) {
  return { origin, userId, workspaceId, deviceId, accountId, platform, ...overrides };
}

// writeLegacyProfile 写一份"旧版本" meta：没有 accountId / slotId / browserFamily。
function writeLegacyProfile(userData, overrides = {}) {
  const slotId = accountProfileSlot(scope());
  const dir = connectionProfileDir(userData, { userId, platform, connectionId: slotId });
  fs.mkdirSync(path.join(dir, 'profile'), { recursive: true });
  const metaDir = path.dirname(dir);
  const meta = {
    version: 1,
    origin,
    userId,
    workspaceId,
    deviceId,
    platform,
    connectionId: slotId,
    externalAccountKey: 'xhs_user_id:fixture',
    createdAt: new Date().toISOString(),
    ...overrides
  };
  // 显式删掉新字段，模拟旧版本写入的内容。
  delete meta.accountId;
  delete meta.slotId;
  delete meta.browserFamily;
  fs.writeFileSync(path.join(metaDir, 'meta.json'), JSON.stringify(meta), { mode: 0o600 });
  return dir;
}

test('旧版 meta 缺 accountId 时必须仍可读（不把老用户挡在外面）', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-legacy-meta-'));
  writeLegacyProfile(userData);

  const result = await readAccountProfile(userData, scope());
  assert.ok(result.meta, '旧版 meta 应能读到，不能返回 null');
  assert.equal(result.meta.accountId, undefined);
  // 其余归属字段仍应校验通过。
  assert.equal(result.meta.userId, userId);
  assert.equal(result.meta.platform, platform);

  fs.rmSync(userData, { recursive: true, force: true });
});

test('旧版 meta 的平台或工作区不符时仍要拒绝', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-legacy-reject-'));
  // 平台不符：窗口换了平台，不能复用。
  writeLegacyProfile(userData, { platform: 'wechat_mp' });
  await assert.rejects(
    () => readAccountProfile(userData, scope()),
    (err) => err.code === 'profile_meta_mismatch'
  );
  fs.rmSync(userData, { recursive: true, force: true });
});

test('新版 meta 的 accountId 不符时必须拒绝', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-new-reject-'));
  const slotId = accountProfileSlot(scope());
  const dir = connectionProfileDir(userData, { userId, platform, connectionId: slotId });
  fs.mkdirSync(path.join(dir, 'profile'), { recursive: true });
  // 写成"属于另一个账号"，但放在本账号的 slot 目录里：必须被发现。
  fs.writeFileSync(path.join(path.dirname(dir), 'meta.json'), JSON.stringify({
    version: 1, origin, userId, workspaceId, deviceId, platform,
    connectionId: slotId, externalAccountKey: 'xhs_user_id:fixture',
    createdAt: new Date().toISOString(),
    accountId: otherAccount, slotId, browserFamily: 'chrome'
  }), { mode: 0o600 });

  await assert.rejects(
    () => readAccountProfile(userData, scope()),
    (err) => err.code === 'profile_meta_mismatch'
  );
  fs.rmSync(userData, { recursive: true, force: true });
});

test('slot 从未登录时返回 meta=null，不报错', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-empty-slot-'));
  const result = await readAccountProfile(userData, scope());
  assert.equal(result.meta, null, '未登录的 slot 应返回 null 而不是抛错');
  fs.rmSync(userData, { recursive: true, force: true });
});
