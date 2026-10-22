const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PlatformLoginFlow } = require('../.build/platform-login-flow');
const { accountProfileSlot, readAccountProfile, saveAccountProfile, buildProfileMeta, removeConnectionNamespace, orphanConnections } = require('../.build/platform-profile');
const { trustedLoginBrowsers, validBrowserSignature, selectLoginBrowser } = require('../.build/platform-browser-trust');
const { savePlatformLogin } = require('../.build/platform-login-runtime');
const { validatePayloadShape } = require('../.build/platform-ipc');
const id = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const scope = { origin: 'https://ops.example.test', userId: id(1), workspaceId: id(2), deviceId: id(3), accountId: id(4), platform: 'xhs' };
const identity = { externalAccountKey: 'xhs_user_id:fixture', displayName: '虚构账号', capabilities: { workList: 'unknown' } };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function harness(overrides = {}) {
  let context = { origin: scope.origin, userId: scope.userId, workspaceId: scope.workspaceId, deviceId: scope.deviceId };
  let probes = 0, saves = 0, closes = 0, now = Date.now();
  const handle = { browserFamily: 'chrome', browserVersion: 'Chrome/fixture', expectedKey: null, supported: true, onClosed() {}, show: async () => {}, probe: async () => { probes++; return identity; }, close: async () => { closes++; } };
  const deps = { context: async () => context, account: async () => ({ name: '虚构OPS账号' }), start: async () => handle, save: async () => { saves++; return { id: id(5), autoCollect: false, autoAdopt: false }; }, now: () => now, ...overrides };
  return { flow: new PlatformLoginFlow(deps), handle, setContext: (value) => { context = value; }, advance: (ms) => { now += ms; }, counts: () => ({ probes, saves, closes }) };
}

test('本人启动/核对/确认三步；状态查询不探测平台，登录不默认采集', async (t) => {
  const h = harness(); t.after(() => h.flow.stop());
  const view = await h.flow.open(scope.accountId, 'xhs');
  assert.equal(view.stage, 'waiting');
  await h.flow.action(view.operationId, 'status');
  assert.deepEqual(h.counts(), { probes: 0, saves: 0, closes: 0 });
  assert.equal((await h.flow.action(view.operationId, 'probe')).stage, 'review');
  assert.equal(h.counts().saves, 0);
  const saved = await h.flow.action(view.operationId, 'confirm');
  assert.equal(saved.stage, 'connected'); assert.equal(saved.autoCollect, false); assert.equal(saved.autoAdopt, false);
  assert.deepEqual(h.counts(), { probes: 2, saves: 1, closes: 1 });
});

test('账号不符不写连接；返回官方页后可以重新核对', async (t) => {
  const h = harness(); h.handle.expectedKey = 'xhs_user_id:another'; t.after(() => h.flow.stop());
  const view = await h.flow.open(scope.accountId, 'xhs');
  assert.equal((await h.flow.action(view.operationId, 'probe')).stage, 'mismatch');
  assert.equal((await h.flow.action(view.operationId, 'confirm')).stage, 'mismatch');
  assert.equal(h.counts().saves, 0);
  assert.equal((await h.flow.action(view.operationId, 'back')).stage, 'waiting');
});

test('取消在途probe后晚到身份不能推进界面，旧operation不能影响新操作', async (t) => {
  const probe = deferred(); const h = harness(); h.handle.probe = () => probe.promise; t.after(() => h.flow.stop());
  const view = await h.flow.open(scope.accountId, 'xhs');
  const pending = h.flow.action(view.operationId, 'probe');
  await new Promise(setImmediate);
  assert.equal((await h.flow.action(view.operationId, 'cancel')).stage, 'cancelled');
  probe.resolve(identity); assert.equal((await pending).stage, 'cancelled');
  const next = await h.flow.open(scope.accountId, 'xhs');
  assert.notEqual(next.operationId, view.operationId);
  await assert.rejects(() => h.flow.action(view.operationId, 'cancel'), (error) => error.code === 'platform_login_stale');
});

test('启动中取消仍结束晚到自有窗口，并阻止新操作穿透占位', async () => {
  const start = deferred(); const h = harness({ start: () => start.promise });
  const pending = h.flow.open(scope.accountId, 'xhs', undefined, id(10));
  await new Promise(setImmediate);
  await h.flow.action(id(10), 'cancel');
  await assert.rejects(() => h.flow.open(scope.accountId, 'xhs'), (error) => error.code === 'platform_profile_busy');
  start.resolve(h.handle); assert.equal((await pending).stage, 'cancelled');
  assert.equal(h.counts().closes, 1); assert.equal(h.flow.active, false);
});

