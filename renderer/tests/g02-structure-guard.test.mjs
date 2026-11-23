import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  BASELINE_COMMIT,
  DEFAULT_MANIFEST,
  buildSnapshot,
  collectDeltas,
  evaluateGuard,
  loadManifest,
  runGuard,
} from '../../scripts/g02-structure-guard.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DECISIONS = fs.readFileSync(path.join(ROOT, 'docs', '90-决策与变更记录.md'), 'utf8')
const MANIFEST = loadManifest()
const BASE = buildSnapshot({ ref: BASELINE_COMMIT })
const CURRENT = buildSnapshot({ source: 'worktree' })

test('G-02：基线 manifest 可由基线 commit 复算，最终工作树全部差异回链 docs/90', () => {
  const result = runGuard()
  assert.equal(result.ok, true)
  assert.equal(result.baselineRoutes, 111)
  assert.equal(result.checkpointRoutes, 121)
  assert.equal(result.baselineMigrations, 111)
  assert.equal(result.checkpointMigrations, 141)
  assert.equal(result.deltas, 47)
  assert.equal(result.exceptions, 2)

  const computed = collectDeltas(BASE, CURRENT)
  assert.equal(computed.length, MANIFEST.deltas.length)
  for (const delta of computed) {
    const key = `${delta.category}:${delta.id}:${delta.change}`
    const entry = MANIFEST.deltas.find((item) => `${item.category}:${item.id}:${item.change}` === key)
    assert.ok(entry, `manifest 缺少实际差异 ${key}`)
    if (entry.exception) {
      const exception = MANIFEST.exceptions.find((item) => item.category === delta.category && item.id === delta.id)
      assert.ok(exception, `外部例外未登记 ${key}`)
      assert.ok(exception.owner && exception.reason, `外部例外缺少 owner/reason ${key}`)
    } else {
      assert.ok(entry.decision, `结构增量未回链决策 ${key}`)
      assert.match(DECISIONS, new RegExp(`^## ${entry.decision}`, 'm'), `docs/90 无决策 ${entry.decision}`)
    }
  }
})

test('G-02：外部例外只允许 00112/00115 两个显式 WIP，不得静默忽略', () => {
  assert.equal(MANIFEST.exceptions.length, 2)
  assert.deepEqual(
    MANIFEST.exceptions.map((item) => `${item.category}:${item.id}`).sort(),
    ['migration:00112_publish_engine.sql', 'migration:00115_topic_score_rule_range.sql'],
  )
  for (const id of ['00112_publish_engine.sql', '00115_topic_score_rule_range.sql']) {
    const exception = MANIFEST.exceptions.find((item) => item.id === id)
    assert.ok(exception, `${id} 必须显式登记`)
    assert.equal(exception.category, 'migration')
    assert.ok(exception.owner && exception.reason, `${id} 缺少 owner/reason`)
    const delta = MANIFEST.deltas.find((item) => item.id === id)
    assert.ok(delta?.exception, `${id} 必须以显式 exception 登记`)
    assert.equal(delta.decision, null)
  }
})

function assertUnregistered(mutate) {
  const checkpoint = structuredClone(CURRENT)
  const manifest = structuredClone(MANIFEST)
  mutate(checkpoint, manifest)
  assert.throws(
    () => evaluateGuard({ baseline: BASE, checkpoint, manifest, decisionsText: DECISIONS }),
    (error) => error?.code === 'UNREGISTERED_STRUCTURE',
  )
}

test('G-02：新增未登记 Agent 路由会失败', () => {
  assertUnregistered((checkpoint, manifest) => {
    checkpoint.routes.push({ method: 'GET', path: '/agent/unregistered' })
    checkpoint.routes.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)))
    manifest.checkpoint.routes = structuredClone(checkpoint.routes)
  })
})

test('G-02：新增未登记数据库迁移会失败', () => {
  assertUnregistered((checkpoint, manifest) => {
    checkpoint.migrations.push('00115_unregistered.sql')
    checkpoint.migrations.sort()
    manifest.checkpoint.migrations = structuredClone(checkpoint.migrations)
  })
})

test('G-02：新增未登记 feature flag 会失败', () => {
  assertUnregistered((checkpoint, manifest) => {
    checkpoint.flags.names.push('unregistered_flag')
    checkpoint.flags.names.sort()
    manifest.checkpoint.flags.names = structuredClone(checkpoint.flags.names)
  })
})

test('G-02：Shell 一级导航/分组变化会失败', () => {
  assertUnregistered((checkpoint, manifest) => {
    checkpoint.shell.nav[0] = { ...checkpoint.shell.nav[0], label: '未登记改名' }
    manifest.checkpoint.shell.nav = structuredClone(checkpoint.shell.nav)
  })
})

test('G-02：delta 回链不存在的 docs/90 决策会失败', () => {
  const manifest = structuredClone(MANIFEST)
  const entry = manifest.deltas.find((item) => item.decision === 'D-190')
  entry.decision = 'D-999'
  assert.throws(
    () => evaluateGuard({ baseline: BASE, checkpoint: CURRENT, manifest, decisionsText: DECISIONS }),
    (error) => error?.code === 'DECISION_NOT_FOUND',
  )
})

test('G-02：守卫 CLI 可在基线 commit 上运行', () => {
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'g02-structure-guard.mjs'), '--ref', '3e8be0c1'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /BASELINE PASS 3e8be0c1a6f9/)
})
