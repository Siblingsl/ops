import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, '../shared/api-retry.ts'), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const sandbox = { exports: {}, module: { exports: {} } }
vm.runInNewContext(compiled, sandbox)
const { GET_RETRY_MAX, shouldRetryGet, getRetryDelayMs } = sandbox.exports.GET_RETRY_MAX !== undefined
  ? sandbox.exports
  : sandbox.module.exports

test('DEV-P09 shouldRetryGet：仅 GET + 网关状态 + 上限内', () => {
  assert.equal(GET_RETRY_MAX, 2)
  assert.equal(shouldRetryGet('GET', 0, 503), true)
  assert.equal(shouldRetryGet('GET', 1, 502), true)
  assert.equal(shouldRetryGet('GET', 2, 503), false) // 已达上限
  assert.equal(shouldRetryGet('POST', 0, 503), false)
  assert.equal(shouldRetryGet('GET', 0, 500), false)
  assert.equal(shouldRetryGet('GET', 0, 429), false)
})

test('DEV-P09 getRetryDelayMs：指数退避 + 抖动可观测', () => {
  const d0 = getRetryDelayMs(0, null, { random: () => 0 })
  const d1 = getRetryDelayMs(1, null, { random: () => 0 })
  const d2 = getRetryDelayMs(2, null, { random: () => 0 })
  assert.equal(d0, 250)
  assert.equal(d1, 500)
  assert.equal(d2, 1000)
  const withJitter = getRetryDelayMs(0, null, { random: () => 0.5 })
  assert.equal(withJitter, 250 + 50)
  const capped = getRetryDelayMs(10, null, { random: () => 0 })
  assert.equal(capped, 4000)
})

test('DEV-P09 getRetryDelayMs：Retry-After 秒与 HTTP-date', () => {
  assert.equal(getRetryDelayMs(0, '1.2', { random: () => 0 }), 1200)
  assert.equal(getRetryDelayMs(0, '999', { random: () => 0 }), 30_000)
  const now = Date.parse('Thu, 01 Jan 2026 00:00:00 GMT')
  const later = 'Thu, 01 Jan 2026 00:00:05 GMT'
  assert.equal(getRetryDelayMs(0, later, { random: () => 0, now }), 5000)
})
