#!/usr/bin/env node
// G-02（docs/38 §3.2、docs/90 D-190）：AI 对话页未登记结构增量守卫。
//
// 口径（D-190）：以基线 commit 3e8be0c1 与最终 checkpoint 的
//   Agent 路由表 + 数据库迁移清单 + Shell.tsx 一级导航/分组清单 + Agent feature flag
// 为结构事实。基线必须由同一提取器从 commit 复算，不能手写只匹配当前文本。
// 最终工作树任何新增/删除/变更都必须命中 manifest 的 delta，并回链 docs/90 决策；
// 外部例外必须逐条写明 owner/reason，不允许静默忽略；当前 manifest 精确登记 00112/00115 两个外部 WIP。
//
// 用法：
//   node scripts/g02-structure-guard.mjs                 # 校验最终工作树
//   node scripts/g02-structure-guard.mjs --ref 3e8be0c1 # 只校验基线 commit 可复算
//   node scripts/g02-structure-guard.mjs --manifest <path>
//   node scripts/g02-structure-guard.mjs --print-snapshot
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
export const BASELINE_COMMIT = '3e8be0c1a6f9c5eaaddcc7532dedf7ab935b89fa'
export const DEFAULT_MANIFEST = path.join(ROOT, 'renderer', 'tests', 'fixtures', 'g02-structure-baseline.json')
const AGENT_ROUTE_FILE = 'server/internal/app/agent.go'
const SHELL_FILE = 'renderer/layout/Shell.tsx'
const WORKBENCH_FILE = 'server/internal/app/agent_workbench.go'
const MIGRATION_DIR = 'server/internal/db/migrations'
const DECISIONS_FILE = 'docs/90-决策与变更记录.md'

const ROUTE_RE = /r\.(Get|Post|Put|Patch|Delete)\(\s*"([^"]+)"/g
const MISSING = Symbol('missing')

export class GuardError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'GuardError'
    this.code = code
    this.detail = detail
  }
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trimEnd()
}

function readSource(source, relPath) {
  if (source === 'worktree') return fs.readFileSync(path.join(ROOT, relPath), 'utf8')
  return git(['show', `${source}:${relPath}`])
}

function listMigrations(source) {
  if (source === 'worktree') {
    return fs.readdirSync(path.join(ROOT, MIGRATION_DIR))
      .filter((name) => name.endsWith('.sql'))
      .sort()
  }
  return git(['ls-tree', '-r', '--name-only', source, '--', MIGRATION_DIR])
    .split('\n').filter(Boolean).map((name) => path.basename(name)).sort()
}

function normalizeRoutePath(routePath) {
  return routePath.replace(/\{[^{}]+\}/g, '{id}')
}

function routeId(route) { return `${route.method} ${normalizeRoutePath(route.path)}` }

function extractRoutes(text) {
  const seen = new Map()
  for (const match of text.matchAll(ROUTE_RE)) {
    const method = match[1].toUpperCase()
    const routePath = match[2]
    if (!routePath.startsWith('/agent')) continue
    const id = `${method} ${normalizeRoutePath(routePath)}`
    if (seen.has(id)) throw new GuardError('DUPLICATE_ROUTE', `Agent 路由重复注册：${id}`)
    seen.set(id, { method, path: routePath })
  }
  if (seen.size === 0) throw new GuardError('EMPTY_ROUTES', `${AGENT_ROUTE_FILE} 未提取到任何 Agent 路由`)
  return [...seen.values()].sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)))
}

function extractFeatureFlags(text) {
  const block = /var agentWorkbenchFeatureNames = \[\]string\{([\s\S]*?)\n\}/.exec(text)
  if (!block) throw new GuardError('FLAG_BLOCK_MISSING', '未找到 agentWorkbenchFeatureNames')
  const names = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  if (names.length === 0) throw new GuardError('EMPTY_FLAGS', 'agentWorkbenchFeatureNames 为空')
  if (new Set(names).size !== names.length) throw new GuardError('DUPLICATE_FLAG', 'agentWorkbenchFeatureNames 含重复项')
  const defaultBlock = /var agentFeatureDefaultOn = map\[string\]bool\{([\s\S]*?)\n\}/.exec(text)
  if (!defaultBlock) throw new GuardError('DEFAULT_FLAG_BLOCK_MISSING', '未找到 agentFeatureDefaultOn')
  const defaultOn = [...defaultBlock[1].matchAll(/"([^"]+)"\s*:\s*true/g)].map((m) => m[1])
  for (const name of defaultOn) {
    if (!names.includes(name)) throw new GuardError('DEFAULT_FLAG_UNKNOWN', `默认开集合含未登记 flag：${name}`)
  }
  return { names: [...names].sort(), default_on: [...defaultOn].sort() }
}

