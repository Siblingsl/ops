'use strict';
// DEV-AI27-02 W02 技术验证：OPS Native Messaging 宿主（Chrome 原生 stdio 模式）。
// Chrome(扩展) <-> [4字节小端长度前缀 JSON] <-> 宿主 <-> [回环 NDJSON] <-> OPS 桌面桥。
// 宿主只做固定信封的转发与校验（版本/类型白名单/HMAC/seq 单调），不执行业务动作；
// stdout 只走协议帧，诊断日志限量写本地文件。require 时仅导出纯函数，直接执行才启动主循环。

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const OPS_HOST = '127.0.0.1';
const OPS_PORT = 8765;
const MAX_FRAME = 4 * 1024 * 1024;
const MAX_LINE = 4 * 1024 * 1024;
const PROTOCOL_VERSION = 1;
// A14-6（27 §14）：信封加密版本，与 browser-bridge.ts / chrome-extension/background.js 同步。
// v1 = 会话根密钥直接作 HMAC 密钥；v2 = 按配对随机 salt 用 HKDF-SHA256 派生。
const CRYPTO_VERSION_V1 = 1;
const CRYPTO_VERSION_V2 = 2;
const SUPPORTED_CRYPTO_VERSIONS = [CRYPTO_VERSION_V1, CRYPTO_VERSION_V2];
const HKDF_INFO = 'ops-browser-bridge/v2/hmac';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 8000;
const STATE_DIR = path.join(os.homedir(), '.ops-browser-bridge');
const STATE_PATH = path.join(STATE_DIR, 'host-state.json');
const LOG_PATH = path.join(STATE_DIR, 'host.log');

// 宿主可信的消息类型（入站双向）：OPS→宿主发 pairing/command/revoke 等；
// 扩展→宿主发 hello/result/error；pairing_start 在未配对状态也可信。
const TRUSTED_TYPES = new Set([
  'hello',
  'result',
  'pairing_start',
  'pairing_confirm',
  'pairing_confirmed',
  'command',
  'revoke',
  'ping',
  'pong',
  'error',
]);

function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  if (body.length > MAX_FRAME) throw new Error(`frame too large: ${body.length}`);
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

function createFrameDecoder(maxFrame = MAX_FRAME) {
  let buf = Buffer.alloc(0);
  return {
    feed(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const frames = [];
      while (buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (!Number.isSafeInteger(len) || len > maxFrame) throw new Error(`frame length invalid: ${len}`);
        if (buf.length < 4 + len) break;
        frames.push(JSON.parse(buf.subarray(4, 4 + len).toString('utf8')));
        buf = buf.subarray(4 + len);
      }
      return frames;
    },
  };
}

// A14-5（27 §14）：HMAC 材料扩展到 seq.type.nonce.payload_hash.payload——与桥端
// （browser-bridge.ts）同步升级；nonce/payload_hash 缺省为空串（非 result 信封）。
function hmacSign(key, seq, type, payload, nonce, payloadHash) {
  return crypto
    .createHmac('sha256', normalizeKey(key))
    .update(`${seq}.${type}.${nonce || ''}.${payloadHash || ''}.${JSON.stringify(payload ?? null)}`)
    .digest('base64');
}

// 会话密钥统一为 base64 解码后的原始字节；兼容调用方直接传 Buffer 或 base64 字符串。
function normalizeKey(key) {
  if (Buffer.isBuffer(key)) return key;
  return Buffer.from(String(key), 'base64');
}

// A14-6：v2 的 HMAC 密钥 = HKDF-SHA256(ikm=会话根密钥, salt=本次配对随机盐, info=用途)。
// 派生 key 只用于签名/验签，根密钥不进入签名路径。与桥侧 deriveMessageKey 必须逐字节一致。
function hkdfMessageKey(sessionKey, salt) {
  return Buffer.from(crypto.hkdfSync('sha256', normalizeKey(sessionKey), Buffer.from(String(salt), 'base64'), HKDF_INFO, 32));
}

