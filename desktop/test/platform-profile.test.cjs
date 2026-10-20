const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  accountNamespace,
  buildProfileMeta,
  checkQuota,
  connectionProfileDir,
  listAccountNamespaces,
  measureUsage,
  orphanConnections,
  parseSingletonLock,
  profileMetaPath,
  removeConnectionNamespace,
  resolveLockResidue,
  verifyProfileMeta,
  assertInsideNamespace,
  PlatformProfileError
} = require('../.build/platform-profile.js');

const userA = '11111111-1111-4111-8111-111111111111';
const userB = '22222222-2222-4222-8222-222222222222';
const conn1 = '33333333-3333-4333-8333-333333333333';
const conn2 = '44444444-4444-4444-8444-444444444444';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ops-profile-'));
}

test('profile 目录按 登录用户/平台/连接 分段，且禁止越界与非法标识', async () => {
  const root = await tempDir();
  const dir = connectionProfileDir(root, { userId: userA, platform: 'xhs', connectionId: conn1 });
  assert.ok(dir.includes(path.join('accounts', userA, 'xhs', conn1, 'profile')));
  // 同一登录用户的微信与小红书连接不能共用一个 profile。
  const wxDir = connectionProfileDir(root, { userId: userA, platform: 'wechat_mp', connectionId: conn1 });
  assert.notEqual(dir, wxDir);
  // 不同登录用户命名空间隔离。
  const otherUser = connectionProfileDir(root, { userId: userB, platform: 'xhs', connectionId: conn1 });
  assert.notEqual(path.dirname(path.dirname(path.dirname(dir))), path.dirname(path.dirname(path.dirname(otherUser))));

  assert.throws(() => connectionProfileDir(root, { userId: '../escape', platform: 'xhs', connectionId: conn1 }), PlatformProfileError);
  assert.throws(() => connectionProfileDir(root, { userId: userA, platform: 'toutiao', connectionId: conn1 }), /不支持/);
  assert.throws(() => connectionProfileDir(root, { userId: userA, platform: 'xhs', connectionId: '../../x' }), PlatformProfileError);
  assert.throws(() => assertInsideNamespace(accountNamespace(root, userA), path.join(root, 'accounts', userB)), PlatformProfileError);
});

test('meta.json 逐项校验：Origin、工作区、连接或用户变化都不复用目录', () => {
  const meta = buildProfileMeta({
    origin: 'https://ops.example.test', userId: userA, workspaceId: '55555555-5555-4555-8555-555555555555',
    deviceId: userB, platform: 'xhs', connectionId: conn1, externalAccountKey: 'xhs_user_id:fixture-self'
  });
  const expected = {
    origin: 'https://ops.example.test', userId: userA,
    workspaceId: '55555555-5555-4555-8555-555555555555', platform: 'xhs', connectionId: conn1
  };
  assert.equal(verifyProfileMeta(meta, expected).connectionId, conn1);

  const changes = [
    { origin: 'https://other.example.test' },
    { userId: userB },
    { workspaceId: '66666666-6666-4666-8666-666666666666' },
    { connectionId: conn2 },
    { platform: 'wechat_mp' }
  ];
  for (const change of changes) {
    assert.throws(() => verifyProfileMeta(meta, { ...expected, ...change }), /元数据与当前上下文不一致/);
  }
  assert.throws(() => verifyProfileMeta({ ...meta, version: 2 }, expected), /版本不支持/);
  assert.throws(() => verifyProfileMeta({ ...meta, deviceId: 'not-a-uuid' }, expected), /缺少设备标识/);
  assert.throws(() => verifyProfileMeta(null, expected), /缺失/);
});