function shellSnapshot(text) {
  const requireFromRenderer = createRequire(path.join(ROOT, 'renderer', 'package.json'))
  const ts = requireFromRenderer('typescript')
  const file = ts.createSourceFile(SHELL_FILE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const vars = new Map()
  const wanted = new Set(['nav', 'desktopNavGroups', 'mobileNav', 'mobileMoreGroups'])

  const evalLiteral = (node) => {
    if (!node) return MISSING
    if (ts.isStringLiteralLike(node)) return node.text
    if (ts.isNumericLiteral(node)) return Number(node.text)
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false
    if (node.kind === ts.SyntaxKind.NullKeyword) return null
    if (ts.isParenthesizedExpression(node)) return evalLiteral(node.expression)
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression?.(node)) return evalLiteral(node.expression)
    if (ts.isArrayLiteralExpression(node)) {
      const out = []
      for (const el of node.elements) {
        const value = evalLiteral(el)
        if (value !== MISSING) out.push(value)
      }
      return out
    }
    if (ts.isObjectLiteralExpression(node)) {
      const out = {}
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) continue
        const key = ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)
          ? prop.name.text
          : prop.name.getText(file)
        const value = evalLiteral(prop.initializer)
        if (value !== MISSING) out[key] = value
      }
      return out
    }
    if (ts.isIdentifier(node) && vars.has(node.text)) return vars.get(node.text)
    if (ts.isElementAccessExpression(node)) {
      const base = evalLiteral(node.expression)
      const index = evalLiteral(node.argumentExpression)
      if (Array.isArray(base) && Number.isInteger(index)) return base[index] ?? MISSING
      return MISSING
    }
    if (ts.isPropertyAccessExpression(node)) {
      const base = evalLiteral(node.expression)
      if (base && typeof base === 'object') return base[node.name.text] ?? MISSING
      return MISSING
    }
    return MISSING
  }

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && wanted.has(node.name.text) && node.initializer) {
      const value = evalLiteral(node.initializer)
      if (value !== MISSING) vars.set(node.name.text, value)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)

  for (const name of wanted) {
    if (!Array.isArray(vars.get(name))) throw new GuardError('SHELL_MISSING', `Shell.tsx 未提取到 ${name}`)
  }

  const pickItem = (item) => {
    if (!item || typeof item !== 'object') return null
    const out = {}
    if (typeof item.path === 'string') out.path = item.path
    if (typeof item.to === 'string') out.path = item.to
    if (typeof item.label === 'string') out.label = item.label
    if (typeof item.mobile === 'string') out.mobile = item.mobile
    if (item.end === true) out.end = true
    if (item.scoped === true) out.scoped = true
    return out.label && out.path !== undefined ? out : null
  }
  const normalizeList = (list) => list.map(pickItem).filter(Boolean)
  const normalizeGroups = (groups) => groups.map((group) => ({
    label: group?.label,
    items: normalizeList(group?.items ?? []),
  }))

  const nav = normalizeList(vars.get('nav'))
  const desktopNavGroups = normalizeGroups(vars.get('desktopNavGroups'))
  const mobileNav = normalizeList(vars.get('mobileNav'))
  const mobileMoreGroups = normalizeGroups(vars.get('mobileMoreGroups'))
  if (nav.length === 0 || desktopNavGroups.length === 0 || mobileNav.length === 0 || mobileMoreGroups.length === 0) {
    throw new GuardError('SHELL_EMPTY', 'Shell.tsx 导航提取为空')
  }
  return { nav, desktopNavGroups, mobileNav, mobileMoreGroups }
}

