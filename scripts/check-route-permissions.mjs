#!/usr/bin/env node
// BE-03（docs/33 §11.6 / docs/37 P1-13）：路由 → 权限矩阵静态清单生成器。
//
// 方法：源码静态扫描（不运行服务端）——
//   1. 从 server/internal/app/routes_register.go 等注册文件抽取全部 r.Get/Post/Put/
//      Patch/Delete 路由（method + path + handler 名）；
//   2. 在 handler 所在 .go 文件中抽取其权限守卫调用（requireEditor/requireAdmin/
//      requireAgentFeature/pluginGuard/computerGuard/browserRoleGuard/ident 判定）；
//   3. 抽取 handler 函数体内是否出现 workspace_id 过滤与审计调用；
//   4. 生成 docs/acceptance/route-permissions.json（自动生成列），与上一份入库副本
//      逐条对比：新增/删除/权限面变化即退出码 1（CI 校验）。
//
// 边界（BE-03 规格）：静态扫描有假阳/阴，清单必须标「自动生成」，不得当作已证明
// 隔离正确；本脚本不改业务代码；抽样人工核对由评审承担。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(ROOT, 'server', 'internal', 'app');
const OUT = path.join(ROOT, 'docs', 'acceptance', 'route-permissions.json');

const REGISTRY_FILES = ['routes_register.go', 'agent.go', 'server.go', 'checks.go'];

// readAllGoFiles 收集 internal/app 全部 Go 源（排除测试）。
function readAllGoFiles() {
  const out = [];
  for (const name of fs.readdirSync(APP_DIR)) {
    if (name.endsWith('.go') && !name.endsWith('_test.go')) {
      out.push({ name, text: fs.readFileSync(path.join(APP_DIR, name), 'utf8') });
    }
  }
  return out;
}

// extractRoutes 从注册文件抽取 (method, path, handler) 三元组。
function extractRoutes(files) {
  const routes = [];
  const re = /r\.(Get|Post|Put|Patch|Delete)\("([^"]+)",\s*s\.h\((s\.[A-Za-z0-9_]+)\)\)/g;
  for (const f of files) {
    for (const m of f.text.matchAll(re)) {
      routes.push({ method: m[1].toUpperCase(), path: m[2], handler: m[3], file: f.name });
    }
  }
  routes.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
  return routes;
}

// findHandlerBody 定位 handler 函数体（按 func (s *Server) Name 起点，花括号配平）。
function findHandlerBody(files, handlerName) {
  const marker = `func (s *Server) ${handlerName.replace(/^s\./, '')}(`;
  for (const f of files) {
    const idx = f.text.indexOf(marker);
    if (idx < 0) continue;
    let depth = 0;
    for (let i = idx; i < f.text.length; i += 1) {
      if (f.text[i] === '{') depth += 1;
      else if (f.text[i] === '}') {
        depth -= 1;
        if (depth === 0) return { file: f.name, body: f.text.slice(idx, i + 1) };
      }
    }
  }
  return null;
}

// GUARD_PATTERNS：已知权限守卫与安全相关调用面（对照 33 §11.6 的 30+ 权限函数归组）。
const GUARD_PATTERNS = [
  'requireAdmin', 'requireEditor', 'requireAgentFeature', 'pluginGuard', 'computerGuard',
  'browserRoleGuard', 'desktopReadAndVerifyProof', 'desktopVerifyProof', 'browserPolicyGuard',
  'requireViewerKnown', 'accountFromPath', 'loadOwnedWork', 'workFromPath',
];

function analyzeRoute(files, route) {
  const found = findHandlerBody(files, route.handler);
  if (!found) return { ...route, guard: [], workspace_filter: null, audit: null, note: 'handler_body_not_found' };
  const body = found.body;
  const guard = GUARD_PATTERNS.filter((g) => body.includes(g));
  const wsFilter = /workspace_id\s*=|workspace_id=\$|workspace_id,|a\.WorkspaceID|id\.WorkspaceID/.test(body);
  const audit = /auditTx\(|s\.audit\(/.test(body);
  // 可疑项标记（BE-03 规格）：无守卫 / 无工作区过滤 / 无审计（仅标记，不判缺陷）。
  const suspects = [];
  if (guard.length === 0) suspects.push('no_guard_detected');
  if (!wsFilter) suspects.push('no_workspace_filter_detected');
  if (!audit) suspects.push('no_audit_detected');
  return { method: route.method, path: route.path, handler: route.handler, file: route.file,
    guard_file: found.file, guards: guard, workspace_filter_detected: wsFilter, audit_detected: audit, suspects };
}

// gen 生成清单对象。
function gen() {
  const files = readAllGoFiles();
  const routes = extractRoutes(files.filter((f) => REGISTRY_FILES.includes(f.name)));
  const entries = routes.map((r) => analyzeRoute(files, r));
  return {
    schema: 'ops.route-permissions/1',
    generated_by: 'scripts/check-route-permissions.mjs（自动生成；静态扫描有假阳/阴，人工复核列由评审承担，不当作已证明隔离正确）',
    route_count: entries.length,
    suspect_counts: {
      no_guard_detected: entries.filter((e) => e.suspects?.includes('no_guard_detected')).length,
      no_workspace_filter_detected: entries.filter((e) => e.suspects?.includes('no_workspace_filter_detected')).length,
      no_audit_detected: entries.filter((e) => e.suspects?.includes('no_audit_detected')).length,
      handler_body_not_found: entries.filter((e) => e.note === 'handler_body_not_found').length,
    },
    routes: entries,
  };
}

const mode = process.argv[2] ?? '--check';
const next = gen();
if (mode === '--write') {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(next, null, 2) + '\n');
  console.log(`written ${next.route_count} routes → ${path.relative(ROOT, OUT)}`);
  process.exit(0);
}
// --check：与入库副本对比；不存在或差异即退出 1（CI 校验面）。
if (!fs.existsSync(OUT)) {
  console.error(`BE-03 清单缺失：${OUT}。先运行 node scripts/check-route-permissions.mjs --write 生成并人工复核后提交。`);
  process.exit(1);
}
const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
if (prev.route_count !== next.route_count) {
  console.error(`BE-03 路由数变化：清单 ${prev.route_count} → 现取 ${next.route_count}。重新 --write 并复核 diff 后提交。`);
  process.exit(1);
}
const keyOf = (e) => `${e.method} ${e.path}`;
const prevMap = new Map(prev.routes.map((e) => [keyOf(e), JSON.stringify(e)]));
const diffs = [];
for (const e of next.routes) {
  const k = keyOf(e);
  if (!prevMap.has(k)) diffs.push(`新增 ${k}`);
  else if (prevMap.get(k) !== JSON.stringify(e)) diffs.push(`权限面变化 ${k}（${e.handler}）`);
  prevMap.delete(k);
}
for (const k of prevMap.keys()) diffs.push(`移除 ${k}`);
if (diffs.length > 0) {
  console.error(`BE-03 清单与现取路由不一致（${diffs.length} 处）：\n  ${diffs.slice(0, 20).join('\n  ')}`);
  process.exit(1);
}
console.log(`BE-03 清单核对通过：${next.route_count} 条路由，可疑项 no_guard=${next.suspect_counts.no_guard_detected} no_ws=${next.suspect_counts.no_workspace_filter_detected} no_audit=${next.suspect_counts.no_audit_detected} 未找到=${next.suspect_counts.handler_body_not_found}`);
