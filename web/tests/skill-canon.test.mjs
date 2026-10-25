import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = fs.readFileSync(new URL('../src/lib/skill-canon.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText

const sandbox = { exports: {}, require, console, TextEncoder, TextDecoder, crypto: globalThis.crypto }
vm.runInNewContext(compiled, sandbox)
const { canonicalJSON, publishDigest } = sandbox.exports

// DEV-SK4 / 23 文档第 5.2.1 节：前后端同一测试向量（T-SK-35，向量见 skills_canon_test.go）。
test('canonical JSON matches the contract vector', () => {
  const c = canonicalJSON({ b: '<>&/\n', a: '中😀' })
  assert.equal(c, '{"a":"中😀","b":"<>&/\\u000a"}')
})

test('keys sort by UTF-8 byte order recursively; escapes only quotes, backslash and controls', () => {
  assert.equal(canonicalJSON({ Z: 1, a: 2, 中: 3, B: { y: 1, X: 2 } }), '{"B":{"X":2,"y":1},"Z":1,"a":2,"中":3}')
  assert.equal(canonicalJSON({ s: 'a"\\<>&/' }), '{"s":"a\\"\\\\<>&/"}')
})

test('non-integer numbers are rejected', () => {
  assert.throws(() => canonicalJSON({ f: 1.5 }))
})

test('sp1 digest is deterministic and covers operation and target', async () => {
  const fields = {
    name: '名', summary: 's', triggers: 't', instructions: 'body',
    platforms: ['xhs'], content_formats: [], task_types: ['title'],
    task_enabled: true, agent_enabled: false, status: 'active',
  }
  const d1 = await publishDigest({ operation: 'create', skillId: null, scope: 'workspace', accountId: null }, fields)
  const d2 = await publishDigest({ operation: 'create', skillId: null, scope: 'workspace', accountId: null }, fields)
  assert.equal(d1, d2)
  assert.ok(d1.startsWith('sp1:'))
  const d3 = await publishDigest({ operation: 'update', skillId: '2b5c8fd6-0000-4000-8000-000000000000', scope: 'workspace', accountId: null }, fields)
  assert.notEqual(d3, d1)
})

test('digest covers normalized fields (client normalization matches server)', async () => {
  const base = {
    name: '  名  ', summary: 's', triggers: 't', instructions: 'body\r\n第二行',
    platforms: ['xhs', 'wechat_mp', 'xhs'], content_formats: [], task_types: [],
    task_enabled: true, agent_enabled: true, status: 'active',
  }
  const normalized = {
    name: '名', summary: 's', triggers: 't', instructions: 'body\n第二行',
    platforms: ['wechat_mp', 'xhs'], content_formats: [], task_types: [],
    task_enabled: true, agent_enabled: true, status: 'active',
  }
  const d1 = await publishDigest({ operation: 'create', skillId: null, scope: 'workspace', accountId: null }, base)
  const d2 = await publishDigest({ operation: 'create', skillId: null, scope: 'workspace', accountId: null }, normalized)
  assert.equal(d1, d2)
})
