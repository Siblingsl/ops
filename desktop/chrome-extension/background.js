'use strict';
// DEV-AI27-02 W02 技术验证：OPS Browser Bridge 扩展 service worker。
// 只执行本文件动作登记表内的动作（chrome.scripting.executeScript 传包内函数引用），
// 不接收任意 JS / CDP 方法 / 远程逻辑；全部状态持久化到 chrome.storage，覆盖 worker 休眠重启。

const HOST_NAME = 'com.ops.desktop.bridge';
const PROTOCOL_VERSION = 1;
// A14-6（27 §14）：信封加密版本，与 desktop/src/browser-bridge.ts、native-host/host.js 同步。
// v1 = 会话根密钥直接作 HMAC 密钥；v2 = 按配对随机 salt 用 HKDF-SHA256 派生子密钥。
const CRYPTO_VERSION_V1 = 1;
const CRYPTO_VERSION_V2 = 2;
const SUPPORTED_CRYPTO_VERSIONS = [CRYPTO_VERSION_V1, CRYPTO_VERSION_V2];
const HKDF_INFO = 'ops-browser-bridge/v2/hmac';
const MAX_NODES = 300;
const COMMAND_TIMEOUT_MS = 30_000;

const sw = {
  port: null,
  sessionKey: null,
  cryptoVersion: CRYPTO_VERSION_V1,
  hkdfSalt: null,
  messageKey: null,
  seqOut: 0,
  lastSeqIn: 0,
  paired: false,
  reconnectDelay: 1000,
  reconnectTimer: null,
  started: false,
  // B-01：agent 正在使用的 tab（人工接管卡片的注入范围）。持久化到 storage.local，
  // SW 重启后按 tab 重新注入；tab 关闭/接管结束即移除。
  agentTabs: new Set(),
  // tabId -> {state, handoffId, message, origin}；状态只服务卡片显示与完成校验。
  pageStatus: new Map(),
  // 当前文档是否已注入 page-status.js（导航 loading/complete 时重置）。
  pageStatusInjected: new Set(),
  // 同一 handoffId 只上报一次完成（页面重试/重复点击幂等）。
  completedHandoffs: new Set(),
  // B-07：桥下发的访问模式（只读 + 来源白名单）；扩展侧做第二道校验。
  readOnly: false,
  allowedOrigins: new Set(),
  // B-02A：人类化输入（点击轨迹/逐字输入/滚动分帧）；默认关闭，由桥下发。
  humanInput: false,
  // B-02B：可信输入（chrome.debugger 的 Input 域）；默认关闭，需可选权限 + 桥下发。
  debuggerInput: false,
  debuggerTabs: new Map(),
};

// MV3 service worker 无 node:crypto；用自实现 HMAC-SHA256（同步、无依赖）。
// 实现与宿主侧 node:crypto 结果必须一致，host.test.cjs 做了交叉校验。
function hmacSha256Base64(keyStr, message) {
  const key = strToBytes(keyStr);
  const block = 64;
  let k = key.slice(0, block);
  while (k.length < block) k.push(0);
  const oKey = k.map((b) => b ^ 0x5c);
  const iKey = k.map((b) => b ^ 0x36);
  const inner = sha256Raw(iKey.concat(strToBytes(message)));
  const outer = sha256Raw(oKey.concat(inner));
  return bytesToBase64(outer);
}

function strToBytes(s) {
  const out = [];
  for (let i = 0; i < s.length; i += 1) {
    const c = s.codePointAt(i);
    if (c > 0x7f) {
      // UTF-8 编码
      if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      if (c > 0xffff) i += 1;
    } else out.push(c);
  }
  return out;
}

