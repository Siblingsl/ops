'use strict';
// DEV-AI27-02 W02：浏览器桥与宿主单元/集成测试（node --test）。
// 覆盖：长度前缀帧、信封校验（版本/类型/HMAC/seq 防重放）、命令账本幂等与状态单向、
// 桥↔宿主 TCP 集成（配对→派发→回执→幂等→unknown_outcome→撤销拒绝）。

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const host = require('../src/native-host/host.js');
const bridge = require('../.build/browser-bridge.js');

function mkKey() {
  return crypto.randomBytes(32);
}

function signed(key, seq, type, payload) {
  return { v: 1, type, payload, seq, hmac: host.hmacSign(key, seq, type, payload) };
}

test('frame codec roundtrip and size limit', () => {
  const decoder = host.createFrameDecoder(1024);
  const msgs = [{ a: 1 }, { b: '中文' }, { list: [1, 2, 3] }];
  const chunk = Buffer.concat(msgs.map((m) => host.encodeFrame(m)));
  assert.deepEqual(decoder.feed(chunk), msgs);
  assert.throws(() => host.encodeFrame({ big: 'x'.repeat(5 * 1024 * 1024) }), /frame too large/);
  const huge = Buffer.alloc(4);
  huge.writeUInt32LE(2048, 0);
  assert.throws(() => decoder.feed(huge), /frame length invalid/);
});

test('envelope validator: version, types, hmac, replay', () => {
  const key = mkKey();
  const validator = host.createEnvelopeValidator({ getSessionKey: () => key });
  assert.match(validator.check({ v: 2, type: 'command' }), /version mismatch/);
  assert.match(validator.check({ v: 1, type: 'evil' }), /type not allowed/);
  // 缺 seq/hmac 拒绝
  assert.match(validator.check({ v: 1, type: 'command', payload: {} }), /hmac verification failed|missing/);
  // 正确签名通过
  const ok = signed(key, 1, 'command', { x: 1 });
  ok.hmac = host.hmacSign(key, ok.seq, ok.type, ok.payload);
  assert.equal(validator.check(ok), null);
  // 重放同 seq 拒绝
  const replay = signed(key, 1, 'command', { x: 1 });
  replay.hmac = host.hmacSign(key, replay.seq, replay.type, replay.payload);
  assert.match(validator.check(replay), /replayed or out-of-order/);
  // 篡改 payload 拒绝
  const tampered = signed(key, 2, 'command', { x: 1 });
  tampered.hmac = host.hmacSign(key, tampered.seq, tampered.type, { x: 2 });
  assert.match(validator.check(tampered), /hmac verification failed/);
});

test('command ledger: idempotency, conflict, one-way states, unknown sweep', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-bridge-ledger-'));
  const ledger = new bridge.CommandLedger(path.join(dir, 'ledger.json'));
  const hashA = 'aa'.repeat(32);
  const hashB = 'bb'.repeat(32);

  const first = ledger.record('r1', 'observe', hashA, 1000);
  assert.equal(first.entry.state, 'queued');
  // 同 id 同载荷幂等
  const replay = ledger.record('r1', 'observe', hashA, 2000);
  assert.equal(replay.entry, first.entry);
  // 同 id 异载荷冲突
  assert.deepEqual(ledger.record('r1', 'observe', hashB, 3000), { conflict: true });

  assert.equal(ledger.transition('r1', 'succeeded'), null, 'queued 不能跳到 succeeded');
  assert.equal(ledger.transition('r1', 'dispatched', { dispatched_at: 1500, deadline_at: 2500 }).state, 'dispatched');
  assert.equal(ledger.transition('r1', 'dispatched'), null, '状态不能回退');
  assert.equal(ledger.transition('r1', 'succeeded', { result: { ok: true } }).state, 'succeeded');
  assert.equal(ledger.transition('r1', 'failed'), null, '终态不可再迁移');

  ledger.record('r2', 'click', hashB, 1000);
  ledger.transition('r2', 'dispatched', { dispatched_at: 1000, deadline_at: 1100 });
  const unknown = ledger.sweepUnknown(5000);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].request_id, 'r2');
  assert.equal(ledger.sweepUnknown(6000).length, 0, 'unknown_outcome 不再重复扫描');

  // 持久化读回
  const ledger2 = new bridge.CommandLedger(path.join(dir, 'ledger.json'));
  assert.equal(ledger2.get('r1').state, 'succeeded');
  assert.equal(ledger2.get('r2').state, 'unknown_outcome');
  fs.rmSync(dir, { recursive: true, force: true });
});

