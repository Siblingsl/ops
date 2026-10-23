import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = fs.readFileSync(new URL('../src/lib/desktop-platform-intent.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText

function harness({ bridge = true, openError } = {}) {
  const listeners = new Set()
  const timers = new Map()
  const opened = []
  const exports = {}
  const window = {
    opsDesktopUI: bridge ? { onPlatformIntentResult(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    } } : undefined,
    setTimeout(callback, ms) { timers.set(1, { callback, ms }); return 1 },
    clearTimeout(id) { timers.delete(id) },
    open(url) { if (openError) throw openError; opened.push(url) },
  }
  vm.runInNewContext(compiled, { exports, window, Error, crypto: { randomUUID: () => 'request-fixture' } })
  return { request: exports.requestDesktopPlatformIntent, listeners, timers, opened,
    emit(result) { for (const listener of [...listeners]) listener(result) } }
}

const request = { type: 'platform-account-sync', accountId: 'account-a', mode: 'incremental', connectionRevision: 7 }
const receipt = { kind: request.type, accountId: request.accountId, requestId: 'request-fixture', status: 'queued' }

test('同步请求只接受本账号、本类型、本请求的回执，完成后清理监听和超时', async () => {
  const h = harness()
  const pending = h.request(request)
  assert.equal(h.opened[0], 'ops-desktop://ui/platform-account-sync/account-a/incremental/7/request-fixture')
  for (const wrong of [{ accountId: 'account-b' }, { requestId: 'old-request' }, { kind: 'platform-metrics-refresh' }]) {
    h.emit({ ...receipt, ...wrong })
    assert.equal(h.listeners.size, 1)
  }
  h.emit(receipt)
  assert.equal((await pending).status, 'queued')
  assert.equal(h.listeners.size, 0)
  assert.equal(h.timers.size, 0)
})

test('继续同步额外核对 operationId，迟到的其他操作不会解除当前按钮等待', async () => {
  const h = harness()
  const pending = h.request({ type: 'platform-sync-resume', accountId: 'account-a', operationId: 'op-a', expectedOperationRevision: 3 })
  h.emit({ ...receipt, kind: 'platform-sync-resume', operationId: 'op-b' })
  assert.equal(h.listeners.size, 1)
  h.emit({ ...receipt, kind: 'platform-sync-resume', operationId: 'op-a' })
  assert.equal((await pending).operationId, 'op-a')
  assert.equal(h.listeners.size, 0)
})

test('无回执超时后释放等待状态；迟到成功回执不会改写结果', async () => {
  const h = harness()
  const pending = h.request(request)
  assert.equal(h.timers.get(1).ms, 35_000)
  h.timers.get(1).callback()
  await assert.rejects(pending, /等待超时/)
  h.emit(receipt)
  assert.equal(h.listeners.size, 0)
  assert.equal(h.timers.size, 0)
})

test('失败回执、打开意图异常和桥缺失都明确失败并清理资源', async () => {
  const h = harness()
  const pending = h.request(request)
  h.emit({ ...receipt, status: 'failed', message: '连接版本已变化' })
  await assert.rejects(pending, /连接版本已变化/)
  assert.equal(h.listeners.size, 0)
  assert.equal(h.timers.size, 0)
  const broken = harness({ openError: new Error('open failed') })
  await assert.rejects(broken.request(request), /open failed/)
  assert.equal(broken.listeners.size, 0)
  assert.equal(broken.timers.size, 0)
  await assert.rejects(harness({ bridge: false }).request(request), /不支持本机平台操作/)
})
