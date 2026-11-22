// R9-4 T3 隔离：31 天软删素材在 trash 列表的展示（days_left 边界）
import { spawnSync } from 'node:child_process';

function psql(sql) {
  const r = spawnSync('docker', ['exec', '-i', 'ops-dev-postgres-1', 'psql', '-U', 'ops', '-d', 'ops_e2e', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], { input: sql + '\n', encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}
function cookieOf(r) { const c = (r.headers?.getSetCookie?.() ?? [])[0]; return c ? c.split(';')[0] : null; }
async function req(method, path, { body, rawCookie, csrfHeader } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (csrfHeader) h['X-CSRF-Token'] = csrfHeader;
  if (rawCookie) h['Cookie'] = rawCookie;
  const res = await fetch('http://127.0.0.1:8388/api/v1' + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await res.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, headers: res.headers };
}

let r = await req('POST', '/auth/register', { body: { username: 'r9t3' + Math.random().toString(36).slice(2, 9), password: '{{SECRET_s2wbnk4v}}' } });
const o = { cookie: cookieOf(r) };
r = await req('GET', '/auth/me', { rawCookie: o.cookie });
const csrf = r.json?.csrf_token ?? null;
console.log('csrf from me:', csrf ? 'yes' : JSON.stringify(r.json).slice(0, 120));
r = await req('POST', '/materials', { body: { content: 'R9 T3 素材内容，用于验证 31 天边界展示。', kind: 'experience' }, rawCookie: o.cookie, csrfHeader: csrf });
const mat = r.json?.id;
console.log('mat:', mat);
await req('DELETE', `/materials/${mat}`, { rawCookie: o.cookie, csrfHeader: csrf });
psql(`UPDATE material SET deleted_at=now() - interval '31 days' WHERE id='${mat}';`);
r = await req('GET', '/trash?type=material', { rawCookie: o.cookie, csrfHeader: csrf });
console.log('T3 raw:', r.status, JSON.stringify(r.json).slice(0, 400));
console.log('DB row:', psql(`SELECT deleted_at FROM material WHERE id='${mat}';`));
process.exit(0);