function sha256Raw(bytes) {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const msg = bytes.slice();
  const bitLen = bytes.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  for (let i = 7; i >= 0; i -= 1) msg.push((bitLen / 2 ** (i * 8)) & 0xff);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < msg.length; off += 64) {
    const w = new Array(64);
    for (let i = 0; i < 16; i += 1) {
      w[i] = (msg[off + i * 4] << 24) | (msg[off + i * 4 + 1] << 16) | (msg[off + i * 4 + 2] << 8) | msg[off + i * 4 + 3];
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h = [
      (h[0] + a) | 0, (h[1] + b) | 0, (h[2] + c) | 0, (h[3] + d) | 0,
      (h[4] + e) | 0, (h[5] + f) | 0, (h[6] + g) | 0, (h[7] + hh) | 0,
    ];
  }
  const out = [];
  for (const word of h) out.push((word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255);
  return out;
}

function bytesToBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function hmacSignMessage(seq, type, payload, nonce, payloadHash) {
  // v2 用 HKDF 派生 key；v1（含旧配对残留）用会话根密钥。两者都是原始字节。
  // A14-5：签名材料扩展到 seq.type.nonce.payload_hash.payload（与宿主/桥同步）。
  const keyBytes = sw.messageKey || base64ToBytes(sw.sessionKey);
  return hmacSha256Base64Bytes(keyBytes, `${seq}.${type}.${nonce || ''}.${payloadHash || ''}.${JSON.stringify(payload ?? null)}`);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = [];
  for (let i = 0; i < bin.length; i += 1) out.push(bin.charCodeAt(i));
  return out;
}

// 原始字节 HMAC-SHA256（供 HKDF 使用；现有 base64 版本只在末尾编码不同）。
function hmacSha256Raw(keyBytes, msgBytes) {
  const block = 64;
  let k = keyBytes.slice(0, block);
  while (k.length < block) k.push(0);
  const oKey = k.map((b) => b ^ 0x5c);
  const iKey = k.map((b) => b ^ 0x36);
  return sha256Raw(oKey.concat(sha256Raw(iKey.concat(msgBytes))));
}

// A14-6：HKDF-SHA256（RFC 5869）单块 expand，输出 32 字节。
// 与 node 侧 crypto.hkdfSync('sha256', ikm, salt, info, 32) 必须逐字节一致。
function deriveMessageKeyBytes(sessionKeyB64, saltB64) {
  const ikm = base64ToBytes(sessionKeyB64);
  const salt = base64ToBytes(saltB64);
  const prk = hmacSha256Raw(salt.length ? salt : new Array(32).fill(0), ikm);
  const t1 = hmacSha256Raw(prk, strToBytes(HKDF_INFO).concat([0x01]));
  return t1.slice(0, 32);
}

function hmacSha256Base64Bytes(keyBytes, message) {
  const key = keyBytes;
  const block = 64;
  let k = key.slice(0, block);
  while (k.length < block) k.push(0);
  const oKey = k.map((b) => b ^ 0x5c);
  const iKey = k.map((b) => b ^ 0x36);
  const inner = sha256Raw(iKey.concat(strToBytes(message)));
  const outer = sha256Raw(oKey.concat(inner));
  return bytesToBase64(outer);
}

function utf8EqualBase64(a, b) {
  return a === b;
}

let loadStateInFlight = null;
// Q-22（docs/41）：onInstalled 与主入口会在 SW 启动时并发调用 loadState；两次读到的
// 都是写入前快照，会各自生成不同 UUID（bridge 快照与 storage 不一致，SW 重启后换 ID）。
// 单飞（in-flight 去重）保证同一时刻只有一个读取+生成流程，后续调用共享同一结果。
async function loadState() {
  if (!loadStateInFlight) {
    loadStateInFlight = loadStateOnce().finally(() => { loadStateInFlight = null; });
  }
  return loadStateInFlight;
}

async function loadStateOnce() {
  const d = await chrome.storage.local.get(['session_key', 'seq_out', 'last_seq_in', 'paired', 'pairing_code', 'pairing_expires_at', 'extension_instance_id', 'last_commands', 'crypto_version', 'hkdf_salt', 'agent_tabs', 'page_status', 'access_mode']);
  sw.sessionKey = d.session_key || null;
  sw.cryptoVersion = Number(d.crypto_version) === CRYPTO_VERSION_V2 ? CRYPTO_VERSION_V2 : CRYPTO_VERSION_V1;
  sw.hkdfSalt = d.hkdf_salt || null;
  // A14-6：v2 时在 worker 重启后重建派生 key；缺 salt 视为未完成协商，退回 v1。
  sw.messageKey = sw.cryptoVersion === CRYPTO_VERSION_V2 && sw.sessionKey && sw.hkdfSalt
    ? deriveMessageKeyBytes(sw.sessionKey, sw.hkdfSalt)
    : null;
  sw.seqOut = d.seq_out || 0;
  sw.lastSeqIn = d.last_seq_in || 0;
  sw.paired = Boolean(d.paired && d.session_key);
  const mode = d.access_mode && typeof d.access_mode === 'object' ? d.access_mode : {};
  sw.readOnly = Boolean(mode.read_only);
  sw.allowedOrigins = new Set((Array.isArray(mode.allowed_origins) ? mode.allowed_origins : []).map(normalizeOrigin).filter(Boolean));
  sw.humanInput = Boolean(mode.human_input);
  sw.debuggerInput = Boolean(mode.debugger_input);
  sw.agentTabs = new Set((Array.isArray(d.agent_tabs) ? d.agent_tabs : []).map(Number).filter((n) => Number.isInteger(n) && n > 0));
  sw.pageStatus = new Map((Array.isArray(d.page_status) ? d.page_status : []).filter((e) => Array.isArray(e) && e.length === 2).map((e) => [String(e[0]), e[1]]));
  let instanceId = d.extension_instance_id;
  if (!instanceId) {
    instanceId = crypto.randomUUID();
    await chrome.storage.local.set({ extension_instance_id: instanceId });
  }
  // Q-22（docs/41）：首装时 d 是写入前的快照，extension_instance_id 为 undefined；
  // 返回值必须并入生成的 ID，否则调用方 sw.extensionInstanceId 拿到 undefined，
  // hello 信封缺字段，W04 首次连接向导 confirm 报“实例标识必须是 UUID”。
  return { ...d, extension_instance_id: instanceId };
}

async function saveVolatile() {
  await chrome.storage.local.set({
    seq_out: sw.seqOut,
    last_seq_in: sw.lastSeqIn,
    paired: sw.paired,
  });
}

function sign(msg) {
  if (sw.sessionKey && msg.type !== 'hello') {
    sw.seqOut += 1;
    msg.seq = sw.seqOut;
    // A14-5：回执（result）信封带 nonce/payload_hash，纳入签名材料。
    msg.hmac = hmacSignMessage(sw.seqOut, msg.type, msg.payload, msg.nonce, msg.payload_hash);
  }
  return msg;
}

async function validateInbound(msg) {
  if (!msg || typeof msg !== 'object') return 'envelope must be object';
  if (msg.v !== PROTOCOL_VERSION) return `protocol version mismatch: ${msg.v}`;
  const allowed = ['pairing_start', 'pairing_confirm', 'pairing_confirmed', 'command', 'revoke', 'ping', 'pong', 'error', 'page_status'];
  if (!allowed.includes(msg.type)) return `type not allowed: ${msg.type}`;
  // pairing_start 是重新配对信号：作废旧密钥后免验签（与新密钥的 pairing_confirm 配套）。
  if (msg.type === 'pairing_start' && sw.sessionKey) {
    sw.sessionKey = null;
    sw.cryptoVersion = CRYPTO_VERSION_V1;
    sw.hkdfSalt = null;
    sw.messageKey = null;
    sw.paired = false;
    await chrome.storage.local.set({ session_key: null, paired: false, crypto_version: CRYPTO_VERSION_V1, hkdf_salt: null });
  }
  if (sw.sessionKey && msg.type !== 'pairing_start' && msg.type !== 'hello') {
    if (typeof msg.seq !== 'number' || typeof msg.hmac !== 'string') return 'missing seq/hmac';
    // A14-5：command/revoke 信封的 nonce/payload_hash 纳入签名材料（command 带值）。
    const expect = hmacSignMessage(msg.seq, msg.type, msg.payload, msg.nonce, msg.payload_hash);
    if (!utf8EqualBase64(expect, msg.hmac)) return 'hmac verification failed';
    if (msg.seq <= sw.lastSeqIn) return `replayed or out-of-order seq: ${msg.seq}`;
    sw.lastSeqIn = msg.seq;
    await saveVolatile();
  }
  return null;
}

function setBadge(text, color) {
  void chrome.action.setBadgeText({ text: text || '' });
  if (color) void chrome.action.setBadgeBackgroundColor({ color });
}

function setUiState(d) {
  void chrome.storage.local.set(d);
}

// ---------------------------------------------------------------------------
// 页面内登记动作（executeScript func：不能引用外部闭包，参数经 args 传入）
// ---------------------------------------------------------------------------

function observeFn(maxNodes) {
  const selector = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="checkbox"]';
  const all = Array.from(document.querySelectorAll(selector));
  const visible = all.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (!window.__opsRefMap) window.__opsRefMap = new Map();
  if (!window.__opsRefSeq) window.__opsRefSeq = 0;
  const nodes = [];
  const slice = visible.slice(0, maxNodes);
  for (const el of slice) {
    window.__opsRefSeq += 1;
    const ref = `n${window.__opsRefSeq}`;
    window.__opsRefMap.set(ref, el);
    nodes.push({
      ref,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      name: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || (el.textContent || '').trim().slice(0, 60) || '').slice(0, 80),
      href: el.tagName === 'A' ? (el.getAttribute('href') || '').slice(0, 120) : '',
    });
  }
  const prevRev = window.__opsDocRev;
  window.__opsDocRev = `r${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  if (!prevRev) window.__opsFirstRev = window.__opsDocRev;
  return {
    url: location.href,
    title: document.title,
    text_head: (document.body ? document.body.innerText : '').slice(0, 4000),
    nodes,
    node_total: visible.length,
    doc_rev: window.__opsDocRev,
  };
}

async function clickFn(ref, docRev, humanize) {
  if (window.__opsDocRev !== docRev) return { error: 'doc_rev_changed' };
  const el = window.__opsRefMap && window.__opsRefMap.get(ref);
  if (!el) return { error: 'ref_not_found' };
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return { error: 'ref_not_visible' };
  if (el.matches('input[type="password"]')) return { error: 'sensitive_control' };
  const tag = el.tagName.toLowerCase();
  const name = (el.textContent || '').trim().slice(0, 60);
  if (!humanize) {
    el.click();
    return { clicked: true, tag, name };
  }

  // B-02A：人类化点击（ISOLATED world 内合成事件，isTrusted 仍为 false，只改善行为轨迹）。
  // 常量与 desktop/src/platforms/human-input.ts 一致：时长上限 700ms、每步 8–17ms、
  // minimum-jerk、c1 20–35%、c2 65–80%、按下前 45–130ms、按住 60–140ms。
  const U = (min, max) => min + (max - min) * Math.random();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  const jerk = (t) => t ** 3 * (10 - 15 * t + 6 * t ** 2);
  const target = { x: r.left + r.width / 2 + (Math.random() * 4.4 - 2.2), y: r.top + r.height / 2 + (Math.random() * 3.2 - 1.6) };
  const from = { x: target.x + U(-260, 260), y: target.y + U(-180, 180) };
  const dist = Math.hypot(target.x - from.x, target.y - from.y);
  if (dist >= 2) {
    const duration = Math.min(700, (70 + 90 * Math.log2(dist / 40 + 1)) * U(0.85, 1.2));
    const bow = U(0.04, 0.18) * (Math.random() < 0.5 ? -1 : 1) * dist;
    const ux = -(target.y - from.y) / dist;
    const uy = (target.x - from.x) / dist;
    const c1r = U(0.2, 0.35);
    const c2r = U(0.65, 0.8);
    const c1 = { x: from.x + (target.x - from.x) * c1r + ux * bow, y: from.y + (target.y - from.y) * c1r + uy * bow };
    const c2 = { x: from.x + (target.x - from.x) * c2r + ux * bow * 0.6, y: from.y + (target.y - from.y) * c2r + uy * bow * 0.6 };
    const bez = (a, b, c, d, s) => (1 - s) ** 3 * a + 3 * (1 - s) ** 2 * s * b + 3 * (1 - s) * s ** 2 * c + s ** 3 * d;
    let elapsed = 0;
    while (elapsed < duration) {
      const step = U(8, 17);
      elapsed = Math.min(duration, elapsed + step);
      const s = jerk(elapsed / duration);
      const tremor = (1 - s) * 0.9;
      const x = bez(from.x, c1.x, c2.x, target.x, s) + (Math.random() + Math.random() + Math.random() - 1.5) * tremor;
      const y = bez(from.y, c1.y, c2.y, target.y, s) + (Math.random() + Math.random() + Math.random() - 1.5) * tremor;
      const hit = document.elementFromPoint(x, y) || document.body;
      hit.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
      await sleep(step);
    }
  }
  // 精确落点 + 按下前停留（减去到达耗时按 0 处理，总延迟仍落在 45–130ms）。
  el.focus && el.focus();
  el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window, clientX: target.x, clientY: target.y }));
  await sleep(U(45, 130));
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: target.x, clientY: target.y, button: 0 }));
  await sleep(U(60, 140));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX: target.x, clientY: target.y, button: 0 }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: target.x, clientY: target.y, button: 0 }));
  return { clicked: true, humanized: true, tag, name };
}

async function typeFn(ref, text, docRev, humanize) {
  if (window.__opsDocRev !== docRev) return { error: 'doc_rev_changed' };
  const el = window.__opsRefMap && window.__opsRefMap.get(ref);
  if (!el) return { error: 'ref_not_found' };
  const tag = el.tagName.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea') return { error: 'not_text_control' };
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (type === 'password' || type === 'file') return { error: 'sensitive_control' };
  el.focus();
  if (!humanize) {
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { typed: text.length, tag };
  }

  // B-02A：逐字符输入，间隔 U(30,110)ms，每个字符发 keydown/keypress/input/keyup。
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  const U = (min, max) => min + (max - min) * Math.random();
  el.value = '';
  const chars = Array.from(String(text));
  for (let i = 0; i < chars.length; i += 1) {
    if (i > 0) await sleep(U(30, 110));
    const ch = chars[i];
    const code = ch.charCodeAt(0);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, charCode: code, keyCode: code, bubbles: true, cancelable: true }));
    el.value += ch;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true, cancelable: true }));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { typed: chars.length, humanized: true, tag };
}

async function scrollFn(deltaY, docRev, humanize) {
  if (window.__opsDocRev !== docRev) return { error: 'doc_rev_changed' };
  const total = Number(deltaY) || 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  if (!humanize || Math.abs(total) < 40) {
    window.scrollBy(0, total);
    return { scrolled: total, humanized: !!humanize };
  }
  // B-02A：easeOutCubic 分摊，帧间隔 15.5–18ms，各帧 delta 严格求和。
  const U = (min, max) => min + (max - min) * Math.random();
  const frames = Math.max(1, Math.round((Math.min(140 + 0.45 * Math.abs(total), 650) * U(0.85, 1.15)) / 16.7));
  let allocated = 0;
  for (let i = 1; i <= frames; i += 1) {
    const s = 1 - (1 - i / frames) ** 3;
    const want = total * s;
    const delta = i === frames ? total - allocated : Math.round((want - allocated) * 100) / 100;
    allocated += delta;
    const x = window.innerWidth / 2;
    const y = window.innerHeight / 2;
    const hit = document.elementFromPoint(x, y) || document.body;
    hit.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, view: window, deltaY: delta, clientX: x, clientY: y }));
    window.scrollBy(0, delta);
    await sleep(U(15.5, 18));
  }
  return { scrolled: allocated, humanized: true };
}

function extractFn(selector, docRev) {
  if (window.__opsDocRev !== docRev) return { error: 'doc_rev_changed' };
  const el = document.querySelector(selector);
  if (!el) return { error: 'selector_not_found' };
  const isValueControl = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
  return {
    text: isValueControl ? String(el.value ?? '').slice(0, 2000) : (el.textContent || '').trim().slice(0, 2000),
    tag: el.tagName.toLowerCase(),
  };
}

// ---------------------------------------------------------------------------
// 动作分派（chrome API 编排 + executeScript）
// ---------------------------------------------------------------------------

function parseHost(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 160);
  } catch {
    return '';
  }
}

// B-07：白名单项归一化为 origin；裸 host 按 https，非 http(s) 丢弃。
function normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin.toLowerCase() : '';
  } catch {
    return '';
  }
}

async function actionTabsList() {
  // 只列出可被 Agent 操作的 http/https 标签；chrome://、about:、扩展页等内部页不进入授权列表。
  const tabs = (await chrome.tabs.query({})).filter((t) => /^https?:\/\//i.test(t.url || ''));
  return {
    tabs: tabs.map((t) => ({
      id: t.id,
      title: (t.title || '').slice(0, 100),
      origin: parseHost(t.url || ''),
      window_id: t.windowId,
      active: t.active,
    })),
  };
}

async function executeOn(tabId, fn, args) {
  // B-04：显式 ISOLATED（不是默认省略）。页面主世界脚本永远读不到 __ops* 状态，
  // 也不要为了取页面变量改成 MAIN。
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: fn, args, world: 'ISOLATED' });
  return res && res.result;
}

// frame 级注入（A7，27 §14.3 表格行 2）：observe_frames 上报的 frame_id 定向执行。
// 跨域 frame 由 Chrome 按 origin 隔离——未经 host_permissions 授权的 origin 注入直接拒绝；
// frameIds 里的 frame 不存在（导航后失效）时 executeScript 抛错，这里转成显式 error。
async function executeOnFrame(tabId, frameId, fn, args) {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: fn, args, world: 'ISOLATED' });
    return (results && results[0] && results[0].result) || { error: 'no_result' };
  } catch (err) {
    return { error: 'frame_inject_failed', message: String((err && err.message) || err).slice(0, 120) };
  }
}

// 4/9 frame 级观察（27 §14.3）：allFrames 注入，逐 frame 上报 origin 与节点摘要；
// 跨域 iframe 内容默认不展开（origin_only），由用户授权该 origin 后才返回节点。
async function actionObserveFrames(payload) {
  const tabId = Number(payload.tab_id);
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:/.test(tab.url)) return { error: 'tab_not_http' };
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: observeFrameFn,
    args: [MAX_NODES],
    world: 'ISOLATED',
  });
  const frames = results.map((r) => {
    const d = r.result || {};
    return { frame_id: r.frameId, origin: d.origin || '', doc_rev: d.doc_rev || '', nodes: d.nodes || [], node_total: d.node_total || 0 };
  });
  // 顶层 frame 直接返回；子 frame 只报 origin+计数（跨域内容默认隔离，27 §14.3 表格行 2）。
  return {
    top: frames[0] || null,
    sub_frames: frames.slice(1).map((f) => ({ frame_id: f.frame_id, origin: f.origin, node_total: f.node_total, doc_rev: f.doc_rev, nodes: [] })),
  };
}

function observeFrameFn(maxNodes) {
  const selector = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="checkbox"]';
  const all = Array.from(document.querySelectorAll(selector));
  const visible = all.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const w = window;
  if (!w.__opsRefMap) w.__opsRefMap = new Map();
  if (!w.__opsRefSeq) w.__opsRefSeq = 0;
  w.__opsRefMap.clear();
  const nodes = [];
  for (const el of visible.slice(0, maxNodes)) {
    w.__opsRefSeq += 1;
    const ref = `f${w.__opsRefSeq}`;
    w.__opsRefMap.set(ref, el);
    nodes.push({
      ref,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      name: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || (el.textContent || '').trim().slice(0, 60) || '').slice(0, 80),
    });
  }
  w.__opsDocRev = `r${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let origin = '';
  try { origin = `${location.protocol}//${location.host}`; } catch { origin = ''; }
  return { origin, node_total: visible.length, nodes, doc_rev: w.__opsDocRev };
}