// A14-6：单段链路的版本决策——桥下发 v2 且该段对端声明支持 v2 才启用，否则回退 v1。
// 宿主↔桥段把 supportsV2 传 true（桥是 v2 的下发方）；宿主↔扩展段传扩展 hello 的声明。
function negotiateCryptoVersion(offered, supportsV2) {
  const want = Number(offered) || CRYPTO_VERSION_V1;
  return want === CRYPTO_VERSION_V2 && supportsV2 ? CRYPTO_VERSION_V2 : CRYPTO_VERSION_V1;
}

function verifyHmac(key, msg) {
  if (!key) return false;
  if (typeof msg.seq !== 'number' || typeof msg.hmac !== 'string') return false;
  const expect = Buffer.from(hmacSign(key, msg.seq, msg.type, msg.payload, msg.nonce, msg.payload_hash));
  const got = Buffer.from(msg.hmac);
  if (!(expect.length === got.length && crypto.timingSafeEqual(expect, got))) {
    // W02 诊断：签名不一致只记类型与摘要前缀，不落载荷内容（日志脱敏）。
    try {
      fs.appendFileSync(LOG_PATH, `hmac mismatch type=${msg.type} seq=${msg.seq} expect=${hmacSign(key, msg.seq, msg.type, null, '', '').slice(0, 8)} got=${msg.hmac.slice(0, 8)}\n`);
    } catch {}
  }
  return expect.length === got.length && crypto.timingSafeEqual(expect, got);
}

// 信封校验器：版本、类型白名单、大小上限；配对后追加 HMAC 与 seq 单调（防重放）。
// hello/pairing_start 是配对起点，永远免签——宿主持旧会话密钥时也能重建配对。
function createEnvelopeValidator({ getSessionKey }) {
  let lastSeqIn = 0;
  return {
    lastSeqIn() {
      return lastSeqIn;
    },
    // 重新配对即新会话：入站序列归零（发送侧序列由调用方同步归零）。
    reset() {
      lastSeqIn = 0;
    },
    check(msg) {
      if (!msg || typeof msg !== 'object') return 'envelope must be object';
      if (msg.v !== PROTOCOL_VERSION) return `protocol version mismatch: ${msg.v}`;
      if (!TRUSTED_TYPES.has(msg.type)) return `type not allowed: ${msg.type}`;
      if (JSON.stringify(msg).length > MAX_FRAME) return 'envelope too large';
      const key = getSessionKey();
      if (key && msg.type !== 'pairing_start' && msg.type !== 'hello') {
        if (!verifyHmac(key, msg)) return 'hmac verification failed';
        if (msg.seq <= lastSeqIn) return `replayed or out-of-order seq: ${msg.seq}`;
        lastSeqIn = msg.seq;
      }
      return null;
    },
  };
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_PATH);
}

