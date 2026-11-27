import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const here = path.dirname(fileURLToPath(import.meta.url))
const rendererRoot = path.resolve(here, '..')
const require = createRequire(import.meta.url)
const ts = require('typescript')

function read(relative) {
  return fs.readFileSync(path.join(rendererRoot, relative), 'utf8')
}

function loadModelExecutionGuard() {
  const source = read('lib/model-execution-guard.ts')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const exports = {}
  const module = { exports }
  vm.runInNewContext(compiled, { exports, module, URL })
  return exports
}

const guard = loadModelExecutionGuard()
const modelsSource = read('pages/settings/Models.tsx')
const desktopPolicySource = read('pages/settings/DesktopPolicy.tsx')

test('D-227：isLoopbackHost 与 isLoopbackBaseUrl 准确识别回环与公网地址', () => {
  for (const url of [
    'http://127.0.0.1:3425',
    'http://127.0.0.1:3425/v1',
    '127.0.0.1:3425',
    'http://localhost:11434/v1',
    'http://[::1]:8000/v1',
    'http://0.0.0.0:8080/v1',
    'http://api.localhost:3000/v1',
  ]) {
    assert.equal(guard.isLoopbackBaseUrl(url), true, `应识别为回环地址: ${url}`)
  }

  for (const url of [
    'https://api.deepseek.com/v1',
    'https://dashscope.aliyuncs.com/compatible-mode/v1',
    '',
    '   ',
    'not a url',
    'http://127.0.0.999:3425',
  ]) {
    assert.equal(guard.isLoopbackBaseUrl(url), false, `不应识别为回环地址: ${url}`)
  }

  assert.equal(guard.isLoopbackHost('[::1]'), true)
  assert.equal(guard.isLoopbackHost('127.255.0.1'), true)
  assert.equal(guard.isLoopbackHost('127.0.0.256'), false)
})

test('D-227：isRemoteApiOrigin 与 shouldWarnRemoteLoopback 仅在远程后端 + 回环地址时提醒', () => {
  assert.equal(guard.isRemoteApiOrigin('https://ops-api.88813888.xyz'), true)
  assert.equal(guard.isRemoteApiOrigin('', 'ops-desktop://business'), true)
  assert.equal(guard.isRemoteApiOrigin('', 'http://127.0.0.1:5287'), false)

  assert.equal(guard.shouldWarnRemoteLoopback('http://127.0.0.1:3425/v1', 'https://ops-api.88813888.xyz'), true)
  assert.equal(guard.shouldWarnRemoteLoopback('http://localhost:11434/v1', '', 'ops-desktop://business'), true)
  assert.equal(guard.shouldWarnRemoteLoopback('http://127.0.0.1:3425/v1', '', 'http://127.0.0.1:5287'), false)
  assert.equal(guard.shouldWarnRemoteLoopback('https://api.deepseek.com/v1', 'https://ops-api.88813888.xyz'), false)
})

test('D-227：Models 页与弹窗含执行位置切换、回环防呆与清草稿守卫', () => {
  assert.match(modelsSource, /data-testid="model-execution-location-bar"/)
  assert.match(modelsSource, /data-testid="model-dialog-execution-switch"/)
  assert.match(modelsSource, /data-testid="model-loopback-warning"/)
  assert.match(modelsSource, /const clearDraft = useSettingsDraft\(/)
  assert.match(modelsSource, /clearDraft\(\)\s*[\r\n]+\s*onClose\(\)\s*[\r\n]+\s*onGoLocalAI\(\)/)
  assert.match(modelsSource, /enabled:\s*desktop && !!me\?\.workspace\.id && !me\.admin_override/)
})

test('D-227：DesktopPolicy 页含跳转本机 AI 配置与系统管理入口', () => {
  assert.match(desktopPolicySource, /navigate\('\/settings\/local\/ai'\)/)
  assert.match(desktopPolicySource, /navigate\('\/settings\/admin'\)/)
})