async function actionObserve(payload) {
  const tabId = Number(payload.tab_id);
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:/.test(tab.url)) return { error: 'tab_not_http' };
  // A7：observe_frames 只报子 frame 的 origin 与计数；用户授权该 origin 后，
  // 由服务器校验 origin ∈ 租约并在调用方带 frame_id，这里定向注入取节点。
  const frameId = Number(payload.frame_id);
  if (Number.isInteger(frameId) && frameId > 0) {
    return executeOnFrame(tabId, frameId, observeFrameFn, [MAX_NODES]);
  }
  const result = await executeOn(tabId, observeFn, [MAX_NODES]);
  return result || { error: 'no_result' };
}

async function actionNavigate(payload) {
  const tabId = Number(payload.tab_id);
  const url = String(payload.url || '');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { error: 'url_invalid' };
  }
  if (!/^https?:$/.test(parsed.protocol)) return { error: 'url_not_http' };
  // B-07 第二道：目标 origin 不在会话白名单时拒绝，连 tabs.update 都不调用。
  if (sw.allowedOrigins.size > 0 && !sw.allowedOrigins.has(parsed.origin.toLowerCase())) {
    return { error: 'origin_not_allowed' };
  }
  // BR-09：显式后台导航（active:false）。Chrome 没有名为 background 的 update 字段，
  // “不抢前台”的等价语义就是不把 active 置真；只有用户“查看操作”才走 activate_tab。
  await chrome.tabs.update(tabId, { url: parsed.href, active: false });
  const final = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve({ error: 'navigate_timeout' });
    }, COMMAND_TIMEOUT_MS);
    function listener(updatedId, info) {
      if (updatedId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        chrome.tabs.get(tabId).then((t) => resolve({ url: t.url, title: t.title })).catch(() => resolve({}));
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
  return final;
}

async function actionClick(payload) {
  const humanize = !!sw.humanInput;
  // frame_id 缺省 = 主 frame（旧行为不变）；带 frame_id 时定向注入（A7）。
  const frameId = Number(payload.frame_id);
  if (Number.isInteger(frameId) && frameId > 0) {
    return executeOnFrame(Number(payload.tab_id), frameId, clickFn, [String(payload.ref), String(payload.doc_rev), humanize]);
  }
  return (await executeOn(Number(payload.tab_id), clickFn, [String(payload.ref), String(payload.doc_rev), humanize])) || { error: 'no_result' };
}

async function actionType(payload) {
  const humanize = !!sw.humanInput;
  const frameId = Number(payload.frame_id);
  if (Number.isInteger(frameId) && frameId > 0) {
    return executeOnFrame(Number(payload.tab_id), frameId, typeFn, [String(payload.ref), String(payload.text ?? ''), String(payload.doc_rev), humanize]);
  }
  return (await executeOn(Number(payload.tab_id), typeFn, [String(payload.ref), String(payload.text ?? ''), String(payload.doc_rev), humanize])) || { error: 'no_result' };
}

async function actionScroll(payload) {
  // B-02A：滚动沿页面中心合成 wheel + 实际 scrollBy；人类化时分帧 easeOutCubic。
  const deltaY = Number(payload.delta_y ?? payload.deltaY ?? 0);
  if (!Number.isFinite(deltaY) || Math.abs(deltaY) > 20000) return { error: 'delta_out_of_range' };
  return (await executeOn(Number(payload.tab_id), scrollFn, [deltaY, String(payload.doc_rev), !!sw.humanInput])) || { error: 'no_result' };
}

async function actionExtract(payload) {
  return (await executeOn(Number(payload.tab_id), extractFn, [String(payload.selector), String(payload.doc_rev)])) || { error: 'no_result' };
}

async function actionScreenshot(payload) {
  const tabId = Number(payload.tab_id);
  const tab = await chrome.tabs.get(tabId);
  // BR-09：captureVisibleTab 只能截“窗口当前活动标签”。目标在后台时如实拒绝，
  // 不为了截图把用户正在看的标签切走；用户点“查看操作”后由 activate_tab 主动切过去。
  const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (!active || active.id !== tabId) return { error: 'tab_not_foreground' };
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 });
  return { data_url: dataUrl };
}