test('上下文变化、统一截止和未支持头条都不能保存连接', async () => {
  const h = harness(); const view = await h.flow.open(scope.accountId, 'xhs');
  h.setContext({ ...scope, workspaceId: id(20) });
  await assert.rejects(() => h.flow.action(view.operationId, 'probe'), (error) => error.code === 'platform_login_context_changed');
  assert.equal(h.counts().saves, 0);
  const expired = harness(); const waiting = await expired.flow.open(scope.accountId, 'xhs'); expired.advance(180001);
  assert.equal((await expired.flow.action(waiting.operationId, 'status')).stage, 'expired');
  const tt = harness(); tt.handle.supported = false; const unsupported = await tt.flow.open(scope.accountId, 'toutiao');
  assert.equal(unsupported.stage, 'unsupported');
  await tt.flow.action(unsupported.operationId, 'probe'); assert.equal(tt.counts().probes, 0);
  await tt.flow.stop();
});

test('verify失败保持待恢复；恢复不能改为第二次create', async (t) => {
  const modes = []; const h = harness({ save: async (_scope, _identity, _handle, recoverOnly) => { modes.push(recoverOnly); if (!recoverOnly) throw new Error('lost reply'); return { id: id(5), autoCollect: false, autoAdopt: false }; } }); t.after(() => h.flow.stop());
  const view = await h.flow.open(scope.accountId, 'xhs'); await h.flow.action(view.operationId, 'probe');
  assert.equal((await h.flow.action(view.operationId, 'confirm')).stage, 'recovering');
  assert.equal((await h.flow.action(view.operationId, 'recover')).stage, 'connected');
  assert.deepEqual(modes, [false, true]);
});

test('旧status上下文查询晚到不能关闭后来新开的登录窗口', async (t) => {
  const gate = deferred(); let waitContext = false; let current = { origin: scope.origin, userId: scope.userId, workspaceId: scope.workspaceId, deviceId: scope.deviceId };
  const h = harness({ context: () => waitContext ? gate.promise : Promise.resolve(current) }); t.after(() => h.flow.stop());
  const old = await h.flow.open(scope.accountId, 'xhs'); waitContext = true;
  const pending = h.flow.action(old.operationId, 'status'); await new Promise(setImmediate);
  await h.flow.action(old.operationId, 'cancel'); waitContext = false;
  current = { ...current, workspaceId: id(30) };
  const fresh = await h.flow.open(scope.accountId, 'xhs');
  gate.resolve(current); await assert.rejects(() => pending, (error) => error.code === 'platform_login_stale');
  assert.equal((await h.flow.action(fresh.operationId, 'status')).stage, 'waiting');
  assert.equal(h.counts().closes, 1);
});

test('核对后官方窗口切号时确认必须失败，不把缓存主体当当前主体', async (t) => {
  const h = harness(); t.after(() => h.flow.stop());
  const view = await h.flow.open(scope.accountId, 'xhs'); await h.flow.action(view.operationId, 'probe');
  h.handle.probe = async () => ({ ...identity, externalAccountKey: 'xhs_user_id:changed' });
  assert.equal((await h.flow.action(view.operationId, 'confirm')).stage, 'mismatch');
  assert.equal(h.counts().saves, 0);
});

test('终态跨OPS上下文也不能读到上一个账号的连接摘要', async () => {
  const h = harness(); const view = await h.flow.open(scope.accountId, 'xhs');
  await h.flow.action(view.operationId, 'probe'); await h.flow.action(view.operationId, 'confirm');
  h.setContext({ origin: scope.origin, userId: id(33), workspaceId: scope.workspaceId, deviceId: scope.deviceId });
  await assert.rejects(() => h.flow.action(view.operationId, 'status'), (error) => error.code === 'platform_login_context_changed');
  assert.equal((await h.flow.action(view.operationId, 'cancel')).externalAccountKey, null);
});

