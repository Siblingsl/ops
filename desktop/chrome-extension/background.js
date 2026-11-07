'use strict';
// DEV-AI27-02 W02 技术验证：OPS Browser Bridge 扩展 service worker。
// 只执行本文件动作登记表内的动作（chrome.scripting.executeScript 传包内函数引用），
// 不接收任意 JS / CDP 方法 / 远程逻辑；全部状态持久化到 chrome.storage，覆盖 worker 休眠重启。

const HOST_NAME = 'com.ops.desktop.bridge';
const PROTOCOL_VERSION = 1;
const MAX_NODES = 300;
const COMMAND_TIMEOUT_MS = 30_000;

const sw = {
  port: null,
  sessionKey: null,
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

function hmacSignMessage(seq, type, payload) {
  // sw.sessionKey 是 base64 字符串；HMAC key 统一为解码后的原始字节（与宿主/桥一致）。
  const bin = atob(sw.sessionKey);
  const keyBytes = [];
  for (let i = 0; i < bin.length; i += 1) keyBytes.push(bin.charCodeAt(i));
  return hmacSha256Base64Bytes(keyBytes, `${seq}.${type}.${JSON.stringify(payload ?? null)}`);
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
  const d = await chrome.storage.local.get(['session_key', 'seq_out', 'last_seq_in', 'paired', 'pairing_code', 'pairing_expires_at', 'extension_instance_id', 'last_commands']);
  sw.sessionKey = d.session_key || null;
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
    msg.hmac = hmacSignMessage(sw.seqOut, msg.type, msg.payload);
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
    sw.paired = false;
    await chrome.storage.local.set({ session_key: null, paired: false });
  }
  if (sw.sessionKey && msg.type !== 'pairing_start' && msg.type !== 'hello') {
    if (typeof msg.seq !== 'number' || typeof msg.hmac !== 'string') return 'missing seq/hmac';
    const expect = hmacSignMessage(msg.seq, msg.type, msg.payload);
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
  return (await executeOn(Number(payload.tab_id), clickFn, [String(payload.ref), String(payload.doc_rev)])) || { error: 'no_result' };
}

async function actionType(payload) {
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
  navigate: actionNavigate,
  click: actionClick,
  type: actionType,
  extract: actionExtract,
  screenshot: actionScreenshot,
};

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
      sw.paired = true;
      sw.seqOut = 0;
      sw.lastSeqIn = 0;
      await chrome.storage.local.set({ session_key: sw.sessionKey, paired: true, seq_out: 0, last_seq_in: 0 });
      setUiState({ pairing_code: null, pairing_expires_at: null });
      setBadge('ON', '#16a34a');
    }
    return;
  }
  if (msg.type === 'revoke') {
    sw.sessionKey = null;
    sw.paired = false;
    await chrome.storage.local.set({ session_key: null, paired: false, pairing_code: null });
    setBadge('OFF', '#6b7280');
    return;
  }
  if (msg.type === 'command') {
    const result = await handleCommand(msg);
    sendToHost({
      v: PROTOCOL_VERSION,
      type: 'result',
      request_id: msg.request_id,
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
    payload: { extension_instance_id: sw.extensionInstanceId, protocol_version: PROTOCOL_VERSION },
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void loadState().then(() => {
    setBadge(sw.paired ? 'ON' : 'OFF', sw.paired ? '#16a34a' : '#6b7280');
  });
});

if (!sw.started) {
  sw.started = true;
  void loadState().then((d) => {
    sw.extensionInstanceId = d.extension_instance_id;
    setBadge(sw.paired ? 'ON' : 'OFF', sw.paired ? '#16a34a' : '#6b7280');
    connectHost();
  });
}
