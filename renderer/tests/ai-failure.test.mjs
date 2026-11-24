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
const source = readFileSync(join(root, '../shared/ai-failure.ts'), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const sandbox = { exports: {}, module: { exports: {} } }
vm.runInNewContext(compiled, sandbox)
const { isModelFailure, modelFailureHint, modelFailureActionLabel } = sandbox.exports.modelFailureHint
  ? sandbox.exports
  : sandbox.module.exports

test('OPT-A01 403/429/超时都归入模型失败并给出中文原因', () => {
  for (const code of ['ai_key_invalid', 'ai_rate_limited', 'ai_timeout', 'ai_upstream_error']) {
    assert.equal(isModelFailure(code), true)
    assert.match(modelFailureHint(code), /模型|密钥|限流|超时/)
  }
  assert.equal(isModelFailure('ai_not_configured'), false)
})

test('OPT-A01 没有备用模型时按钮直达模型配置', () => {
  assert.equal(modelFailureActionLabel('ai_key_invalid', false), '打开模型配置')
  assert.equal(modelFailureActionLabel('ai_rate_limited', false), '打开模型配置')
  assert.equal(modelFailureActionLabel('ai_timeout', true), '换备用模型')
})