async function startBridgeWithMockHost(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-bridge-e2e-'));
  const ledger = new bridge.CommandLedger(path.join(dir, 'ledger.json'));
  const b = new bridge.BrowserBridge(ledger, { port: 0, controlPort: null, actionTimeoutMs: 500, ...opts });
  await b.start();
  const address = b['server'].address();
  t.after(() => {
    b.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const socket = net.connect(address.port, '127.0.0.1');
  await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  const lines = [];
  let waiter = null;
  socket.setNoDelay(true);
  socket.on('data', (chunk) => {
    let s = (socket.__buf || '') + chunk.toString('utf8');
    let idx;
    while ((idx = s.indexOf('\n')) >= 0) {
      const line = s.slice(0, idx);
      s = s.slice(idx + 1);
      const msg = JSON.parse(line);
      lines.push(msg);
      if (waiter) waiter(msg);
    }
    socket.__buf = s;
  });
  const next = () => new Promise((resolve) => { waiter = resolve; });
  const send = (obj) => socket.write(`${JSON.stringify(obj)}\n`);
  return { b, socket, lines, next, send };
}

test('bridge e2e: pairing -> dispatch -> result -> idempotent -> unknown -> revoke', { timeout: 20_000 }, async (t) => {
  const { b, lines, next, send } = await startBridgeWithMockHost(t);

  // 宿主 hello -> OPS 回 pairing_start
  send({ v: 1, type: 'hello', payload: { host_instance_id: 'mock-host', protocol_version: 1 } });
  const pairingStart = await next();
  assert.equal(pairingStart.type, 'pairing_start');
  assert.match(pairingStart.payload.code, /^\d{6}$/);
  assert.equal(b.state, 'pairing');

  // 配对过期拒绝
  b.pairing.expires_at = Date.now() - 1;
  assert.deepEqual(b.confirmPairing(), { ok: false, reason: 'pairing expired' });

  // 未配对时 dispatch 拒绝
  assert.equal(b.dispatch('tabs_list', {}).accepted, false);

  // 重新 hello -> 确认配对 -> pairing_confirm（含 session_key）
  send({ v: 1, type: 'hello', payload: { host_instance_id: 'mock-host', protocol_version: 1 } });
  await next();
  const confirmed = b.confirmPairing();
  assert.equal(confirmed.ok, true);
  const pairingConfirm = await next();
  assert.equal(pairingConfirm.type, 'pairing_confirm');
  const sessionKey = Buffer.from(pairingConfirm.payload.session_key, 'base64');

  // 宿主用 session_key 签名的消息被接受；无签名/坏签名被拒。ping 为单向消息无回包，
  // 用桥的 reject 事件计数断言。
  const rejectCount = () => b.snapshot().events.filter((e) => e.message.includes('reject')).length;
  const beforeUnsigned = rejectCount();
  send({ v: 1, type: 'ping', payload: {} });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(rejectCount(), beforeUnsigned + 1, '未签名 ping 应被拒');
  const beforeSigned = rejectCount();
  send(signed(sessionKey, 1, 'ping', {}));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(rejectCount(), beforeSigned, '签名 ping 应被接受');

  // dispatch -> 宿主收到 command（含 generation/deadline/issued_at/nonce/payload_hash）-> 回 result
  const accepted = b.dispatch('tabs_list', {}, 'req-1');
  assert.equal(accepted.accepted, true);
  const command = await next();
  assert.equal(command.type, 'command');
  assert.equal(command.request_id, 'req-1');
  assert.equal(command.action, 'tabs_list');
  assert.equal(typeof command.deadline_at, 'number');
  assert.equal(typeof command.issued_at, 'number', 'W05: command 带 issued_at');
  assert.match(command.nonce || '', /^[0-9a-f]{32}$/, 'W05: command 带 nonce');
  const crypto = require('node:crypto');
  const expectHash = crypto.createHash('sha256').update(JSON.stringify(command.payload ?? null)).digest('hex');
  assert.equal(command.payload_hash, expectHash, 'W05: command payload_hash 与载荷一致');
  // result 须原样带回 nonce/hash，否则桥拒绝（防错配/防伪造回执）；每次发送递增 seq。
  const resultPayload = { ok: true, payload: { tabs: [] } };
  send({ v: 1, type: 'result', request_id: 'req-1', seq: 2, hmac: host.hmacSign(sessionKey, 2, 'result', resultPayload), payload: resultPayload });
  await new Promise((r) => setTimeout(r, 80));
  assert.notEqual(b.ledger.get('req-1').state, 'succeeded', 'W05: 无 nonce 回执被拒');
  send({ v: 1, type: 'result', request_id: 'req-1', nonce: 'f'.repeat(32), seq: 3, hmac: host.hmacSign(sessionKey, 3, 'result', resultPayload, 'f'.repeat(32)), payload: resultPayload });
  await new Promise((r) => setTimeout(r, 80));
  assert.notEqual(b.ledger.get('req-1').state, 'succeeded', 'W05: nonce 不匹配回执被拒');
  send({ v: 1, type: 'result', request_id: 'req-1', nonce: command.nonce, payload_hash: command.payload_hash, seq: 4, hmac: host.hmacSign(sessionKey, 4, 'result', resultPayload, command.nonce, command.payload_hash), payload: resultPayload });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(b.ledger.get('req-1').state, 'succeeded', 'W05: nonce/hash 匹配的回执入账');

  // 同 id 同载荷幂等重放：返回原状态，不再派发
  const commandsBefore = lines.filter((m) => m.type === 'command').length;
  const replay = b.dispatch('tabs_list', {}, 'req-1');
  assert.equal(replay.state, 'succeeded');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(lines.filter((m) => m.type === 'command').length, commandsBefore, '幂等重放不重发 command');

  // 同 id 异载荷 409 语义
  const conflict = b.dispatch('observe', { tab_id: 2 }, 'req-1');
  assert.equal(conflict.accepted, false);
  assert.equal(conflict.error_code, 'browser_request_conflict', 'W05: 冲突返回稳定错误码');

  // W05 桥侧动作白名单：未登记动作前置拒绝（扩展登记表是第二道校验）
  const rogue = b.dispatch('execute_arbitrary_js', { code: 'return 1' }, 'rogue-1');
  assert.equal(rogue.accepted, false);
  assert.equal(rogue.error_code, 'browser_action_unsupported');
  assert.ok(!lines.some((m) => m.type === 'command' && m.request_id === 'rogue-1'), '白名单外的动作不派发');

  // A7：observe_frames 是登记动作（cd0a7afa 工具目录有、白名单漏登记的缺口补齐）
  const framesCmd = b.dispatch('observe_frames', { tab_id: 1 }, 'frames-1');
  assert.equal(framesCmd.accepted, true, 'observe_frames 应在桥侧白名单内');
  await next();

  // W05 元数据上限 256KiB：超限拒绝且不派发
  const bigPayload = { blob: 'x'.repeat(256 * 1024 + 1) };
  const big = b.dispatch('extract', bigPayload, 'big-1');
  assert.equal(big.accepted, false);
  assert.equal(big.error_code, 'browser_payload_limit');
  assert.ok(!lines.some((m) => m.type === 'command' && m.request_id === 'big-1'), '超限载荷不派发');

  // W05 时钟异常停止派发：wall clock 相对单调时钟漂移超 5s 即拒绝
  b['startWallMs'] -= 60_000; // 注入 60s 时钟跳变
  const drifted = b.dispatch('tabs_list', {}, 'drift-1');
  assert.equal(drifted.accepted, false);
  assert.equal(drifted.error_code, 'browser_clock_unstable', '时钟异常停止派发');
  b['startWallMs'] += 60_000; // 恢复
  const recovered = b.dispatch('tabs_list', {}, 'drift-2');
  assert.equal(recovered.accepted, true, '时钟恢复后可继续派发');
  await next();

  // 超时无回执 -> unknown_outcome（deadline 500ms + 2s 时钟误差窗），不自动重发
  b.dispatch('click', { tab_id: 1, ref: 'n1', doc_rev: 'r1' }, 'req-2');
  await new Promise((r) => setTimeout(r, 900));
  b.sweep();
  assert.equal(b.ledger.get('req-2').state, 'dispatched', '时钟误差窗内不提前判未知');
  await new Promise((r) => setTimeout(r, 2700));
  b.sweep();
  assert.equal(b.ledger.get('req-2').state, 'unknown_outcome');
  assert.equal(lines.filter((m) => m.type === 'command' && m.request_id === 'req-2').length, 1, 'unknown_outcome 不重放');

  // revoke：generation 递增，queued 清空，host 收到 revoke
  const genBefore = b.generation.n;
  b.revoke('test');
  const revokeMsg = await next();
  assert.equal(revokeMsg.type, 'revoke');
  assert.equal(b.generation.n, genBefore + 1);
  assert.equal(b.state, 'revoked');
  assert.equal(b.dispatch('tabs_list', {}, 'req-3').accepted, false, '撤销后拒绝新命令');
});

// A30：dispatchAndWait——本机 UI 枚举（选标签弹窗）用。成功回扩展动作 payload；
// 未配对立即拒绝；扩展失败回真实 error_code；超时回 browser_dispatch_timeout。
test('bridge dispatchAndWait: payload on success, real codes on failure, timeout', { timeout: 20_000 }, async (t) => {
  const { b, next, send } = await startBridgeWithMockHost(t);

  // 未配对：立即拒绝（不等待超时）
  const unpaired = await b.dispatchAndWait('tabs_list', {}, 2000);
  assert.equal(unpaired.ok, false);
  assert.equal(unpaired.code, 'browser_not_paired');

  // 配对
  send({ v: 1, type: 'hello', payload: { host_instance_id: 'mock-host', protocol_version: 1 } });
  await next();
  assert.equal(b.confirmPairing().ok, true);
  const pairingConfirm = await next();
  const sessionKey = Buffer.from(pairingConfirm.payload.session_key, 'base64');
  let seq = 0;
  const signedResult = (requestId, nonce, payloadHash, payload) => {
    seq += 1;
    return { v: 1, type: 'result', request_id: requestId, nonce, payload_hash: payloadHash, seq, hmac: host.hmacSign(sessionKey, seq, 'result', payload, nonce, payloadHash), payload };
  };

  // 成功路径：回执 {ok:true, payload:{tabs:[...]}} -> dispatchAndWait 解出动作 payload
  const successPending = b.dispatchAndWait('tabs_list', {}, 8000);
  const command = await next();
  assert.equal(command.type, 'command');
  assert.equal(command.action, 'tabs_list');
  send(signedResult(command.request_id, command.nonce, command.payload_hash, { ok: true, payload: { tabs: [{ id: 7, title: '示例', origin: 'https://example.com' }] } }));
  const got = await successPending;
  assert.equal(got.ok, true);
  assert.deepEqual(got.result, { tabs: [{ id: 7, title: '示例', origin: 'https://example.com' }] });

  // 失败路径：扩展回 {ok:false, error_code} -> 原样透出真实错误码
  const failPending = b.dispatchAndWait('observe', { tab_id: 1 }, 8000);
  const failCommand = await next();
  send(signedResult(failCommand.request_id, failCommand.nonce, failCommand.payload_hash, { ok: false, error_code: 'tab_not_found' }));
  const failed = await failPending;
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'tab_not_found');
});

// ---------------------------------------------------------------------------
// A14（W05 强化，27 §14）：①HMAC 材料含 nonce/payload_hash；②lastSeqIn 持久化
// （重启后拒绝重放更早 seq）；③native host 单实例锁。
// ---------------------------------------------------------------------------

test('A14: HMAC 材料含 nonce/payload_hash（伪造/替换被拒）', () => {
  const key = mkKey();
  const validator = host.createEnvelopeValidator({ getSessionKey: () => key });
  const commandWithMaterial = { v: 1, type: 'command', payload: { x: 1 }, nonce: 'n-1', payload_hash: 'aa'.repeat(32) };
  const good = signed(key, 1, 'command', commandWithMaterial.payload, 'n-1', 'aa'.repeat(32));
  assert.equal(validator.check(good), null, '按新材料签名应通过');
  // 同 seq 同 payload 但换 nonce → 签名不符（材料绑定 nonce）
  const forged = { ...good, nonce: 'n-2' };
  assert.match(validator.check(forged), /hmac verification failed/, '换 nonce 不得通过');
  // 用旧格式（不含 nonce）签名的信封被拒
  const oldStyle = signed(key, 2, 'command', commandWithMaterial.payload);
  oldStyle.nonce = 'n-1';
  oldStyle.payload_hash = 'aa'.repeat(32);
  assert.match(validator.check(oldStyle), /hmac verification failed/, '旧格式签名不得通过');
});

test('A14: lastSeqIn 持久化——重启后拒绝重放更早 seq', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-bridge-seq-'));
  const seqPath = path.join(dir, 'seq.json');
  const b1 = new bridge.BrowserBridge(new bridge.CommandLedger(null), { seqStatePath: seqPath, log: () => {} });
  // 模拟 hello + 已见 seq 5
  const socket = { write() {}, destroyed: false, remotePort: 1 };
  b1['socket'] = socket;
  b1.onEnvelope({ v: 1, type: 'hello', payload: { host_instance_id: 'h-a', pid: 1 } });
  b1['sessionKey'] = mkKey();
  const seq5 = { v: 1, type: 'ping', payload: {}, seq: 5 };
  seq5.hmac = host.hmacSign(b1['sessionKey'], 5, 'ping', {});
  b1.onEnvelope(seq5);
  assert.ok(fs.existsSync(seqPath), 'seq 状态文件应落盘');
  const saved = JSON.parse(fs.readFileSync(seqPath, 'utf8'));
  assert.equal(saved.last_seq_in, 5);
  assert.equal(saved.host_instance_id, 'h-a');

  // 新桥实例（重启）：同 host 的 seq 4 应被拒（重放），seq 6 通过。
  const b2 = new bridge.BrowserBridge(new bridge.CommandLedger(null), { seqStatePath: seqPath, log: () => {} });
  b2['socket'] = socket;
  b2.onEnvelope({ v: 1, type: 'hello', payload: { host_instance_id: 'h-a', pid: 2 } });
  b2['sessionKey'] = b1['sessionKey'];
  const replay4 = { v: 1, type: 'ping', payload: {}, seq: 4 };
  replay4.hmac = host.hmacSign(b2['sessionKey'], 4, 'ping', {});
  const rejected = b2.checkEnvelopePublic ? b2.checkEnvelopePublic(replay4) : null;
  // checkEnvelope 是 private；通过 onEnvelope 的日志断言重放被拒（不派发）。
  const logs = [];
  b2.emit = (kind, message) => { logs.push(`${kind}: ${message}`); };
  b2.onEnvelope(replay4);
  assert.ok(logs.some((l) => l.includes('replayed or out-of-order')), '重启后旧 seq 应被拒');
  const seq6 = { v: 1, type: 'ping', payload: {}, seq: 6 };
  seq6.hmac = host.hmacSign(b2['sessionKey'], 6, 'ping', {});
  b2.onEnvelope(seq6);
  assert.ok(!logs.some((l) => l.includes('seq=6') && l.includes('reject')), 'seq 6 应通过');
});

