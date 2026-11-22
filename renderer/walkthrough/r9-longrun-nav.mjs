// R9-1 前置补跑：确认会话有效并导航到主页。
import http from 'node:http';

const list = await new Promise((res, rej) => {
  http.get('http://127.0.0.1:9223/json/list', (r) => {
    let d = '';
    r.on('data', (c) => (d += c));
    r.on('end', () => res(JSON.parse(d)));
  }).on('error', rej);
});
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((r) => {
  const mid = ++id;
  pending.set(mid, r);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const evalJs = async (expression, awaitPromise = false) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  return res.result?.result?.value;
};
console.log('me check:', await evalJs(
  "fetch('/api/v1/auth/me').then(r=>String(r.status)).catch(e=>'ERR '+e)", true));
console.log('url:', await evalJs('location.href'));
await evalJs("location.assign('/#/')");
await new Promise((r) => setTimeout(r, 3500));
console.log('after nav:', await evalJs('location.href'));
console.log('title:', await evalJs('document.title'));
ws.close();