// BR-09：唯一的显式前台动作。只允许用户点击“查看操作”经本机桥调用，
// 服务端 Agent 动作白名单（browserCommandActions）不含 activate_tab。
async function actionActivateTab(payload) {
  const tabId = Number(payload.tab_id);
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:/.test(tab.url)) return { error: 'tab_not_http' };
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return { activated: true, tab_id: tabId };
}

// ---------------------------------------------------------------------------
// B-02B：可信输入通道（chrome.debugger 的 Input 域，固定方法，不接受任意 CDP）
// 默认关闭：需要可选权限 debugger + 桥下发 access_mode.debugger_input。
// 只允许 Input.dispatchMouseEvent / Input.insertText；不开启 Runtime/Console/Debugger 域。
// ---------------------------------------------------------------------------

const DEBUGGER_PROTOCOL_VERSION = '1.3';

async function releaseDebugger(tabId) {
  if (!sw.debuggerTabs.has(tabId)) return;
  sw.debuggerTabs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // tab 已关闭或已自行 detach：不把清理失败上报成动作失败。
  }
}

async function ensureDebugger(tabId) {
  if (!sw.debuggerInput) return { error: 'debugger_disabled' };
  if (!chrome.permissions || !(await chrome.permissions.contains({ permissions: ['debugger'] }))) {
    return { error: 'debugger_permission_missing' };
  }
  if (sw.debuggerTabs.has(tabId)) return { ok: true };
  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
  } catch (err) {
    const text = String((err && err.message) || err).slice(0, 160);
    // 没记录在 sw.debuggerTabs 里却报 already attached：是 DevTools 或其他扩展，明确失败不抢。
    if (/already attached|another debugger|devtools/i.test(text)) return { error: 'debugger_conflict', message: text };
    return { error: 'debugger_attach_failed', message: text };
  }
  sw.debuggerTabs.set(tabId, { attachedAt: Date.now() });
  return { ok: true };
}

