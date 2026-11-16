import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const source = readFileSync(join(root, 'shared/page-poll.ts'), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const sandbox = { exports: {}, module: { exports: {} } }
vm.runInNewContext(compiled, sandbox)
const { pagePollIntervalMs } = sandbox.exports.pagePollIntervalMs !== undefined
  ? sandbox.exports
  : sandbox.module.exports

test('DEV-P08：隐藏页无请求', () => {
  assert.equal(pagePollIntervalMs(false, 5000), false)
  assert.equal(pagePollIntervalMs(false, 5000, 3), false)
})

test('DEV-P08：可见时失败指数退避并封顶', () => {
  assert.equal(pagePollIntervalMs(true, 5000, 0), 5000)
  assert.equal(pagePollIntervalMs(true, 5000, 1), 10_000)
  assert.equal(pagePollIntervalMs(true, 5000, 2), 20_000)
  assert.equal(pagePollIntervalMs(true, 5000, 3), 40_000)
  assert.equal(pagePollIntervalMs(true, 5000, 4), 60_000)
  assert.equal(pagePollIntervalMs(true, 2000, 1), 4000)
  assert.equal(pagePollIntervalMs(true, 2000, 10, 30_000), 30_000)
})

test('DEV-P08：非法 base 不轮询', () => {
  assert.equal(pagePollIntervalMs(true, 0), false)
  assert.equal(pagePollIntervalMs(true, -1), false)
})