export function buildSnapshot({ source = 'worktree', ref = '' } = {}) {
  const spec = ref || source
  return {
    routes: extractRoutes(readSource(spec, AGENT_ROUTE_FILE)),
    migrations: listMigrations(spec),
    shell: shellSnapshot(readSource(spec, SHELL_FILE)),
    flags: extractFeatureFlags(readSource(spec, WORKBENCH_FILE)),
  }
}

function stable(value) { return JSON.stringify(value) }

// 路径参数名只是 handler 绑定名，不是 API 结构。A13 把 {id} 统一成 {conversationId}
// 时，字符串级 diff 会误报为 4 个新增/删除端点；比较时归一化为 {id}。
function stableFacts(key, value) {
  if (key === 'routes' && Array.isArray(value)) {
    const normalized = value.map((route) => ({ method: route.method, path: normalizeRoutePath(route.path) }))
      .sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)))
    return stable(normalized)
  }
  return stable(value)
}

function compareFacts(label, actual, expected) {
  const problems = []
  for (const key of ['routes', 'migrations', 'shell', 'flags']) {
    if (stableFacts(key, actual[key]) !== stableFacts(key, expected?.[key])) {
      problems.push(`${label}.${key} 与 manifest 不一致`)
    }
  }
  if (problems.length) throw new GuardError('MANIFEST_DRIFT', problems.join('；'), { label, problems })
}

export function collectDeltas(baseline, checkpoint) {
  const deltas = []
  const diffSet = (category, before, after) => {
    const b = new Set(before)
    const a = new Set(after)
    for (const id of a) if (!b.has(id)) deltas.push({ category, id, change: 'added' })
    for (const id of b) if (!a.has(id)) deltas.push({ category, id, change: 'removed' })
  }
  diffSet('route', baseline.routes.map(routeId), checkpoint.routes.map(routeId))
  diffSet('migration', baseline.migrations, checkpoint.migrations)
  diffSet('flag', baseline.flags.names, checkpoint.flags.names)
  diffSet('flag_default_on', baseline.flags.default_on, checkpoint.flags.default_on)
  for (const key of ['nav', 'desktopNavGroups', 'mobileNav', 'mobileMoreGroups']) {
    if (stable(baseline.shell[key]) !== stable(checkpoint.shell[key])) {
      deltas.push({ category: 'shell', id: key, change: 'changed' })
    }
  }
  return deltas.sort((a, b) => `${a.category}:${a.id}:${a.change}`.localeCompare(`${b.category}:${b.id}:${b.change}`))
}