test('SingletonLock：只有确认无存活进程才重建，其它情况一律 busy', async () => {
  assert.deepEqual(parseSingletonLock('my-pc-4242'), { hostname: 'my-pc', pid: 4242 });
  assert.equal(parseSingletonLock('garbage'), null);
  assert.equal(parseSingletonLock('host-0'), null);

  const alive = async () => true;
  const dead = async () => false;

  // 无锁：直接使用。
  assert.deepEqual(await resolveLockResidue(null, alive, 'my-pc'), { action: 'proceed' });
  // 进程存活：不删锁，排队/明确忙。
  assert.equal((await resolveLockResidue('my-pc-4242', alive, 'my-pc')).action, 'busy');
  // 无法解析：不能证明无存活进程。
  assert.equal((await resolveLockResidue('garbage', dead, 'my-pc')).action, 'busy');
  // 其它主机的锁：不能据此删目录。
  assert.equal((await resolveLockResidue('other-pc-4242', dead, 'my-pc')).action, 'busy');
  // 本机且进程已死：允许把目录改名后再重建。
  const reclaimed = await resolveLockResidue('my-pc-4242', dead, 'my-pc');
  assert.equal(reclaimed.action, 'reclaim');
  assert.match(reclaimed.corruptName, /^\.corrupt-/);
});

test('清理只删本连接的目录，不误删其他连接与账本', async () => {
  const root = await tempDir();
  const dir1 = path.dirname(connectionProfileDir(root, { userId: userA, platform: 'xhs', connectionId: conn1 }));
  const dir2 = path.dirname(connectionProfileDir(root, { userId: userA, platform: 'xhs', connectionId: conn2 }));
  const wxDir = path.dirname(connectionProfileDir(root, { userId: userA, platform: 'wechat_mp', connectionId: conn1 }));
  for (const dir of [dir1, dir2, wxDir]) {
    await fs.mkdir(path.join(dir, 'profile'), { recursive: true });
    await fs.writeFile(path.join(dir, 'meta.json'), '{}');
  }

  const result = await removeConnectionNamespace(root, { userId: userA, platform: 'xhs', connectionId: conn1 });
  assert.equal(result.removed, true);
  await assert.rejects(fs.stat(dir1));
  // 其他连接与其他平台的目录必须保留。
  assert.ok(await fs.stat(path.join(dir2, 'meta.json')));
  assert.ok(await fs.stat(path.join(wxDir, 'meta.json')));
  // 账号命名空间本身不能被删掉。
  assert.deepEqual(await listAccountNamespaces(root), [userA]);
});

test('配额统计与超限判定', async () => {
  const root = await tempDir();
  const dir = path.dirname(connectionProfileDir(root, { userId: userA, platform: 'xhs', connectionId: conn1 }));
  await fs.mkdir(path.join(dir, 'profile'), { recursive: true });
  await fs.writeFile(path.join(dir, 'profile', 'blob'), Buffer.alloc(1024));

  const usage = await measureUsage(dir);
  assert.ok(usage.bytes >= 1024, `usage=${usage.bytes}`);

  const ok = await checkQuota(root, userA, { userBytes: 10 * 1024 * 1024, totalBytes: 10 * 1024 * 1024 });
  assert.equal(ok.ok, true);
  const exceeded = await checkQuota(root, userA, { userBytes: 1, totalBytes: 10 * 1024 * 1024 });
  assert.equal(exceeded.ok, false);
  assert.equal(exceeded.exceeded, 'user');
});

test('无主目录扫描只给候选，不自动删除', async () => {
  const root = await tempDir();
  for (const id of [conn1, conn2]) {
    const dir = path.dirname(connectionProfileDir(root, { userId: userA, platform: 'xhs', connectionId: id }));
    await fs.mkdir(path.join(dir, 'profile'), { recursive: true });
  }
  const orphans = await orphanConnections(root, { userId: userA, platform: 'xhs' }, [conn1]);
  assert.deepEqual(orphans, [conn2]);
  // 未删除：目录仍在。
  assert.ok(await fs.stat(path.dirname(connectionProfileDir(root, { userId: userA, platform: 'xhs', connectionId: conn2 }))));
});

test('platform_profile_meta_path 与 profile 目录同级', async () => {
  const root = await tempDir();
  const dir = connectionProfileDir(root, { userId: userA, platform: 'xhs', connectionId: conn1 });
  assert.equal(path.basename(profileMetaPath(dir)), 'meta.json');
  assert.equal(path.dirname(profileMetaPath(dir)), path.dirname(dir));
});
