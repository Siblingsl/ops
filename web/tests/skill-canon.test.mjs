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