async function actionClickAt(payload) {
  const tabId = Number(payload.tab_id);
  const x = Number(payload.x);
  const y = Number(payload.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 10000 || y > 10000) return { error: 'coordinates_invalid' };
  const button = ['left', 'right', 'middle'].includes(payload.button) ? payload.button : 'left';
  const clickCount = Number.isInteger(Number(payload.click_count)) ? Math.min(3, Math.max(1, Number(payload.click_count))) : 1;
  const attached = await ensureDebugger(tabId);
  if (attached.error) return attached;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  const target = { x, y };
  const from = { x: x + (Math.random() * 400 - 200), y: y + (Math.random() * 300 - 150) };
  const dist = Math.hypot(target.x - from.x, target.y - from.y);
  const duration = Math.min(700, (70 + 90 * Math.log2(dist / 40 + 1)) * (0.85 + Math.random() * 0.35));
  let elapsed = 0;
  while (elapsed < duration) {
    const step = 8 + Math.random() * 9;
    elapsed = Math.min(duration, elapsed + step);
    const s = (elapsed / duration) ** 3 * (10 - 15 * (elapsed / duration) + 6 * (elapsed / duration) ** 2);
    const px = from.x + (target.x - from.x) * s;
    const py = from.y + (target.y - from.y) * s;
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none' });
    await sleep(step);
  }
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await sleep(45 + Math.random() * 85);
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount });
  await sleep(60 + Math.random() * 80);
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });
  return { clicked: true, trusted: true, tab_id: tabId, x, y };
}

async function actionTypeAt(payload) {
  const tabId = Number(payload.tab_id);
  const text = String(payload.text ?? '').slice(0, 500);
  if (!text) return { error: 'text_required' };
  const attached = await ensureDebugger(tabId);
  if (attached.error) return attached;
  await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text });
  return { typed: text.length, trusted: true, tab_id: tabId };
}

async function actionScrollAt(payload) {
  const tabId = Number(payload.tab_id);
  const x = Number(payload.x);
  const y = Number(payload.y);
  const deltaY = Number(payload.delta_y ?? 0);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 10000 || y > 10000) return { error: 'coordinates_invalid' };
  if (!Number.isFinite(deltaY) || Math.abs(deltaY) > 20000) return { error: 'delta_out_of_range' };
  const attached = await ensureDebugger(tabId);
  if (attached.error) return attached;
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel', x, y, deltaX: 0, deltaY, button: 'none',
  });
  return { scrolled: deltaY, trusted: true, tab_id: tabId };
}

// ---------------------------------------------------------------------------
// B-01：人工接管（page_status 下发 / handoff_complete 上行）
// 注入范围只限 agent 正在使用的 tab；卡片脚本 page-status.js 自身闭包在 closed
// shadow root 内，只有 isTrusted 点击能触发完成。
// ---------------------------------------------------------------------------

const PAGE_STATES = new Set(['attached', 'running', 'waiting', 'recording']);
// B-07：只读采集会话（扩展侧第二道校验）。activate_tab 仅前台展示，不改页面。
const READ_ONLY_ACTIONS = new Set(['tabs_list', 'observe', 'observe_frames', 'extract', 'screenshot', 'activate_tab', 'scroll']);

async function persistPageStatus() {
  await chrome.storage.local.set({
    agent_tabs: Array.from(sw.agentTabs),
    page_status: Array.from(sw.pageStatus.entries()),
  });
}

function badgeForPageState(state) {
  if (state === 'waiting') return ['WAIT', '#f59e0b'];
  if (state === 'running') return ['RUN', '#2563eb'];
  if (state === 'recording') return ['REC', '#dc2626'];
  return ['ON', '#16a34a'];
}

async function injectPageStatus(tabId) {
  if (sw.pageStatusInjected.has(tabId)) return true;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['page-status.js'],
      injectImmediately: true,
      world: 'ISOLATED',
    });
    sw.pageStatusInjected.add(tabId);
    return true;
  } catch (err) {
    // about:/chrome://、页面尚未 ready 等注入失败：保留待注入标记，等 tabs.onUpdated complete 重试。
    await chrome.storage.local.set({ last_error: `${new Date().toISOString()} page_status_inject:${tabId}: ${(err && err.message) || err}` });
    return false;
  }
}

