import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = readFileSync(new URL('../lib/api-retry.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const sandbox = { exports: {}, module: { exports: {} } }
vm.runInNewContext(compiled, sandbox)
const mod = sandbox.exports.GET_RETRY_MAX !== undefined ? sandbox.exports : sandbox.module.exports
const { GET_RETRY_MAX, shouldRetryGet, getRetryDelayMs } = mod

test('DEV-P09 shouldRetryGet：仅 GET + 网关状态 + 上限内', () => {
  assert.equal(GET_RETRY_MAX, 2)
  assert.equal(shouldRetryGet('GET', 0, 503), true)
  assert.equal(shouldRetryGet('GET', 1, 502), true)
  assert.equal(shouldRetryGet('GET', 2, 503), false)
  assert.equal(shouldRetryGet('POST', 0, 503), false)
  assert.equal(shouldRetryGet('GET', 0, 500), false)
})

test('DEV-P09 getRetryDelayMs：指数退避与 Retry-After', () => {
  assert.equal(getRetryDelayMs(0, null, { random: () => 0 }), 250)
  assert.equal(getRetryDelayMs(1, null, { random: () => 0 }), 500)
  assert.equal(getRetryDelayMs(0, '2', { random: () => 0 }), 2000)
  assert.equal(getRetryDelayMs(0, '999', { random: () => 0 }), 30_000)
})