test('slot隔离全部上下文维度，成功只改元数据；孤儿扫描不能误删活跃连接', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-il-profile-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const slot = accountProfileSlot(scope);
  for (const field of ['userId', 'workspaceId', 'deviceId', 'accountId']) assert.notEqual(accountProfileSlot({ ...scope, [field]: id(20) }), slot);
  assert.notEqual(accountProfileSlot({ ...scope, origin: 'https://another.example.test' }), slot);
  assert.notEqual(accountProfileSlot({ ...scope, platform: 'toutiao' }), slot);
  const { profileDir } = await readAccountProfile(root, scope);
  const meta = { ...buildProfileMeta({ ...scope, connectionId: id(5), externalAccountKey: identity.externalAccountKey }), slotId: slot, accountId: scope.accountId, browserFamily: 'chrome' };
  await saveAccountProfile(root, profileDir, meta); await fs.mkdir(profileDir);
  await fs.writeFile(path.join(profileDir, 'fixture'), 'session');
  assert.equal((await readAccountProfile(root, scope)).profileDir, profileDir);
  assert.deepEqual(await orphanConnections(root, scope, [id(5)]), []);
  assert.deepEqual(await orphanConnections(root, scope, []), [slot]);
  assert.equal(await fs.readFile(path.join(profileDir, 'fixture'), 'utf8'), 'session');
  await fs.writeFile(path.join(profileDir, 'SingletonLock'), 'unknown');
  assert.equal((await removeConnectionNamespace(root, { ...scope, connectionId: slot })).removed, false);
});

test('仅认可匹配品牌的有效发行方签名，不逐品牌降级', async () => {
  assert.equal(validBrowserSignature('chrome', { status: 'Valid', subject: 'CN=Google LLC, O=Google LLC, C=US' }), true);
  assert.equal(validBrowserSignature('edge', { status: 'Valid', subject: 'CN=Microsoft Corporation, O=Microsoft Corporation, C=US' }), true);
  assert.equal(validBrowserSignature('edge', { status: 'Valid', subject: 'CN=evil, O=Google LLC, C=US' }), false);
  assert.equal(validBrowserSignature('chrome', { status: 'UnknownError', subject: 'O=Google LLC' }), false);
  const candidates = await trustedLoginBrowsers({ discover: async () => [{ family: 'brave' }, { family: 'chrome' }, { family: 'edge' }], verify: async (candidate) => candidate.family === 'edge' });
  assert.deepEqual(candidates, [{ family: 'edge' }]); assert.throws(() => selectLoginBrowser(candidates, 'chrome'));
});

test('IPC仅接受固定动作/浏览器，不允许路径/脚本/扩展键', () => {
  assert.doesNotThrow(() => validatePayloadShape('login-action', { operationId: id(10), action: 'cancel' }));
  for (const payload of [{ operationId: id(10), action: 'eval' }, { operationId: id(10), action: 'probe', script: 'evil' }, { operationId: '../x', action: 'probe' }]) assert.throws(() => validatePayloadShape('login-action', payload));
  assert.throws(() => validatePayloadShape('open-login', { accountId: scope.accountId, platform: 'xhs', browserFamily: 'playwright' }));
});

test('回执丢失先查询同主体同设备连接，verify成功才回报连接成功', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-il-recover-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { profileDir } = await readAccountProfile(root, scope);
  const handle = { profileDir, meta: { ...buildProfileMeta({ ...scope, connectionId: accountProfileSlot(scope), externalAccountKey: '' }), slotId: accountProfileSlot(scope), accountId: scope.accountId, browserFamily: 'chrome' } };
  let created = 0, verified = 0;
  const row = { id: id(5), account_id: scope.accountId, workspace_id: scope.workspaceId, user_id: scope.userId, device_id: scope.deviceId, platform: 'xhs', external_account_key: identity.externalAccountKey, state: 'active', availability: 'verifying' };
  const client = { getAuthContext: async () => scope, listPlatformConnections: async () => [row], createPlatformConnection: async () => { created++; return row; }, verifyPlatformConnection: async () => { verified++; return { ...row, availability: 'ready', auto_collect: false, auto_adopt: false }; } };
  assert.equal((await savePlatformLogin(client, root, scope, identity, handle, true, new AbortController().signal)).id, row.id);
  assert.equal(created, 0); assert.equal(verified, 1);
  assert.equal((await readAccountProfile(root, scope)).meta.connectionId, row.id);
  client.listPlatformConnections = async () => [{ ...row, device_id: id(20) }];
  await assert.rejects(() => savePlatformLogin(client, root, scope, identity, handle, true, new AbortController().signal), (error) => error.code === 'platform_connection_conflict');
  client.listPlatformConnections = async () => [];
  await assert.rejects(() => savePlatformLogin(client, root, scope, identity, handle, true, new AbortController().signal), (error) => error.code === 'platform_connection_unconfirmed');
  assert.equal(created, 0);
});