async function sendPageStatus(tabId, state) {
  const injected = await injectPageStatus(tabId);
  if (!injected) return false;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ops:page-status', state });
    return true;
  } catch (err) {
    // 注入与消息监听之间存在竞态：清掉已注入标记，重注入后再发一次。
    sw.pageStatusInjected.delete(tabId);
    if (!(await injectPageStatus(tabId))) return false;
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'ops:page-status', state });
      return true;
    } catch {
      return false;
    }
  }
}

async function showHandoffNotification(record) {
  try {
    await chrome.notifications.create(`ops-handoff-${record.tabId}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon-128.png'),
      title: 'OPS 需要你完成一步操作',
      message: `${record.origin || '当前页面'} ${record.message || '请完成验证后返回'}`.slice(0, 220),
      priority: 2,
      requireInteraction: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function handlePageStatusPayload(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'payload_required' };
  // B-07：访问模式与卡片无关，先处理；mode 信封不要求 tab_id。
  if (payload.op === 'mode') {
    sw.readOnly = Boolean(payload.read_only);
    sw.allowedOrigins = new Set((Array.isArray(payload.allowed_origins) ? payload.allowed_origins : []).map(normalizeOrigin).filter(Boolean));
    sw.humanInput = Boolean(payload.human_input);
    sw.debuggerInput = Boolean(payload.debugger_input);
    await chrome.storage.local.set({
      access_mode: { read_only: sw.readOnly, allowed_origins: Array.from(sw.allowedOrigins), human_input: sw.humanInput, debugger_input: sw.debuggerInput },
    });
    return { ok: true, read_only: sw.readOnly, allowed_origins: Array.from(sw.allowedOrigins), human_input: sw.humanInput, debugger_input: sw.debuggerInput };
  }
  const tabId = Number(payload.tab_id);
  if (!Number.isInteger(tabId) || tabId <= 0) return { ok: false, error: 'tab_id_required' };
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !/^https?:/i.test(tab.url || '')) return { ok: false, error: 'tab_not_http' };
  if (payload.op === 'clear') {
    sw.agentTabs.delete(tabId);
    sw.pageStatus.delete(String(tabId));
    await sendPageStatus(tabId, { state: 'clear' });
    setBadge('ON', '#16a34a');
    await persistPageStatus();
    return { ok: true, cleared: true };
  }
  const state = payload.state && typeof payload.state === 'object' ? payload.state : payload;
  const stateName = String(state.state || '');
  if (!PAGE_STATES.has(stateName)) return { ok: false, error: 'state_not_allowed' };
  const handoffId = typeof state.handoffId === 'string' ? state.handoffId.slice(0, 64) : '';
  if (stateName === 'waiting' && !handoffId) return { ok: false, error: 'handoff_id_required' };
  const record = {
    state: stateName,
    handoffId,
    message: typeof state.message === 'string' ? state.message.slice(0, 200) : '',
    tabId,
    origin: parseHost(tab.url || ''),
    updated_at: Date.now(),
  };
  sw.agentTabs.add(tabId);
  sw.pageStatus.set(String(tabId), record);
  const badge = badgeForPageState(stateName);
  setBadge(badge[0], badge[1]);
  if (stateName === 'recording') {
    // 录屏 tab 不画卡片：出系统通知并聚焦该 tab；通知失败且有人工接管请求时回退卡片
    //（“视频里多一张卡片”好过 agent 干等到超时）。
    const notified = await showHandoffNotification(record);
    if (notified) {
      try { await chrome.tabs.sendMessage(tabId, { type: 'ops:page-status', state: { state: 'clear' } }); } catch { /* 无卡片时忽略 */ }
    } else if (handoffId) {
      record.state = 'waiting';
      record.fallback = 'notification_failed';
      await sendPageStatus(tabId, record);
    } else {
      await persistPageStatus();
      return { ok: false, error: 'notification_failed' };
    }
    await persistPageStatus();
    return { ok: true, state: record.state, tab_id: tabId, handoff_id: handoffId, notified };
  }
  await sendPageStatus(tabId, record);
  await persistPageStatus();
  return { ok: true, state: stateName, tab_id: tabId, handoff_id: handoffId };
}

async function actionHandoffRequest(payload) {
  const tabId = Number(payload.tab_id);
  if (!Number.isInteger(tabId) || tabId <= 0) return { error: 'tab_id_required' };
  const handoffId = String(payload.handoff_id || payload.handoffId || '').slice(0, 64) || `h${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const applied = await handlePageStatusPayload({
    op: 'set',
    tab_id: tabId,
    state: {
      state: 'waiting',
      handoffId,
      message: typeof payload.message === 'string' ? payload.message : '',
    },
  });
  if (!applied.ok) return { error: applied.error };
  return { waiting: true, handoff_id: handoffId, tab_id: tabId };
}

async function onPageStatusReady(senderTab) {
  const tabId = senderTab && Number(senderTab.id);
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  const record = sw.pageStatus.get(String(tabId));
  if (!record) return;
  await sendPageStatus(tabId, record);
}

async function onHandoffComplete(message, sender) {
  const tabId = sender && sender.tab ? Number(sender.tab.id) : NaN;
  const claimedTabId = Number(message.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0 || claimedTabId !== tabId) return { ok: false, error: 'tab_mismatch' };
  const handoffId = typeof message.handoffId === 'string' ? message.handoffId.slice(0, 64) : '';
  const record = sw.pageStatus.get(String(tabId));
  if (!handoffId || !record || record.state !== 'waiting' || record.handoffId !== handoffId) {
    return { ok: false, error: 'handoff_not_pending' };
  }
  if (sw.completedHandoffs.has(handoffId)) return { ok: true, duplicate: true };
  sw.completedHandoffs.add(handoffId);
  if (sw.completedHandoffs.size > 100) sw.completedHandoffs.delete(sw.completedHandoffs.values().next().value);
  const sent = sendToHost({
    v: PROTOCOL_VERSION,
    type: 'handoff_complete',
    payload: {
      handoff_id: handoffId,
      tab_id: tabId,
      origin: parseHost(sender.tab.url || ''),
      completed_at: Date.now(),
    },
  });
  if (!sent) {
    sw.completedHandoffs.delete(handoffId);
    return { ok: false, error: 'host_not_connected' };
  }
  const next = { ...record, state: 'running', handoffId: '', updated_at: Date.now() };
  sw.pageStatus.set(String(tabId), next);
  setBadge('RUN', '#2563eb');
  await sendPageStatus(tabId, next);
  await persistPageStatus();
  return { ok: true, accepted: true };
}

// 扩展启动即注册：page-status.js 首次注入会主动请求当前状态；人工完成点击上行到宿主。
if (typeof chrome !== 'undefined' && chrome && chrome.runtime) chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  if (msg.type === 'page_status_ready') {
    void onPageStatusReady(sender.tab).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'handoff_complete') {
    void onHandoffComplete(msg, sender).then((result) => sendResponse(result)).catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err).slice(0, 120) }));
    return true;
  }
  return false;
});