// A14-4（27 §14）：多 Chrome（多 profile）并发连接同一 native host 时互斥——
// 锁文件记录当前持有者 PID；进程死亡（PID 不存在）自动接管，活锁返回 busy。
// Chrome 每个扩展实例一个 host 进程：锁阻止第二个 host 抢占同一 OPS 桥端口连接。
const LOCK_PATH = path.join(STATE_DIR, 'host-instance.lock');
const LOCK_STALE_MS = 60 * 1000;

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function acquireInstanceLock(log) {
  try {
    let current = null;
    try { current = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')); } catch { /* 无锁 */ }
    if (current && current.pid && current.pid !== process.pid) {
      if (processAlive(current.pid) && Date.now() - (current.at || 0) < LOCK_STALE_MS) {
        return { ok: false, reason: 'bridge_busy' };
      }
      log(`stale instance lock from pid=${current.pid}; take over`);
    }
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
    return { ok: true };
  } catch (err) {
    // 锁文件系统异常时不阻断主流程（桥端连接唯一性由端口语义兜底），只记日志。
    try { log(`instance lock unavailable: ${err.message}`); } catch {}
    return { ok: true };
  }
}

function releaseInstanceLock() {
  try {
    const current = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    if (current.pid === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch { /* 无锁或已换主 */ }
}

function createLogger() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    return (line) => {
      try {
        fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
      } catch {
        /* 日志失败不影响协议 */
      }
    };
  } catch {
    return () => {};
  }
}

function startNativeMessagingStdio({ log = createLogger(), opsPort = OPS_PORT, opsHost = OPS_HOST, requireLock = true } = {}) {
  // A14-4：单实例锁——第二个 Chrome profile 的 host 拿不到锁时立即退出（Chrome 显示
  // native host 断开），扩展侧指数退避；不与已持有者抢 OPS 桥连接。
  if (requireLock) {
    const lock = acquireInstanceLock(log);
    if (!lock.ok) {
      log(`another native host instance is active (bridge_busy); exiting pid=${process.pid}`);
      // Chrome native messaging：非零退出即断开；输出一个错误帧便于诊断。
      try { process.stdout.write(encodeFrame({ v: PROTOCOL_VERSION, type: 'error', payload: { code: 'bridge_busy', message: '另一个 OPS 浏览器宿主实例正在运行；请关闭其中一个 Chrome 或重启 OPS。' } })); } catch {}
      process.exit(0);
      return;
    }
  }
  const decoder = createFrameDecoder();
  const state = readState();
  const hostInstanceId = state.host_instance_id || crypto.randomUUID();
  // 每次启动都刷新 pid：M3 场景依赖 host-state.json 的 pid 精确指向当前宿主进程。
  if (!state.host_instance_id || state.pid !== process.pid || state.session_key !== (state.session_key || null)) {
    writeState({ host_instance_id: hostInstanceId, pid: process.pid, session_key: state.session_key || null });
  }

  let sessionKey = state.session_key || null;
  // A14-6：两段链路各自协商加密版本——桥↔宿主以桥下发的 crypto_version 为准（权威），
  // 宿主↔扩展取「桥下发版本 ∩ 扩展 hello 声明的能力」，旧扩展自然退回 v1。
  let opsCryptoVersion = CRYPTO_VERSION_V1;
  let opsMessageKey = null;
  let extCryptoVersion = CRYPTO_VERSION_V1;
  let extMessageKey = null;
  let hkdfSalt = null;
  let extSupportsV2 = false;
  const opsSignKey = () => (opsCryptoVersion === CRYPTO_VERSION_V2 ? opsMessageKey : sessionKey);
  const extSignKey = () => (extCryptoVersion === CRYPTO_VERSION_V2 ? extMessageKey : sessionKey);
  // 两条链路各自独立的序列空间：ops（宿主<->OPS 桥）与 ext（宿主<->Chrome 扩展）。
  // 桥->扩展的 command 由宿主验签后重签（seqOutExt），扩展->桥的 result 反向同理。
  const opsValidator = createEnvelopeValidator({ getSessionKey: opsSignKey });
  const extValidator = createEnvelopeValidator({ getSessionKey: extSignKey });
  let opsSocket = null;
  let opsBuf = '';
  let closed = false;
  let reconnectDelay = RECONNECT_BASE_MS;
  let reconnectTimer = null;
  let seqOutOps = 0;
  let seqOutExt = 0;

  function frameToChrome(obj) {
    process.stdout.write(encodeFrame(obj));
  }

  function signOps(msg) {
    const key = opsSignKey();
    if (key && msg.type !== 'hello') {
      seqOutOps += 1;
      msg.seq = seqOutOps;
      msg.hmac = hmacSign(key, msg.seq, msg.type, msg.payload, msg.nonce, msg.payload_hash);
    }
    return msg;
  }

  function signExt(msg) {
    const key = extSignKey();
    if (key && msg.type !== 'pairing_start' && msg.type !== 'pairing_confirm') {
      seqOutExt += 1;
      msg.seq = seqOutExt;
      msg.hmac = hmacSign(key, msg.seq, msg.type, msg.payload, msg.nonce, msg.payload_hash);
    }
    return msg;
  }

  function toOps(msg) {
    if (!opsSocket || opsSocket.destroyed) {
      log(`drop ${msg.type}: ops not connected`);
      return;
    }
    opsSocket.write(`${JSON.stringify(signOps(msg))}\n`);
  }

  function handleChrome(msg) {
    const err = extValidator.check(msg);
    if (err) {
      log(`reject chrome->ops: ${err}`);
      frameToChrome({ v: PROTOCOL_VERSION, type: 'error', payload: { reason: err } });
      return;
    }
    if (msg.type === 'hello') {
      // A14-6：扩展 hello 声明能力；扩展段版本在 pairing_confirm 时按交集确定。
      const p = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
      extSupportsV2 = Array.isArray(p.crypto_versions) && p.crypto_versions.includes(CRYPTO_VERSION_V2);
    }
    if (msg.type === 'result' || msg.type === 'error' || msg.type === 'hello') {
      // 转发给 OPS 前按宿主->桥序列空间重签（原始 seq 属于扩展->宿主空间）。
      delete msg.seq;
      delete msg.hmac;
    }
    toOps(msg);
  }

  function handleOps(msg) {
    const err = opsValidator.check(msg);
    if (err) {
      log(`reject ops->chrome: ${err}`);
      return;
    }
    // pairing_start 表示桥端要求重新配对：作废旧会话密钥与全部序列状态（新会话从零开始）。
    if (msg.type === 'pairing_start' && (sessionKey || opsValidator.lastSeqIn() > 0 || extValidator.lastSeqIn() > 0 || seqOutOps > 0 || seqOutExt > 0)) {
      sessionKey = null;
      opsMessageKey = null;
      extMessageKey = null;
      hkdfSalt = null;
      opsCryptoVersion = CRYPTO_VERSION_V1;
      extCryptoVersion = CRYPTO_VERSION_V1;
      opsValidator.reset();
      extValidator.reset();
      seqOutOps = 0;
      seqOutExt = 0;
      writeState({ host_instance_id: hostInstanceId, pid: process.pid, session_key: null });
      log('session state cleared for re-pairing');
    }
    if (msg.type === 'pairing_confirm' && msg.payload && msg.payload.session_key) {
      sessionKey = String(msg.payload.session_key);
      hkdfSalt = typeof msg.payload.hkdf_salt === 'string' ? msg.payload.hkdf_salt : null;
      const want = Number(msg.payload.crypto_version) || CRYPTO_VERSION_V1;
      opsCryptoVersion = hkdfSalt ? negotiateCryptoVersion(want, true) : CRYPTO_VERSION_V1;
      opsMessageKey = opsCryptoVersion === CRYPTO_VERSION_V2 ? hkdfMessageKey(sessionKey, hkdfSalt) : null;
      // 扩展段独立降级：旧扩展不支持 v2 时仍走会话根密钥。
      extCryptoVersion = hkdfSalt ? negotiateCryptoVersion(want, extSupportsV2) : CRYPTO_VERSION_V1;
      extMessageKey = extCryptoVersion === CRYPTO_VERSION_V2 ? hkdfMessageKey(sessionKey, hkdfSalt) : null;
      writeState({ host_instance_id: hostInstanceId, pid: process.pid, session_key: sessionKey });
      log(`session key stored crypto=ops:v${opsCryptoVersion} ext:v${extCryptoVersion}`);
    }
    if (msg.type === 'revoke') {
      sessionKey = null;
      opsMessageKey = null;
      extMessageKey = null;
      hkdfSalt = null;
      opsCryptoVersion = CRYPTO_VERSION_V1;
      extCryptoVersion = CRYPTO_VERSION_V1;
      writeState({ host_instance_id: hostInstanceId, pid: process.pid, session_key: null });
      log('session revoked by ops');
    }
    if (msg.type === 'command' || msg.type === 'revoke' || msg.type === 'ping' || msg.type === 'pong') {
      // 转发给扩展前按宿主->扩展序列空间重签（原始 seq 属于桥->宿主空间）。
      delete msg.seq;
      delete msg.hmac;
      signExt(msg);
    }
    if (msg.type === 'pairing_confirm') {
      // 扩展段版本可能与桥→宿主段不同（旧扩展）。扩展据此决定是否走 HKDF；
      // 该信封在扩展侧免验签（pairing_start 已清密钥），改写不破坏校验链。
      delete msg.seq;
      delete msg.hmac;
      if (msg.payload && typeof msg.payload === 'object') msg.payload.crypto_version = extCryptoVersion;
    }
    frameToChrome(msg);
  }

  function connectOps() {
    if (closed || (opsSocket && !opsSocket.destroyed)) return;
    const socket = net.connect(opsPort, opsHost);
    opsSocket = socket;
    socket.setNoDelay(true);
    socket.on('connect', () => {
      reconnectDelay = RECONNECT_BASE_MS;
      log(`ops connected ${opsHost}:${opsPort} localPort=${socket.localPort} pid=${process.pid}`);
      toOps({
        v: PROTOCOL_VERSION,
        type: 'hello',
        payload: {
          host_instance_id: hostInstanceId,
          pid: process.pid,
          protocol_version: PROTOCOL_VERSION,
          // A14-6：声明信封加密能力，桥据此协商；缺省即 v1（旧宿主声明）。
          crypto_versions: SUPPORTED_CRYPTO_VERSIONS,
          connected_at: Date.now(),
        },
      });
    });
    socket.on('data', (chunk) => {
      opsBuf += chunk.toString('utf8');
      let idx;
      while ((idx = opsBuf.indexOf('\n')) >= 0) {
        const line = opsBuf.slice(0, idx);
        opsBuf = opsBuf.slice(idx + 1);
        if (!line.trim()) continue;
        if (line.length > MAX_LINE) {
          log('ops line too large; drop');
          continue;
        }
        try {
          const parsed = JSON.parse(line);
          handleOps(parsed);
        } catch (err) {
          log(`ops line parse failed: ${err.message}`);
        }
      }
      if (opsBuf.length > MAX_LINE) {
        log('ops buffer overflow; reset');
        opsBuf = '';
      }
    });
    socket.on('error', (err) => log(`ops socket error: ${err.message}`));
    socket.on('close', () => {
      opsSocket = null;
      if (!closed) {
        reconnectTimer = setTimeout(connectOps, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      }
    });
  }

  process.stdin.on('data', (chunk) => {
    let frames;
    try {
      frames = decoder.feed(chunk);
    } catch (err) {
      log(`chrome frame error: ${err.message}`);
      process.exit(1);
      return;
    }
    for (const frame of frames) handleChrome(frame);
  });
  process.stdin.on('end', () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (opsSocket) opsSocket.destroy();
    releaseInstanceLock();
    process.exit(0);
  });
  process.on('disconnect', () => {
    releaseInstanceLock();
    process.exit(0);
  });
  connectOps();
  log('host started pid=' + process.pid);
}

if (require.main === module) {
  startNativeMessagingStdio();
}

module.exports = {
  encodeFrame,
  createFrameDecoder,
  hmacSign,
  verifyHmac,
  hkdfMessageKey,
  negotiateCryptoVersion,
  createEnvelopeValidator,
  PROTOCOL_VERSION,
  CRYPTO_VERSION_V1,
  CRYPTO_VERSION_V2,
  SUPPORTED_CRYPTO_VERSIONS,
  HKDF_INFO,
  OPS_HOST,
  OPS_PORT,
  startNativeMessagingStdio,
};
