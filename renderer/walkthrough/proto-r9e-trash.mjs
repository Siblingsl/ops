// R9-4：回收站 30 天过期清理（PurgeExpiredTrash）——时间前移验证。
// 方法（如实登记）：不改系统时钟、不覆盖 srv.now（独立进程无法注入）。
// 37 天前软删一个素材 → PurgeExpiredTrash 由 POST /__e2e 不可用（ops-e2e 无该触发路由），
// 改为直接调用该函数的等价 SQL 语义验证：
//   T1: 软删素材 deleted_at=now()-37d → 列表 days_left=0，仍在回收站
//   T2: 手动执行 PurgeExpiredTrash 的删除主语句（与 jobs.go:167-192 同语义：deleted_at < now()-30d 硬删 + audit）
//       —— 注意：为了不偏离"真实代码路径"，改用 Go 单测方式触发真实函数。
// 折衷：真实 PurgeExpiredTrash 通过 go test 内嵌触发（见 r9_trash_test.go），本探针只做 API 侧观察（days_left 展示）。
const BASE = 'http://127.0.0.1:8388/api/v1';
import { spawnSync } from 'node:child_process';

function psql(sql) {
  const r = spawnSync('docker', ['exec', '-i', 'ops-dev-postgres-1', 'psql', '-U', 'ops', '-d', 'ops_e2e', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], {
    input: sql + '\n', encoding: 'utf8', timeout: 30000,
  });
  if (r.status !== 0) throw new Error('psql failed: ' + (r.stderr || r.stdout));
  return r.stdout.trim();
}
function cookieOf(r) { const c = (r.headers?.getSetCookie?.() ?? [])[0]; return c ? c.split(';')[0] : null; }
async function req(method, path, { body, rawCookie, csrfHeader } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (csrfHeader) h['X-CSRF-Token'] = csrfHeader;
  if (rawCookie) h['Cookie'] = rawCookie;
  const res = await fetch(BASE + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text.slice(0, 120) }; }
  return { status: res.status, json, headers: res.headers };
}

let r = await req('POST', '/auth/register', { body: { username: 'r9trash' + Math.random().toString(36).slice(2, 9), password: '{{SECRET_s2wbnk4v}}' } });
const o = { cookie: cookieOf(r) };
r = await req('GET', '/auth/me', { rawCookie: o.cookie });
o.csrf = r.json?.csrf_token ?? null;

// 建素材并软删（API 真实路径）
r = await req('POST', '/materials', { body: { content: 'R9 回收站过期测试素材内容，足够长以通过校验。', kind: 'experience' }, rawCookie: o.cookie, csrfHeader: o.csrf });
const mat = r.json?.id;
console.log('material:', r.status, mat);
r = await req('DELETE', `/materials/${mat}`, { rawCookie: o.cookie, csrfHeader: o.csrf });
console.log('delete:', r.status);

// T1: 29 天前（未到期）→ days_left=1
psql(`UPDATE material SET deleted_at=now() - interval '29 days' WHERE id='${mat}';`);
r = await req('GET', '/trash?type=material', { rawCookie: o.cookie, csrfHeader: o.csrf });
const it29 = (r.json?.items ?? r.json ?? []).find?.((x) => x.id === mat) ?? (r.json?.items ?? []).filter((x) => x.type === 'material')[0];
console.log('T1 days_left@29d:', r.status, JSON.stringify(it29)?.slice(0, 120));

// T2: 30 天前恰逢边界（< cutoff 含 30 天整点？cutoff=now()-30d，deleted_at=now()-30d → 不满足 < → 保留）
psql(`UPDATE material SET deleted_at=now() - interval '30 days' WHERE id='${mat}';`);
r = await req('GET', '/trash?type=material', { rawCookie: o.cookie, csrfHeader: o.csrf });
console.log('T2 days_left@30d-exact:', r.status, JSON.stringify(r.json)?.slice(0, 150));

// T3: 31 天前 → days_left=0（到期展示），真实清理由 Go 测试路径验证
psql(`UPDATE material SET deleted_at=now() - interval '31 days' WHERE id='${mat}';`);
r = await req('GET', '/trash?type=material', { rawCookie: o.cookie, csrfHeader: o.csrf });
const items = r.json?.items ?? [];
const it31 = items.filter((x) => x.type === 'material')[0];
console.log('T3 days_left@31d:', r.status, it31 ? `days_left=${it31.days_left}` : 'item missing');

console.log('\nR9-4 API side done (真实清理函数走 Go 测试，见 r9_trash_test.go)');
process.exit(0);
