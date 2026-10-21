const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PLATFORM_OPERATION_PATHS,
  resolvePlatformEndpoint
} = require('../.build/platform-capability.js');
const {
  removeConnectionNamespace,
  connectionProfileDir,
  PlatformProfileError
} = require('../.build/platform-profile.js');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const capability = {
  protocol_version: 1,
  enabled: true,
  platforms: ['xhs', 'wechat_mp'],
  purpose: 'platform_collection',
  operations: [
    'platform.connection.create',
    'platform.connection.verify',
    'platform.connection.mine.list',
    'platform.connection.mine.revoke',
    'platform.presence'
  ],
  limits: {}
};

// 命名空间只接受 UUID，用固定虚构值。
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CONN_KEEP = '22222222-2222-4222-8222-222222222222';
const CONN_DROP = '33333333-3333-4333-8333-333333333333';

test('回收操作必须在客户端白名单里，且方法/路径正确', () => {
  const endpoint = resolvePlatformEndpoint(capability, 'platform.connection.mine.revoke');
  // DELETE 而不是 POST：回收是幂等减权，语义上必须是 DELETE。
  assert.equal(endpoint.method, 'DELETE');
  assert.equal(endpoint.path, '/api/v1/desktop/platform/connections/{id}');
  // 服务端未公布时拒绝发起（旧服务端不认这个操作）。
  assert.throws(
    () => resolvePlatformEndpoint({ ...capability, operations: ['platform.connection.create'] },
      'platform.connection.mine.revoke'),
    /线上服务未开放平台操作/
  );
  // 客户端必须内置，否则无法发起。
  assert.equal(PLATFORM_OPERATION_PATHS['platform.connection.mine.revoke'].method, 'DELETE');
});

test('清理只删该连接的目录，不动账号命名空间与其它连接', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-profile-clean-'));
  const keep = { userId: USER_ID, platform: 'xhs', connectionId: CONN_KEEP };
  const drop = { userId: USER_ID, platform: 'xhs', connectionId: CONN_DROP };
  const keepDir = connectionProfileDir(userData, keep);
  const dropDir = connectionProfileDir(userData, drop);
  fs.mkdirSync(keepDir, { recursive: true });
  fs.mkdirSync(dropDir, { recursive: true });
  fs.writeFileSync(path.join(keepDir, 'marker'), 'keep');
  fs.writeFileSync(path.join(dropDir, 'marker'), 'drop');

  const result = await removeConnectionNamespace(userData, drop);
  assert.equal(result.removed, true);

  // 被回收连接的目录已删。
  assert.equal(fs.existsSync(path.dirname(dropDir)), false);
  // 同账号的其它连接必须保留——不能整目录递归删账号命名空间。
  assert.equal(fs.existsSync(path.join(keepDir, 'marker')), true);

  fs.rmSync(userData, { recursive: true, force: true });
});

test('非 UUID 的连接或用户标识一律拒绝，防路径穿越', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-profile-escape-'));
  // 穿越式 connectionId：必须在进入文件系统前就被拒绝。
  await assert.rejects(
    () => removeConnectionNamespace(userData, {
      userId: USER_ID, platform: 'xhs', connectionId: '../../escape'
    }),
    (err) => err instanceof PlatformProfileError && err.code === 'invalid_namespace'
  );
  // 穿越式 userId 同样拒绝。
  await assert.rejects(
    () => removeConnectionNamespace(userData, {
      userId: '../..', platform: 'xhs', connectionId: CONN_DROP
    }),
    (err) => err instanceof PlatformProfileError && err.code === 'invalid_namespace'
  );
  // 平台标识也不接受任意值。
  await assert.rejects(
    () => removeConnectionNamespace(userData, {
      userId: USER_ID, platform: '../evil', connectionId: CONN_DROP
    }),
    (err) => err instanceof PlatformProfileError
  );
  fs.rmSync(userData, { recursive: true, force: true });
});
