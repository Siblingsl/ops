'use strict';
// BE-03（docs/33 §11.6 / BE-03）：权限矩阵静态清单生成器。
// 扫描 server/internal/app/server.go 的路由注册 + 各 handler 的权限/工作区过滤/
// 审计调用，产出机器可读清单（JSON + Markdown 摘要）到 docs/acceptance/。
// 边界（docs/33 BE-03 定义）：只读静态扫描，不改业务代码；输出必须标注
// 「自动生成 + 人工复核」两列语义，不得当作已证明隔离正确。
// 用法：node scripts/be03-permission-matrix.mjs [--check]
//   --check：对照已生成清单校验路由集未漂移（CI 可用），漂移退出码 1。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const repoRoot = path.resolve(__dirname, '..');
const appDir = path.join(repoRoot, 'server', 'internal', 'app');
const serverGo = fs.readFileSync(path.join(appDir, 'server.go'), 'utf8');
const outFile = path.join(repoRoot, 'docs', 'acceptance', 'be03-permission-matrix.json');

// ---------------------------------------------------------------------------
// 1. 路由提取：从 server.go 提取 (method, path) 与所在 Group 的中间件上下文。
// ---------------------------------------------------------------------------

/** 按大括号配平截取 `r.Group(func(r chi.Router) { ... })` 的层级结构。 */
function extractGroups(source) {
  // 返回 [{ startLine, endLine, middlewares: string[] }]
  const groups = [];
  const lines = source.split('\n');
  const stack = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const groupMatch = line.match(/r\.Group\(func\(r chi\.Router\) \{/);
    if (groupMatch) {
      const middlewares = [];
      // 向上收集紧邻的 r.Use(...)（同层级前缀）
      for (let j = i - 1; j >= 0; j -= 1) {
        const useMatch = lines[j].match(/\t*r\.Use\((.+)\)/);
        if (useMatch) middlewares.unshift(useMatch[1].trim());
        else if (lines[j].trim() === '' || lines[j].includes('r.Group(func')) break;
        else break;
      }
      stack.push({ middlewares });
      depth += 1;
      continue;
    }
    if (depth > 0 && /\}\)/.test(line) && !line.includes('func(r chi.Router)')) {
      // 可能是组结束；按大括号配平验证
      const opens = (line.match(/\{/g) || []).length;
      const closes = (line.match(/\}/g) || []).length;
      if (closes > opens) {
        depth -= 1;
        const g = stack.pop();
        groups.push({ startLine: 0, endLine: i + 1, middlewares: g ? g.middlewares : [] });
      }
    }
  }
  return groups;
}

/** 提取全部路由：method + path + 行号 + 该行之前最近的 Group 中间件链（近似）。 */
function extractRoutes(source) {
  const routes = [];
  const lines = source.split('\n');
  // 简化 Group 归属：记录每个 Group 的起止行，路由按行号落入区间。
  const groupRanges = [];
  {
    const stack = [];
    let openLine = -1;
    let openDepth = 0;
    let pendingUse = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/r\.Group\(func\(r chi\.Router\) \{/.test(line)) {
        const use = [];
        for (let j = i - 1; j >= 0; j -= 1) {
          const m = lines[j].match(/\tr\.Use\((.+)\)/);
          if (m) use.unshift(m[1].trim());
          else if (lines[j].trim() === '') continue;
          else break;
        }
        stack.push({ use: [...pendingUse, ...use] });
        pendingUse = [];
        openLine = i;
        openDepth += 1;
        continue;
      }
      if (stack.length > 0 && /^\t*\}\)$/.test(line)) {
        const g = stack.pop();
        groupRanges.push({ from: openLine + 1, to: i + 1, use: g ? g.use : [] });
        openDepth -= 1;
      }
      const useHere = line.match(/^\tr\.Use\((.+)\)/);
      if (useHere && stack.length === 0) pendingUse.push(useHere[1].trim());
    }
  }
  const routeRe = /\br\.(Get|Post|Put|Delete|Patch)\("([^"]+)"/;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(routeRe);
    if (!m) continue;
    const group = groupRanges.find((g) => i + 1 >= g.from && i + 1 <= g.to);
    routes.push({
      method: m[1].toUpperCase(),
      path: m[2],
      line: i + 1,
      group_middleware: group ? group.use : [],
    });
  }
  return routes;
}

