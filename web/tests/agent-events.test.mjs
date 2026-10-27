import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = fs.readFileSync(new URL('../src/lib/agent-events.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code }
}

function load(rawRequest) {
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  const window = Object.assign(new EventTarget(), { setTimeout, clearTimeout, setInterval, clearInterval })
  const sandbox = { exports: {}, require: (name) => name === './api' ? { ApiError, rawRequest } : require(name),
    document, window, navigator: { onLine: true }, AbortController, AbortSignal, DOMException, TextDecoder, URLSearchParams }
  vm.runInNewContext(compiled, sandbox)
  return { stream: sandbox.exports.streamAgentEvents, document }
}

function event(seq, type, data = {}, runID = 'wanted') {
  return `id: ${seq}\r\nevent: ${type}\r\ndata: ${JSON.stringify({ event_seq: seq, conversation_id: 'private', run_id: runID, type, data })}\r\n\r\n`
}

function response(text) {
  const bytes = new TextEncoder().encode(text)
  return new Response(new ReadableStream({ start(controller) {
    // 跨UTF-8字符、CRLF和事件边界分片。
    for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.slice(offset, offset + 3))
    controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream' } })
}

test('AW06 reconnect replays only newer events and only the requested run can end the subscription', async () => {
  const requests = []
  const seen = []
  let snapshots = 0
  const bodies = [event(1, 'run.started') + event(2, 'message.delta', { text: '中文' })
    + event(2, 'message.delta', { text: '重复' }) + event(1, 'message.delta', { text: '乱序' })
    + event(3, 'future.event') + event(4, 'run.ended', { status: 'completed' }, 'other'),
  event(5, 'run.ended', { status: 'completed' })]
  const { stream } = load(async (method, path) => {
    assert.equal(method, 'GET', '重连不得重发用户POST')
    requests.push(path)
    return response(bodies.shift())
  })
  const result = await stream('/api/v1/agent/conversations/private/events', 0, {
    signal: AbortSignal.timeout(2000), runID: 'wanted', onEvent: (_, value) => seen.push(value),
    onResume: async () => { snapshots++; return { after: 0 } },
  })
  assert.equal(result.status, 'completed')
  assert.deepEqual(seen.map((item) => item.event_seq), [1, 2, 3, 4, 5])
  assert.equal(seen[1].data.text, '中文')
  assert.equal(snapshots, 1, '开始订阅时读取一次快照，正常断线只重放新事件')
  assert.deepEqual(requests, ['/agent/conversations/private/events?after_event_seq=0', '/agent/conversations/private/events?after_event_seq=4'])
})

test('AW06 expired cursor is surfaced without retrying or posting', async () => {
  let requests = 0
  const { stream } = load(async () => { requests++; throw new ApiError(410, 'agent_event_cursor_expired', 'expired') })
  await assert.rejects(stream('/agent/conversations/private/events', 0, {
    signal: AbortSignal.timeout(2000), runID: 'wanted', onEvent() {}, onResume: async () => ({ after: 0 }),
  }), (error) => error.code === 'agent_event_cursor_expired')
  assert.equal(requests, 1)
})

test('AW06 a terminal snapshot closes a run subscription whose cursor already passed its end event', async () => {
  let requests = 0
  const { stream } = load(async () => {
    requests++
    throw new ApiError(422, 'unexpected_stream', '终态快照之后不应再等待事件')
  })
  const result = await stream('/agent/conversations/private/events', 14, {
    signal: AbortSignal.timeout(2000), runID: 'wanted', onEvent() {},
    onResume: async () => ({ after: 14, ended: { status: 'awaiting_confirmation' } }),
  })
  assert.equal(result.status, 'awaiting_confirmation')
  assert.equal(requests, 0)
})

test('AW06 a transient initial snapshot failure retries before opening the event stream', async () => {
  let snapshots = 0
  const requests = []
  const { stream } = load(async (_, path) => { requests.push(path); return response(event(15, 'run.ended', { status: 'completed' })) })
  const result = await stream('/agent/conversations/private/events', 12, {
    signal: AbortSignal.timeout(2000), runID: 'wanted', onEvent() {},
    onResume: async () => {
      snapshots++
      if (snapshots === 1) throw new ApiError(503, 'unavailable', '临时不可用')
      return { after: 14 }
    },
  })
  assert.equal(result.status, 'completed')
  assert.equal(snapshots, 2)
  assert.deepEqual(requests, ['/agent/conversations/private/events?after_event_seq=14'])
})

test('AW06 returning to a hidden page reads a snapshot before reconnecting and can discover a completed run', async () => {
  let snapshots = 0
  let requests = 0
  const { stream, document } = load(async () => { requests++; throw new Error('快照已包含终态，无须连接') })
  document.visibilityState = 'hidden'
  const pending = stream('/agent/conversations/private/events', 1, {
    signal: AbortSignal.timeout(2000), runID: 'wanted', onEvent() {},
    onResume: async () => { snapshots++; return { after: 8, ended: { status: 'stopped' } } },
  })
  document.visibilityState = 'visible'
  document.dispatchEvent(new Event('visibilitychange'))
  assert.equal((await pending).status, 'stopped')
  assert.equal(snapshots, 1)
  assert.equal(requests, 0)
})
