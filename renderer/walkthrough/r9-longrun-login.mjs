// R9-1 前置：通过 CDP 连 Electron 窗口，完成登录（长跑需要已登录会话驱动真实业务轮询）。
// 用页面自身 fetch 走 login 接口（同源 vite 代理 → 8388），cookie 落在业务 session。
import http from 'node:http';

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9223/json/list', (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve(JSON.parse(raw)));
    }).on('error', reject);
  });
}

const targets = await getTargets();
const page = targets.find((t) => t.type === 'page' && (t.url.startsWith('http://localhost:5174') || t.url.startsWith('ops-desktop://')));
if (!page) {
  console.log('no page target', targets.map((t) => `${t.type}:${t.url.slice(0, 60)}`));
  process.exit(1);
}
console.log('page:', page.url.slice(0, 80));

// 简易 WS 客户端（无依赖）：用 Node 内置 WebSocket（Node 22+ 全局可用）。
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
function send(method, params = {}) {
  return new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

await send('Runtime.enable');
const expr = `fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({username:'r9longrun',password:'{{SECRET_s2wbnk4v}}'})}).then(r=>r.json()).then(j=>JSON.stringify(j))`;
const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
console.log('login:', res.result?.result?.value);
const who = await send('Runtime.evaluate', {
  expression: `fetch('/api/v1/auth/me').then(r=>r.json()).then(j=>JSON.stringify({user:j.username||j.user?.username, ws:j.workspace?.name||j.workspace_id}))`,
  awaitPromise: true, returnByValue: true,
});
console.log('me:', who.result?.result?.value);
// 登录后刷新一次让前端拿到会话
await send('Runtime.evaluate', { expression: `location.reload()` });
await new Promise((r) => setTimeout(r, 4000));
const state = await send('Runtime.evaluate', { expression: `document.title + ' | ' + location.href.slice(0,60)` , returnByValue: true });
console.log('state:', state.result?.result?.value);
ws.close();
console.log('R9-1 login done');
