import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = fs.readFileSync(new URL('../src/lib/skill-canon.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText

const sandbox = { exports: {}, require, console, TextEncoder, TextDecoder, crypto: globalThis.crypto }
vm.runInNewContext(compiled, sandbox)
const { canonicalJSON, publishDigest } = sandbox.exports

test('TestSkillCanonicalJSONAndHashMatchGoVector', async () => {
  const input = { b: '<>&/\n', a: '中😀' }
  assert.equal(canonicalJSON(input), '{"a":"中😀","b":"<>&/\\u000a"}')
  assert.equal(await sandbox.exports.canonHash(input), '32ef59ea492c258f2f5ba065bebbccab8aa775accc46aa804dbe55431e270abf')
  assert.equal(canonicalJSON({ s: 'a"\\<>&/' }), '{"s":"a\\"\\\\<>&/"}')
})

test('TestSkillCanonicalJSONRecursiveKeyOrderAndIntegerBoundary', () => {
  assert.equal(canonicalJSON({ Z: 1, a: 2, 中: 3, B: { y: 1, X: 2 } }), '{"B":{"X":2,"y":1},"Z":1,"a":2,"中":3}')
  assert.equal(canonicalJSON({ '😀': 1, '\ue000': 2 }), '{"":2,"😀":1}')
  assert.throws(() => canonicalJSON({ f: 1.5 }), /浮点数/)
})

test('TestSkillPublishDigestNormalizesFieldsAndCoversTarget', async () => {
  const target = { operation: 'create', skillId: null, scope: 'workspace', accountId: null }
  const fields = { name: ' 中文 ', summary: '说明', triggers: '触发', instructions: '第一行\r\n第二行', platforms: ['xhs', 'wechat_mp', 'xhs'], content_formats: [], task_types: ['title', 'summary', 'title'], task_enabled: true, agent_enabled: false, status: 'active' }
  const normalized = { ...fields, name: '中文', instructions: '第一行\n第二行', platforms: ['wechat_mp', 'xhs'], task_types: ['summary', 'title'] }
  assert.equal(await publishDigest(target, fields), await publishDigest(target, normalized))
  assert.notEqual(await publishDigest(target, fields), await publishDigest({ ...target, scope: 'account', accountId: '00000000-0000-0000-0000-000000000001' }, fields))
  assert.notEqual(await publishDigest(target, fields), await publishDigest(target, { ...fields, instructions: '不同正文' }))
})

test('TestSkillNormalizationPreservesInstructionWhitespaceAndEmoji', () => {
  const normalized = sandbox.exports.normalizeDefinitionFields({ name: '\u3000名称\u3000', summary: '说明\r', triggers: '触发 ', instructions: '  😀\r\n\r末尾  ', platforms: [], content_formats: [], task_types: [], task_enabled: false, agent_enabled: true, status: 'disabled' })
  assert.equal(normalized.name, '名称')
  assert.equal(normalized.instructions, '  😀\n\n末尾  ')
  assert.equal(normalized.task_enabled, false)
  assert.equal(normalized.status, 'disabled')
})

test('TestSkillWhitespaceUsesUnicodeWhiteSpaceLikeGo', () => {
  const base = { name: '\u0085名\u0085', summary: '\ufeff说明\ufeff', triggers: '\u2000触发\u3000', instructions: '正文', platforms: [], content_formats: [], task_types: [], task_enabled: true, agent_enabled: true, status: 'active' }
  const normalized = sandbox.exports.normalizeDefinitionFields(base)
  assert.equal(normalized.name, '名')
  assert.equal(normalized.summary, '\ufeff说明\ufeff')
  assert.equal(normalized.triggers, '触发')
})

// DEV-SK4 修复：导入预览编辑后保存必须用最终表单重序列化（4.2 节第 5 项）。
// 序列化格式与服务端 exportSkillMarkdown 同契约：JSON 双引号标量是合法 YAML。
test('serializeSkillMarkdown round-trips edited fields', () => {
  const { serializeSkillMarkdown } = sandbox.exports
  const BS = String.fromCharCode(92)
  const NL = String.fromCharCode(10)
  const md = serializeSkillMarkdown({
    name: '编辑后的名称',
    summary: '含"引号"与' + BS + '反斜杠',
    triggers: '触发：条件',
    instructions: '正文第一行' + NL + NL + '---' + NL + NL + '水平线',
    platforms: ['xhs', 'wechat_mp'],
    content_formats: [],
    task_types: ['title'],
    task_enabled: false,
    agent_enabled: true,
    status: 'active',
  })
  const lines = md.split(NL)
  assert.equal(lines[0], '---')
  assert.equal(lines[1], 'format_version: 1')
  // JSON 双引号标量：服务端 YAML 解析得到原文。
  assert.ok(md.includes('name: "编辑后的名称"'))
  assert.ok(md.includes('summary: "含' + BS + '"引号' + BS + '"与' + BS + BS + '反斜杠"'))
  assert.ok(md.includes('platforms: ["wechat_mp","xhs"]'))
  assert.ok(md.includes('task_enabled: false'))
  assert.ok(md.includes('agent_enabled: true'))
  // 正文（含水平线）原样在关闭分隔行之后。
  assert.ok(md.endsWith('正文第一行' + NL + NL + '---' + NL + NL + '水平线'))
})
