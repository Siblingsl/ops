const assert = require('node:assert/strict');
const test = require('node:test');

const { PLATFORM_IPC_COMMANDS } = require('../.build/platform-ipc.js');
const {
  orphanConnections,
  listConnectionNamespaces,
  connectionProfileDir,
  removeConnectionNamespace
} = require('../.build/platform-profile.js');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CONN_KNOWN = '22222222-2222-4222-8222-222222222222';
const CONN_ORPHAN = '33333333-3333-4333-8333-333333333333';

test('无主清理是独立命令，且不接受批量语义', () => {
  assert.ok(PLATFORM_IPC_COMMANDS.includes('clear-orphan-profiles'));
  // 红线：不能有"全部清理"这类批量命令。
  for (const forbidden of ['clear-all', 'clear-all-profiles', 'purge-all', 'clear-everything']) {
    assert.ok(!PLATFORM_IPC_COMMANDS.includes(forbidden), `不应存在批量命令 ${forbidden}`);
  }
});

test('只把服务端不认识的连接判为无主，且不误伤在册连接', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-orphan-'));
  // 建两条本机目录：一条服务端仍认识，一条已被撤销。
  for (const connectionId of [CONN_KNOWN, CONN_ORPHAN]) {
    const dir = connectionProfileDir(userData, { userId: USER_ID, platform: 'xhs', connectionId });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'marker'), connectionId);
  }
  // 也建一个另一平台的目录，验证平台隔离。
  const otherDir = connectionProfileDir(userData, { userId: USER_ID, platform: 'wechat_mp', connectionId: CONN_ORPHAN });
  fs.mkdirSync(otherDir, { recursive: true });

  const orphans = await orphanConnections(
    userData, { userId: USER_ID, platform: 'xhs' }, [CONN_KNOWN]
  );
  assert.deepEqual(orphans, [CONN_ORPHAN]);

  // 全是已知连接时不应报无主。
  const none = await orphanConnections(
    userData, { userId: USER_ID, platform: 'xhs' }, [CONN_KNOWN, CONN_ORPHAN]
  );
  assert.deepEqual(none, []);

  // 平台隔离：查 wechat_mp 时不应把 xhs 的目录算进来。
  const wx = await orphanConnections(
    userData, { userId: USER_ID, platform: 'wechat_mp' }, []
  );
  assert.deepEqual(wx, [CONN_ORPHAN]);

  fs.rmSync(userData, { recursive: true, force: true });
});

test('连接标识大小写不影响判定', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-orphan-case-'));
  const dir = connectionProfileDir(userData, { userId: USER_ID, platform: 'xhs', connectionId: CONN_ORPHAN });
  fs.mkdirSync(dir, { recursive: true });
  // 服务端返回大写，本机目录是小写：不应误判为无主。
  const orphans = await orphanConnections(
    userData, { userId: USER_ID, platform: 'xhs' }, [CONN_ORPHAN.toUpperCase()]
  );
  assert.deepEqual(orphans, []);
  fs.rmSync(userData, { recursive: true, force: true });
});

test('账号命名空间不存在时返回空列表，不抛错', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-orphan-empty-'));
  // 没建任何目录。
  assert.deepEqual(await listConnectionNamespaces(userData, { userId: USER_ID, platform: 'xhs' }), []);
  assert.deepEqual(
    await orphanConnections(userData, { userId: USER_ID, platform: 'xhs' }, []),
    []
  );
  fs.rmSync(userData, { recursive: true, force: true });
});

test('清理无主目录只删目标，不碰在册连接', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-orphan-clear-'));
  for (const connectionId of [CONN_KNOWN, CONN_ORPHAN]) {
    const dir = connectionProfileDir(userData, { userId: USER_ID, platform: 'xhs', connectionId });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'marker'), connectionId);
  }
  const knownDir = connectionProfileDir(userData, { userId: USER_ID, platform: 'xhs', connectionId: CONN_KNOWN });
  const orphanDir = connectionProfileDir(userData, { userId: USER_ID, platform: 'xhs', connectionId: CONN_ORPHAN });

  const orphans = await orphanConnections(userData, { userId: USER_ID, platform: 'xhs' }, [CONN_KNOWN]);
  assert.deepEqual(orphans, [CONN_ORPHAN]);
  for (const connectionId of orphans) {
    const r = await removeConnectionNamespace(userData, { userId: USER_ID, platform: 'xhs', connectionId });
    assert.equal(r.removed, true);
  }

  assert.equal(fs.existsSync(path.dirname(orphanDir)), false);
  // 在册连接必须完好。
  assert.equal(fs.existsSync(path.join(knownDir, 'marker')), true);

  fs.rmSync(userData, { recursive: true, force: true });
});