function decisionHeadingExists(decisionsText, decision) {
  return new RegExp(`^## ${decision.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(decisionsText)
}

export function evaluateGuard({ baseline, checkpoint, manifest, decisionsText }) {
  if (manifest?.schema !== 'g02-structure-baseline@1') {
    throw new GuardError('MANIFEST_SCHEMA', 'manifest schema 必须为 g02-structure-baseline@1')
  }
  if (manifest.baseline_commit !== BASELINE_COMMIT) {
    throw new GuardError('BASELINE_MISMATCH', `manifest 基线 commit 必须为 ${BASELINE_COMMIT}`)
  }
  compareFacts('baseline', baseline, manifest.baseline)

  const computed = collectDeltas(baseline, checkpoint)
  const registered = new Map()
  for (const delta of manifest.deltas ?? []) {
    const key = `${delta.category}:${delta.id}:${delta.change}`
    if (registered.has(key)) throw new GuardError('DELTA_DUPLICATE', `manifest delta 重复：${key}`)
    registered.set(key, delta)
  }

  const exceptions = new Map()
  for (const exception of manifest.exceptions ?? []) {
    if (!exception?.id || !exception?.owner || !exception?.reason) {
      throw new GuardError('EXCEPTION_INVALID', 'manifest 外部例外必须写明 id/owner/reason')
    }
    exceptions.set(`${exception.category ?? 'migration'}:${exception.id}`, exception)
  }

  for (const delta of computed) {
    const key = `${delta.category}:${delta.id}:${delta.change}`
    const entry = registered.get(key)
    if (!entry) throw new GuardError('UNREGISTERED_STRUCTURE', `发现未登记结构增量：${key}`, delta)
    if (entry.exception) {
      const exception = exceptions.get(`${delta.category}:${delta.id}`)
      if (!exception) throw new GuardError('EXCEPTION_MISSING', `结构增量声称外部例外但未登记：${key}`, delta)
      if (!entry.reason) throw new GuardError('EXCEPTION_REASON', `外部例外缺少原因：${key}`, delta)
      continue
    }
    if (!entry.decision) throw new GuardError('DECISION_MISSING', `结构增量未回链 docs/90 决策：${key}`, delta)
    if (!decisionHeadingExists(decisionsText, entry.decision)) {
      throw new GuardError('DECISION_NOT_FOUND', `docs/90 不存在决策 ${entry.decision}（${key}）`, delta)
    }
  }

  for (const [key, entry] of registered) {
    if (!computed.some((delta) => `${delta.category}:${delta.id}:${delta.change}` === key)) {
      throw new GuardError('DELTA_STALE', `manifest delta 与基线/checkpoint 差异不符：${key}`, entry)
    }
  }
  const deltaKeys = new Set((manifest.deltas ?? []).map((delta) => `${delta.category}:${delta.id}:${delta.change}`))
  for (const [key] of exceptions) {
    const matched = (manifest.deltas ?? []).some((delta) => `${delta.category}:${delta.id}` === key && delta.exception)
    if (!matched) throw new GuardError('EXCEPTION_STALE', `manifest 外部例外未对应实际 delta：${key}`)
  }
  if (deltaKeys.size !== computed.length) {
    throw new GuardError('DELTA_COUNT', `manifest delta 数量 ${deltaKeys.size} 与实际差异 ${computed.length} 不符`)
  }
  compareFacts('checkpoint', checkpoint, manifest.checkpoint)

  return {
    ok: true,
    baselineCommit: BASELINE_COMMIT,
    baselineRoutes: baseline.routes.length,
    checkpointRoutes: checkpoint.routes.length,
    baselineMigrations: baseline.migrations.length,
    checkpointMigrations: checkpoint.migrations.length,
    deltas: computed.length,
    exceptions: exceptions.size,
  }
}

export function loadManifest(manifestPath = DEFAULT_MANIFEST) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
}

export function runGuard({ manifestPath = DEFAULT_MANIFEST, source = 'worktree', ref = '' } = {}) {
  const manifest = loadManifest(manifestPath)
  if (ref && !BASELINE_COMMIT.startsWith(ref)) {
    throw new GuardError('BASELINE_REF', `只接受基线 commit ${BASELINE_COMMIT}，收到 ${ref}`)
  }
  const baseline = buildSnapshot({ ref: BASELINE_COMMIT })
  if (source !== 'worktree' || ref) {
    compareFacts('baseline', baseline, manifest.baseline)
    return { ok: true, mode: 'baseline', baselineCommit: BASELINE_COMMIT, baselineRoutes: baseline.routes.length }
  }
  const checkpoint = buildSnapshot({ source: 'worktree' })
  const decisionsText = fs.readFileSync(path.join(ROOT, DECISIONS_FILE), 'utf8')
  return evaluateGuard({ baseline, checkpoint, manifest, decisionsText })
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--print-snapshot')) {
    const out = { baseline: buildSnapshot({ ref: BASELINE_COMMIT }), checkpoint: buildSnapshot({ source: 'worktree' }) }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    return
  }
  const manifestIndex = args.indexOf('--manifest')
  const manifestPath = manifestIndex >= 0 ? path.resolve(args[manifestIndex + 1]) : DEFAULT_MANIFEST
  const refIndex = args.indexOf('--ref')
  const ref = refIndex >= 0 ? args[refIndex + 1] : ''
  const result = runGuard({ manifestPath, source: ref ? 'ref' : 'worktree', ref })
  if (result.mode === 'baseline') {
    process.stdout.write(`BASELINE PASS ${result.baselineCommit.slice(0, 12)} routes=${result.baselineRoutes}\n`)
    return
  }
  process.stdout.write(
    `G-02 PASS baseline=${result.baselineCommit.slice(0, 12)} routes=${result.baselineRoutes}->${result.checkpointRoutes} ` +
    `migrations=${result.baselineMigrations}->${result.checkpointMigrations} deltas=${result.deltas} exceptions=${result.exceptions}\n`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error.code ?? 'G02_ERROR'}: ${error.message}\n`)
    if (error.detail) process.stderr.write(`${JSON.stringify(error.detail, null, 2)}\n`)
    process.exitCode = 1
  }
}
