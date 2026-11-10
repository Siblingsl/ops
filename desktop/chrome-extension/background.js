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

async function loadState() {
  const d = await chrome.storage.local.get(['session_key', 'seq_out', 'last_seq_in', 'paired', 'pairing_code', 'pairing_expires_at', 'extension_instance_id', 'last_commands', 'crypto_version', 'hkdf_salt']);
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
  let instanceId = d.extension_instance_id;
  if (!instanceId) {
    instanceId = crypto.randomUUID();
    await chrome.storage.local.set({ extension_instance_id: instanceId });
  }
  return d;
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
  const allowed = ['pairing_start', 'pairing_confirm', 'pairing_confirmed', 'command', 'revoke', 'ping', 'pong', 'error'];
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

function clickFn(ref, docRev) {
  if (window.__opsDocRev !== docRev) return { error: 'doc_rev_changed' };
  const el = window.__opsRefMap && window.__opsRefMap.get(ref);
  if (!el) return { error: 'ref_not_found' };
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return { error: 'ref_not_visible' };
  if (el.matches('input[type="password"]')) return { error: 'sensitive_control' };
  el.click();
  return { clicked: true, tag: el.tagName.toLowerCase(), name: (el.textContent || '').trim().slice(0, 60) };
}

function typeFn(ref, text, docRev) {
  if (window.__opsDocRev !== docRev) return { error: 'doc_rev_changed' };
  const el = window.__opsRefMap && window.__opsRefMap.get(ref);
  if (!el) return { error: 'ref_not_found' };
  const tag = el.tagName.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea') return { error: 'not_text_control' };
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (type === 'password' || type === 'file') return { error: 'sensitive_control' };
  el.focus();
  el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { typed: text.length, tag };
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

async function actionTabsList() {
  const tabs = await chrome.tabs.query({});
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
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: fn, args });
  return res && res.result;
}

// frame 级注入（A7，27 §14.3 表格行 2）：observe_frames 上报的 frame_id 定向执行。
// 跨域 frame 由 Chrome 按 origin 隔离——未经 host_permissions 授权的 origin 注入直接拒绝；
// frameIds 里的 frame 不存在（导航后失效）时 executeScript 抛错，这里转成显式 error。
async function executeOnFrame(tabId, frameId, fn, args) {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: fn, args });
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
  await chrome.tabs.update(tabId, { url: parsed.href });
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
  // frame_id 缺省 = 主 frame（旧行为不变）；带 frame_id 时定向注入（A7）。
  const frameId = Number(payload.frame_id);
  if (Number.isInteger(frameId) && frameId > 0) {
    return executeOnFrame(Number(payload.tab_id), frameId, clickFn, [String(payload.ref), String(payload.doc_rev)]);
  }
  return (await executeOn(Number(payload.tab_id), clickFn, [String(payload.ref), String(payload.doc_rev)])) || { error: 'no_result' };
}

async function actionType(payload) {
  const frameId = Number(payload.frame_id);
  if (Number.isInteger(frameId) && frameId > 0) {
    return executeOnFrame(Number(payload.tab_id), frameId, typeFn, [String(payload.ref), String(payload.text ?? ''), String(payload.doc_rev)]);
  }
  return (await executeOn(Number(payload.tab_id), typeFn, [String(payload.ref), String(payload.text ?? ''), String(payload.doc_rev)])) || { error: 'no_result' };
}

async function actionExtract(payload) {
  return (await executeOn(Number(payload.tab_id), extractFn, [String(payload.selector), String(payload.doc_rev)])) || { error: 'no_result' };
}

async function actionScreenshot(payload) {
  const tab = await chrome.tabs.get(Number(payload.tab_id));
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 });
  return { data_url: dataUrl };
}

const ACTIONS = {
  tabs_list: actionTabsList,
  observe: actionObserve,
  observe_frames: actionObserveFrames,
  navigate: actionNavigate,
  click: actionClick,
  type: actionType,
  extract: actionExtract,
  screenshot: actionScreenshot,
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
    await chrome.storage.local.set({ session_key: null, paired: false, pairing_code: null, crypto_version: CRYPTO_VERSION_V1, hkdf_salt: null });
    setBadge('OFF', '#6b7280');
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