// 导航 loading/complete 时重新注入（页面 DOM 已被替换，旧卡片自然消失）。
if (typeof chrome !== 'undefined' && chrome && chrome.tabs) chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!sw.agentTabs.has(tabId)) return;
  if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete') return;
  sw.pageStatusInjected.delete(tabId);
  void injectPageStatus(tabId).then((ok) => {
    if (!ok) return;
    const record = sw.pageStatus.get(String(tabId));
    if (record) void sendPageStatus(tabId, record);
  });
});

if (typeof chrome !== 'undefined' && chrome && chrome.tabs) chrome.tabs.onRemoved.addListener((tabId) => {
  if (!sw.agentTabs.has(tabId) && !sw.pageStatus.has(String(tabId))) return;
  void releaseDebugger(tabId);
  sw.agentTabs.delete(tabId);
  sw.pageStatus.delete(String(tabId));
  sw.pageStatusInjected.delete(tabId);
  void persistPageStatus();
});

// 录屏冲突：通知点击聚焦对应 tab（不代替平台页面完成判定）。
if (typeof chrome !== 'undefined' && chrome && chrome.notifications) chrome.notifications.onClicked.addListener((notificationId) => {
  const tabId = Number(String(notificationId).replace('ops-handoff-', ''));
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  void chrome.tabs.get(tabId).then((tab) => {
    if (!tab) return;
    void chrome.tabs.update(tabId, { active: true });
    if (Number.isInteger(tab.windowId)) void chrome.windows.update(tab.windowId, { focused: true });
  }).catch(() => {});
});

const ACTIONS = {
  tabs_list: actionTabsList,
  observe: actionObserve,
  observe_frames: actionObserveFrames,
  navigate: actionNavigate,
  click: actionClick,
  type: actionType,
  scroll: actionScroll,
  // B-02B：可信输入（仅 Input 域，需可选权限 + 开关）
  click_at: actionClickAt,
  type_at: actionTypeAt,
  scroll_at: actionScrollAt,
  extract: actionExtract,
  screenshot: actionScreenshot,
  handoff_request: actionHandoffRequest,
  // BR-09：仅本机用户“查看操作”使用；Agent 服务端动作白名单不登记该动作。
  activate_tab: actionActivateTab,
};

function bytesToHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

// 与桥端 sha256(JSON.stringify(payload)) 完全一致（27 §13.5 payload_hash 完整性）。
function payloadHashHex(payload) {
  return bytesToHex(sha256Raw(strToBytes(JSON.stringify(payload ?? null))));
}