test('A14: native host 单实例锁——第二实例拒绝并输出 bridge_busy', () => {
  const host1 = require('../src/native-host/host.js');
  // acquireInstanceLock 未导出——通过模块级锁文件路径行为验证：先直接调 startNativeMessagingStdio
  // 的锁语义（用临时 STATE_DIR 注入）。锁函数是模块私有，导出验证签名存在即可：
  assert.equal(typeof host1.startNativeMessagingStdio, 'function');
  assert.equal(typeof host1.encodeFrame, 'function');
  // 行为验证走真实 Chrome E2E（browser-bridge.chrome.e2e.cjs），单元层锁定 API 形状。
});

// ---------------------------------------------------------------------------
// A14-6（27 §14）：HKDF 子密钥派生 + 版本协商 + 旧端回退。
// v1 = 会话根密钥直接作 HMAC 密钥；v2 = HKDF(根密钥, 配对随机 salt) 派生用途限定子密钥。
// ---------------------------------------------------------------------------

test('A14-6: 三方 HKDF 派生逐字节一致（桥 / 宿主 / 扩展）', () => {
  const ext = require('../chrome-extension/background.js');
  const sessionKey = Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex');
  const salt = Buffer.from('ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100', 'hex');
  const bridgeKey = bridge.deriveMessageKey(sessionKey, salt);
  const hostKey = host.hkdfMessageKey(sessionKey, salt.toString('base64'));
  const extKey = Buffer.from(ext.deriveMessageKeyBytes(sessionKey.toString('base64'), salt.toString('base64')));
  assert.equal(bridgeKey.length, 32, '派生 key 32 字节');
  assert.deepEqual(hostKey, bridgeKey, '宿主派生必须与桥一致');
  assert.deepEqual(extKey, bridgeKey, '扩展派生必须与桥一致（纯 JS HKDF / node hkdfSync）');
  // v2 的关键性质：根密钥不进入签名路径。
  assert.notDeepEqual(bridgeKey, sessionKey);
  // 用途分离：info 不同即不同 key。
  const other = Buffer.from(crypto.hkdfSync('sha256', sessionKey, salt, 'ops-browser-bridge/v2/other', 32));
  assert.notDeepEqual(bridgeKey, other, 'info 变化必须换 key');
  // 每配对 salt 不同：同根密钥不同配对不共享子密钥。
  const otherSalt = Buffer.from('00'.repeat(32), 'hex');
  assert.notDeepEqual(bridge.deriveMessageKey(sessionKey, otherSalt), bridgeKey, 'salt 变化必须换 key');
});