// ---------------------------------------------------------------------------
// 2. handler 权限特征扫描：handler 函数体内出现的权限/过滤/审计调用。
// ---------------------------------------------------------------------------

/** 汇总 app 目录所有生产 .go 文件的函数体索引（函数名 → 源码）。 */
function buildHandlerIndex() {
  const index = new Map();
  for (const f of fs.readdirSync(appDir)) {
    if (!f.endsWith('.go') || f.endsWith('_test.go')) continue;
    const src = fs.readFileSync(path.join(appDir, f), 'utf8');
    const fnRe = /func \(s \*Server\) ([a-zA-Z0-9_]+)\(/g;
    let m;
    while ((m = fnRe.exec(src)) !== null) {
      const name = m[1];
      // 按大括号配平截取函数体
      let depth = 0;
      let started = false;
      let end = src.length;
      for (let i = m.index; i < src.length; i += 1) {
        if (src[i] === '{') { depth += 1; started = true; }
        if (src[i] === '}') { depth -= 1; if (started && depth === 0) { end = i + 1; break; } }
      }
      if (!index.has(name)) index.set(name, []);
      index.get(name).push({ file: f, body: src.slice(m.index, end) });
    }
  }
  return index;
}

const PERMISSION_MARKERS = [
  ['requireOwner', 'requireOwner'],
  ['requireSystemAdmin', 'requireSystemAdmin'],
  ['requireReauth', 'requireReauth'],
  ['requireAgentFeature', 'requireAgentFeature'],
  ['personalMemoryGuard', 'personalMemoryGuard(本人私有)'],
  ['browserRoleGuard', 'browserRoleGuard'],
  ['requireDesktopAccountSession', 'requireDesktopAccountSession(组中间件)'],
  ['requireWorkAsset', 'requireWorkAsset'],
];
const WORKSPACE_MARKERS = ['id.WorkspaceID', 'workspace_id=$', 'workspaceID'];
const AUDIT_MARKERS = ['s.audit(', 's.auditTx(', 's.auditTxVis('];

function scanHandler(index, handlerName) {
  const defs = index.get(handlerName) || [];
  const flags = new Set();
  const workspaceFilterHits = [];
  const auditHits = [];
  for (const def of defs) {
    for (const [marker, label] of PERMISSION_MARKERS) {
      if (def.body.includes(marker)) flags.add(label);
    }
    for (const ws of WORKSPACE_MARKERS) {
      if (def.body.includes(ws)) { workspaceFilterHits.push(def.file); break; }
    }
    for (const audit of AUDIT_MARKERS) {
      if (def.body.includes(audit)) { auditHits.push(def.file); break; }
    }
  }
  return {
    handler: handlerName,
    defs: defs.map((d) => d.file),
    permission_flags: [...flags],
    workspace_filter: workspaceFilterHits.length > 0 ? 'yes' : 'CHECK',
    audit: auditHits.length > 0 ? 'yes' : 'CHECK',
  };
}

/** 从 server.go 路由行解析 handler 名（s.handlerName 形式；特殊通道单独标注）。 */
function resolveHandler(line) {
  const direct = line.match(/s\.h\(s\.([a-zA-Z0-9_]+)\)/);
  if (direct) return { name: direct[1], special: null };
  if (line.includes('s.desktopChannel')) return { name: '(raw-websocket)', special: 's.desktopChannel——一次性 ticket 鉴权（auth.go desktopChannel），非 s.h 包装' };
  if (line.includes('s.healthz')) return { name: '(raw-healthz)', special: 's.healthz——无鉴权健康检查' };
  const ws = line.match(/s\.(requireDesktopAccountSession\w*)/);
  if (ws) return { name: `(middleware:${ws[1]})`, special: '中间件行，非路由' };
  return { name: '(unresolved)', special: '需人工复核：路由行未匹配 s.h(s.X) 形式' };
}

// ---------------------------------------------------------------------------
// 3. 生成清单 + 可疑项标注。
// ---------------------------------------------------------------------------

function main() {
  const checkOnly = process.argv.includes('--check');
  const routes = extractRoutes(serverGo);
  const index = buildHandlerIndex();

  const rows = routes.map((r) => {
    const { name, special } = resolveHandler(
      serverGo.split('\n')[r.line - 1],
    );
    const scanned = name.startsWith('(') ? {
      handler: name, defs: [], permission_flags: [], workspace_filter: special ? 'N/A' : 'CHECK', audit: 'N/A',
    } : scanHandler(index, name);
    return {
      method: r.method,
      path: r.path,
      line: r.line,
      group_middleware: r.group_middleware,
      ...scanned,
      ...(special ? { note: special } : {}),
      review: 'auto-generated',
    };
  });

  const suspicious = rows.filter((r) => r.workspace_filter === 'CHECK' || r.audit === 'CHECK' || r.handler === '(unresolved)');
  const doc = {
    _meta: {
      generator: 'scripts/be03-permission-matrix.mjs',
      generated_at: new Date().toISOString(),
      semantics: 'workspace_filter/audit 列的 CHECK = 静态扫描未在 handler 体内直接命中标记，需人工复核（可能由被调用方或中间件承担）；不等于越权',
      counts: {
        routes: rows.length,
        workspace_filter_yes: rows.filter((r) => r.workspace_filter === 'yes').length,
        audit_yes: rows.filter((r) => r.audit === 'yes').length,
        check_needed: suspicious.length,
      },
    },
    routes: rows,
  };

  if (checkOnly) {
    if (!fs.existsSync(outFile)) {
      console.error(`[be03] 清单不存在：${outFile}（先不带 --check 生成一次）`);
      process.exit(1);
    }
    const existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    const key = (r) => `${r.method} ${r.path}`;
    const before = new Set(existing.routes.map(key));
    const after = new Set(rows.map(key));
    const added = [...after].filter((k) => !before.has(k));
    const removed = [...before].filter((k) => !after.has(k));
    if (added.length || removed.length) {
      console.error('[be03] 路由集漂移：新增', added, '移除', removed);
      console.error('[be03] 请重新生成清单并人工复核差异，再提交。');
      process.exit(1);
    }
    console.log(`[be03] 路由集与清单一致（${after.size} 条）`);
    return;
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`[be03] 清单已生成：${outFile}`);
  console.log(`[be03] 路由 ${rows.length} 条；workspace_filter=yes ${doc._meta.counts.workspace_filter_yes}；audit=yes ${doc._meta.counts.audit_yes}；需人工复核 ${suspicious.length}`);
  const mdOut = path.join(repoRoot, 'docs', 'acceptance', 'be03-permission-matrix.md');
  const md = [
    '# BE-03 权限矩阵静态清单（自动生成，需人工复核）',
    '',
    `> 生成器：\`scripts/be03-permission-matrix.mjs\`；生成时间 ${doc._meta.generated_at}。`,
    '> `workspace_filter`/`audit` 列为 **静态文本命中**：`CHECK` 表示未在 handler 体内直接命中标记',
    '>（可能由被调用函数、中间件或子查询承担）——**不等于越权**，须逐条人工复核后改定。',
    '> 复核语义：自动生成 ≠ 已证明隔离正确（docs/33 BE-03 边界）。',
    '',
    `路由总数 ${rows.length}；workspace_filter=yes ${doc._meta.counts.workspace_filter_yes}；audit=yes ${doc._meta.counts.audit_yes}；CHECK 待复核 ${suspicious.length}`,
    '',
    '| 方法 | 路径 | handler | 权限标记 | workspace_filter | audit |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.method} | ${r.path} | ${r.handler} | ${r.permission_flags.join('、') || '—'} | ${r.workspace_filter} | ${r.audit} |`),
  ].join('\n');
  fs.writeFileSync(mdOut, `${md}\n`);
  console.log(`[be03] Markdown 摘要：${mdOut}`);
}

main();