async function handleCommand(msg) {
  const started = Date.now();
  if (typeof msg.request_id !== 'string' || !msg.request_id) {
    return { ok: false, error_code: 'request_id_required' };
  }
  if (typeof msg.deadline_at === 'number' && Date.now() > msg.deadline_at + 2000) {
    return { ok: false, error_code: 'deadline_exceeded' };
  }
  if (typeof msg.generation !== 'number') {
    return { ok: false, error_code: 'generation_required' };
  }
  const gen = await chrome.storage.local.get('generation');
  if (Number(msg.generation) < Number(gen.generation || 0)) {
    return { ok: false, error_code: 'stale_generation' };
  }
  if (typeof msg.nonce !== 'string' || !msg.nonce) {
    return { ok: false, error_code: 'nonce_required' };
  }
  if (typeof msg.payload_hash === 'string' && msg.payload_hash !== payloadHashHex(msg.payload)) {
    // 载荷与派发时不一致：拒绝执行，不猜意图。
    return { ok: false, error_code: 'payload_hash_mismatch' };
  }
  // B-07：扩展侧第二道只读校验——桥侧拒绝之外，即使信封直接到达也不执行写动作。
  if (sw.readOnly && !READ_ONLY_ACTIONS.has(msg.action)) {
    return { ok: false, error_code: 'read_only', message: `read-only session rejects ${msg.action}` };
  }
  const fn = ACTIONS[msg.action];
  if (!fn) {
    return { ok: false, error_code: 'action_not_registered' };
  }
  try {
    const payload = await fn(msg.payload || {});
    const took = Date.now() - started;
    const record = [{ request_id: msg.request_id, action: msg.action, ok: !payload.error, at: started, took }];
    const d = await chrome.storage.local.get('last_commands');
    const list = (d.last_commands || []).concat(record).slice(-20);
    await chrome.storage.local.set({ last_commands: list });
    if (payload && payload.error) {
      return { ok: false, error_code: payload.error, took };
    }
    return { ok: true, payload, took };
  } catch (err) {
    return { ok: false, error_code: 'action_failed', message: String(err && err.message).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Native Messaging 连接与消息路由
// ---------------------------------------------------------------------------

function sendToHost(msg) {
  if (!sw.port) return false;
  try {
    sw.port.postMessage(sign(msg));
    return true;
  } catch {
    return false;
  }
}

async function onHostMessage(msg) {
  try {
    await handleHostMessage(msg);
  } catch (err) {
    // W02 诊断：SW 内异常落盘，避免被 void 吞掉不可见。
    await chrome.storage.local.set({ last_error: `${new Date().toISOString()} ${msg && msg.type}: ${(err && err.stack) || err}` });
  }
}

async function handleHostMessage(msg) {
  const err = await validateInbound(msg);
  if (err) {
    await chrome.storage.local.set({ last_error: `${new Date().toISOString()} reject ${msg && msg.type}: ${err}` });
    sendToHost({ v: PROTOCOL_VERSION, type: 'error', payload: { reason: err } });
    return;
  }
  if (msg.type === 'pairing_start') {
    await setUiState({
      pairing_code: msg.payload && msg.payload.code,
      pairing_expires_at: msg.payload && msg.payload.expires_at,
      paired: false,
    });
    setBadge('PAIR', '#a855f7');
    return;
  }
  if (msg.type === 'pairing_confirm' || msg.type === 'pairing_confirmed') {
    if (msg.payload && msg.payload.session_key) {
      sw.sessionKey = String(msg.payload.session_key);
      // A14-6：版本由宿主按「桥下发 ∩ 自身能力」改写；缺 salt 时强制退回 v1。
      const want = Number(msg.payload.crypto_version) === CRYPTO_VERSION_V2 ? CRYPTO_VERSION_V2 : CRYPTO_VERSION_V1;
      sw.hkdfSalt = typeof msg.payload.hkdf_salt === 'string' ? msg.payload.hkdf_salt : null;
      sw.cryptoVersion = want === CRYPTO_VERSION_V2 && sw.hkdfSalt ? CRYPTO_VERSION_V2 : CRYPTO_VERSION_V1;
      sw.messageKey = sw.cryptoVersion === CRYPTO_VERSION_V2 ? deriveMessageKeyBytes(sw.sessionKey, sw.hkdfSalt) : null;
      sw.paired = true;
      sw.seqOut = 0;
      sw.lastSeqIn = 0;
      // 重新配对=新会话：代数归零（revoke 的代数仅在同一配对会话内递增）。
      await chrome.storage.local.set({
        session_key: sw.sessionKey,
        paired: true,
        seq_out: 0,
        last_seq_in: 0,
        generation: 0,
        crypto_version: sw.cryptoVersion,
        hkdf_salt: sw.hkdfSalt,
      });
      setUiState({ pairing_code: null, pairing_expires_at: null });
      setBadge('ON', '#16a34a');
    }
    return;
  }
  if (msg.type === 'revoke') {
    sw.sessionKey = null;
    sw.cryptoVersion = CRYPTO_VERSION_V1;
    sw.hkdfSalt = null;
    sw.messageKey = null;
    sw.paired = false;
    for (const tabId of Array.from(sw.debuggerTabs.keys())) void releaseDebugger(tabId);
    for (const tabId of sw.agentTabs) void sendPageStatus(tabId, { state: 'clear' });
    sw.agentTabs.clear();
    sw.pageStatus.clear();
    sw.pageStatusInjected.clear();
    await chrome.storage.local.set({ session_key: null, paired: false, pairing_code: null, crypto_version: CRYPTO_VERSION_V1, hkdf_salt: null, agent_tabs: [], page_status: [] });
    setBadge('OFF', '#6b7280');
    return;
  }
  if (msg.type === 'page_status') {
    const result = await handlePageStatusPayload(msg.payload || {});
    if (!result.ok) {
      await chrome.storage.local.set({ last_error: `${new Date().toISOString()} page_status reject: ${result.error}` });
    }
    return;
  }
  if (msg.type === 'command') {
    const result = await handleCommand(msg);
    // 回执原样带回 nonce/payload_hash，桥端据此绑定到同一次派发（27 §13.5）。
    sendToHost({
      v: PROTOCOL_VERSION,
      type: 'result',
      request_id: msg.request_id,
      nonce: msg.nonce,
      payload_hash: msg.payload_hash,
      payload: result,
    });
  }
}

function connectHost() {
  if (sw.reconnectTimer) {
    clearTimeout(sw.reconnectTimer);
    sw.reconnectTimer = null;
  }
  let port;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (err) {
    setUiState({ host_state: `connect_failed:${err && err.message}` });
    setBadge('X', '#dc2626');
    sw.reconnectTimer = setTimeout(connectHost, sw.reconnectDelay);
    sw.reconnectDelay = Math.min(sw.reconnectDelay * 2, 8000);
    return;
  }
  sw.port = port;
  sw.reconnectDelay = 1000;
  setUiState({ host_state: 'connected' });
  port.onMessage.addListener((msg) => {
    void onHostMessage(msg);
  });
  port.onDisconnect.addListener(() => {
    const last = chrome.runtime.lastError;
    sw.port = null;
    setUiState({ host_state: `disconnected${last && last.message ? `:${last.message}` : ''}` });
    setBadge('OFF', '#6b7280');
    sw.reconnectTimer = setTimeout(connectHost, sw.reconnectDelay);
    sw.reconnectDelay = Math.min(sw.reconnectDelay * 2, 8000);
  });
  sendToHost({
    v: PROTOCOL_VERSION,
    type: 'hello',
    payload: {
      extension_instance_id: sw.extensionInstanceId,
      protocol_version: PROTOCOL_VERSION,
      // A14-6：声明信封加密能力；宿主按交集决定扩展段版本。
      crypto_versions: SUPPORTED_CRYPTO_VERSIONS,
    },
  });
}

// Node 侧交叉校验入口（desktop/test/browser-bridge.test.cjs）：无 chrome 运行时不启动 SW。
// 仅用于验证加密原语与桥/宿主逐字节一致，不改变扩展在浏览器里的行为。
const HAS_CHROME = typeof chrome !== 'undefined' && Boolean(chrome && chrome.runtime);

if (HAS_CHROME) chrome.runtime.onInstalled.addListener(() => {
  void loadState().then(() => {
    setBadge(sw.paired ? 'ON' : 'OFF', sw.paired ? '#16a34a' : '#6b7280');
  });
});

if (HAS_CHROME && !sw.started) {
  sw.started = true;
  void loadState().then((d) => {
    sw.extensionInstanceId = d.extension_instance_id;
    setBadge(sw.paired ? 'ON' : 'OFF', sw.paired ? '#16a34a' : '#6b7280');
    connectHost();
  });
}

// ---------------------------------------------------------------------------
// DEV-AI27-10（W10）：side panel 消息路由（27 §10.2）。
// sidepanel_input：用户草稿经 OPS 桥转发（真实受理在 OPS 原会话；侧栏无双执行入口）。
// sidepanel_stop：与主界面停止同语义（收紧当前 run）。
// sidepanel_open_ops：聚焦 OPS 桌面（深链由 OPS 端处理；扩展不唤起网页脚本）。
// ---------------------------------------------------------------------------

if (HAS_CHROME) chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  if (msg.type === 'sidepanel_input') {
    // 转发到宿主（OPS 桥）；实际受理结果由 OPS 端返回。W10 简化：草稿入桥，OPS 侧展示。
    const accepted = Boolean(sw.paired);
    if (accepted) {
      sendToHost({ v: PROTOCOL_VERSION, type: 'ping', payload: { sidepanel: 'draft', text: String(msg.text || '').slice(0, 2000) } });
    }
    sendResponse({ accepted, reason: accepted ? undefined : 'not_paired' });
    return false;
  }
  if (msg.type === 'sidepanel_stop') {
    // 停止任务：发 revoke（27 §10.2 与主界面停止同语义；不发独立取消信号）。
    const accepted = Boolean(sw.paired);
    if (accepted) {
      sendToHost({ v: PROTOCOL_VERSION, type: 'ping', payload: { sidepanel: 'stop' } });
    }
    sendResponse({ accepted, reason: accepted ? undefined : 'not_paired' });
    return false;
  }
  if (msg.type === 'sidepanel_open_ops') {
    // OPS 桌面深链：通过 native host 提示 OPS 端聚焦（宿主→OPS 桥已有通道）。
    const accepted = Boolean(sw.paired);
    if (accepted) {
      sendToHost({ v: PROTOCOL_VERSION, type: 'ping', payload: { sidepanel: 'focus_ops' } });
    }
    sendResponse({ accepted });
    return false;
  }
  return false;
});

// A14-6：加密原语的交叉校验出口（仅 Node 测试 require 时生效；扩展运行时 module 未定义）。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    deriveMessageKeyBytes,
    hkdfInfo: HKDF_INFO,
    supportedCryptoVersions: SUPPORTED_CRYPTO_VERSIONS,
    hmacSha256Base64Bytes,
  };
}