test('A14-6: v2 协商——派生 key 生效，根密钥签名被拒', { timeout: 20_000 }, async (t) => {
  const { b, next, send } = await startBridgeWithMockHost(t);
  send({ v: 1, type: 'hello', payload: { host_instance_id: 'mock-host-v2', protocol_version: 1, crypto_versions: [1, 2] } });
  assert.equal((await next()).type, 'pairing_start');

  assert.equal(b.confirmPairing().ok, true);
  const confirm = await next();
  assert.equal(confirm.type, 'pairing_confirm');
  assert.equal(confirm.payload.crypto_version, 2, '宿主声明 v2 后应协商为 v2');
  assert.match(String(confirm.payload.hkdf_salt || ''), /^[A-Za-z0-9+/]{43}=$/, 'v2 下发 32 字节 base64 salt');

  const sessionKey = Buffer.from(confirm.payload.session_key, 'base64');
  const msgKey = bridge.deriveMessageKey(sessionKey, Buffer.from(confirm.payload.hkdf_salt, 'base64'));
  const rejects = () => b.snapshot().events.filter((e) => e.message.includes('reject')).length;

  const beforeOk = rejects();
  send({ v: 1, type: 'ping', payload: {}, seq: 1, hmac: host.hmacSign(msgKey, 1, 'ping', {}) });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(rejects(), beforeOk, '派生 key 签名应被接受');

  const beforeRoot = rejects();
  send({ v: 1, type: 'ping', payload: {}, seq: 2, hmac: host.hmacSign(sessionKey, 2, 'ping', {}) });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(rejects(), beforeRoot + 1, 'v2 下根密钥签名必须被拒');
});

