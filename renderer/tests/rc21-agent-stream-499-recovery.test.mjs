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
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8')

function loadPure(relativePath) {
  const source = read(relativePath)
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const sandbox = { exports: {}, module: { exports: {} } }
  vm.runInNewContext(compiled, sandbox)
  return sandbox.exports
}

const {
  CLIENT_CLOSED_REQUEST_STATUS, CLIENT_CLOSED_RETRY_DELAY_MS, IDLE_EVENT_STREAM_DELAY_MS,
  ACCEPT_RETRY_MAX, isClientClosedRequest, shouldRetryAccept, idleEventStreamDelayMs,
} = loadPure('../shared/agent-stream-retry.ts')

test('RC-21 499 是客户端取消，不是业务失败', () => {
  assert.equal(CLIENT_CLOSED_REQUEST_STATUS, 499)
  assert.equal(isClientClosedRequest({ status: 499 }), true)
  assert.equal(isClientClosedRequest({ code: 'client_closed_request' }), true)
  assert.equal(isClientClosedRequest({ status: 500 }), false)
  assert.equal(isClientClosedRequest(new Error('network')), false)
  assert.equal(isClientClosedRequest(null), false)
})

test('RC-21 受理只在 499 上按幂等 request_id 重试，最多两次', () => {
  assert.equal(ACCEPT_RETRY_MAX, 2)
  assert.equal(shouldRetryAccept({ status: 499 }, 0), true)
  assert.equal(shouldRetryAccept({ status: 499 }, 1), true)
  assert.equal(shouldRetryAccept({ status: 499 }, 2), false)
  assert.equal(shouldRetryAccept({ status: 500 }, 0), false)
  assert.equal(shouldRetryAccept(new Error('network'), 0), false)
  assert.equal(CLIENT_CLOSED_RETRY_DELAY_MS, 250)
})

test('RC-21 空闲事件流延迟启动，活跃运行立即启动', () => {
  assert.equal(IDLE_EVENT_STREAM_DELAY_MS, 250)
  assert.equal(idleEventStreamDelayMs(false), IDLE_EVENT_STREAM_DELAY_MS)
  assert.equal(idleEventStreamDelayMs(true), 0)
})

test('RC-21 事件流把 499 走快照重连，不再抛成错误卡', () => {
  const source = read('../shared/agent-events.ts')
  assert.match(source, /isClientClosedRequest\(error\)/)
  assert.match(source, /needsSnapshot = true/)
  assert.match(source, /CLIENT_CLOSED_RETRY_DELAY_MS/)
  assert.match(source, /CLIENT_CLOSED_RETRY_DELAY_MS \* 2 \*\*/)
  assert.ok(source.indexOf('isClientClosedRequest(error)') < source.indexOf('error instanceof ApiError && error.status !== 0'))
  assert.doesNotMatch(source, /__rc21StreamLog|dbg\('catch'/)
})

test('RC-21 消费端保留 request_id 重试并防止残留运行态', () => {
  const source = read('pages/agent/useAgentRun.ts')
  assert.match(source, /postAcceptance<AgentRunAcceptance>/)
  assert.match(source, /request_id: requestID, protocol_version: 2/)
  assert.match(source, /if \(!acceptedRequest\) setCompletedNotice\('发送请求已取消，请重新发送'\)/)
  assert.match(source, /active_run: null/)
  assert.match(source, /setTimeout\(startStream, startDelay\)/)
  assert.match(source, /if \(startTimer !== undefined\) window\.clearTimeout\(startTimer\)/)
})

test('RC-21 发送与事件刷新不得取消在途详情 GET（避免 499 取消风暴）', () => {
  const source = read('pages/agent/useAgentRun.ts')
  assert.doesNotMatch(source, /qc\.cancelQueries\(/)
  const detailInvalidations = source.match(/invalidateQueries\(\{ queryKey: \['agent-conversation',[^)]*\}, \{ cancelRefetch: false \}\)/g) || []
  assert.ok(detailInvalidations.length >= 8, `expected >=8 non-cancelling invalidations, got ${detailInvalidations.length}`)
})