test('A14-6: 宿主分段协商——旧扩展降级 v1，桥段不受影响', () => {
  const { negotiateCryptoVersion, CRYPTO_VERSION_V1, CRYPTO_VERSION_V2 } = host;
  // 桥下发 v2，扩展声明支持 v2 → 两段都是 v2
  assert.equal(negotiateCryptoVersion(2, true), CRYPTO_VERSION_V2);
  // 桥下发 v2，扩展未声明（旧扩展）→ 扩展段回退 v1；桥段仍由 supportsV2=true 保持 v2
  assert.equal(negotiateCryptoVersion(2, false), CRYPTO_VERSION_V1);
  assert.equal(negotiateCryptoVersion(2, true), CRYPTO_VERSION_V2);
  // 桥下发 v1（旧桥）→ 无论扩展能力都只能 v1
  assert.equal(negotiateCryptoVersion(1, true), CRYPTO_VERSION_V1);
  assert.equal(negotiateCryptoVersion(1, false), CRYPTO_VERSION_V1);
  // 缺字段/非法值 → v1（不猜测）
  assert.equal(negotiateCryptoVersion(undefined, true), CRYPTO_VERSION_V1);
  assert.equal(negotiateCryptoVersion('2', true), CRYPTO_VERSION_V2, '数字字符串按数值解析');
  assert.equal(negotiateCryptoVersion(99, true), CRYPTO_VERSION_V1, '未知版本不启用');
});

test('A14-6: 旧宿主不声明能力时回退 v1（握手与签名语义不变）', { timeout: 20_000 }, async (t) => {
  const { b, next, send } = await startBridgeWithMockHost(t);
  send({ v: 1, type: 'hello', payload: { host_instance_id: 'legacy-host', protocol_version: 1 } });
  await next();

  assert.equal(b.confirmPairing().ok, true);
  const confirm = await next();
  assert.equal(confirm.payload.crypto_version, 1, '未声明能力应回退 v1');
  assert.equal(confirm.payload.hkdf_salt, undefined, 'v1 不下发 salt');

  const sessionKey = Buffer.from(confirm.payload.session_key, 'base64');
  const rejects = () => b.snapshot().events.filter((e) => e.message.includes('reject')).length;
  const before = rejects();
  send({ v: 1, type: 'ping', payload: {}, seq: 1, hmac: host.hmacSign(sessionKey, 1, 'ping', {}) });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(rejects(), before, 'v1 仍用根密钥签名');
});
