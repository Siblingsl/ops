import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

/** DEV-P09 全链路：经真实 api.ts → shouldRetryGet/getRetryDelayMs → mock fetch。 */

async function withApiModule(run) {
  const previousFetch = globalThis.fetch
  const previousWindow = globalThis.window
  if (!globalThis.window) globalThis.window = globalThis
  const server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, ws: false },
    appType: 'custom',
    define: { __OPS_API_BASE__: JSON.stringify('') },
  })
  try {
    const mod = await server.ssrLoadModule('/src/lib/api.ts')
    await run(mod)
  } finally {
    await server.close()
    globalThis.fetch = previousFetch
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
}

function jsonResponse(status, body, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

test('DEV-P09 全链路：GET 连续 503 在上限内重试后成功', async () => {
  await withApiModule(async ({ get, ApiError }) => {
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init?.method })
      if (calls.length < 3) {
        return jsonResponse(503, {}, { 'Retry-After': '0', 'X-Request-ID': `req-fail-${calls.length}` })
      }
      return jsonResponse(200, { ok: true }, { 'X-Request-ID': 'req-ok' })
    }
    const data = await get('/health')
    assert.deepEqual(data, { ok: true })
    assert.equal(calls.length, 3)
    assert.ok(calls.every((c) => c.method === 'GET'))
    assert.ok(calls.every((c) => c.url.includes('/api/v1/health')))
    assert.equal(ApiError.name, 'ApiError')
  })
})

test('DEV-P09 全链路：GET 耗尽重试后抛错且调用次数=1+GET_RETRY_MAX', async () => {
  await withApiModule(async ({ get, ApiError }) => {
    const calls = []
    globalThis.fetch = async (_url, init) => {
      calls.push(init?.method)
      return jsonResponse(503, {}, { 'Retry-After': '0' })
    }
    await assert.rejects(() => get('/boom'), (err) => err instanceof ApiError && err.status === 503)
    assert.equal(calls.length, 3) // attempt 0,1 可重试；attempt 2 抛出
    assert.ok(calls.every((m) => m === 'GET'))
  })
})

test('DEV-P09 全链路：POST 遇 503 不重试', async () => {
  await withApiModule(async ({ post, ApiError }) => {
    let calls = 0
    globalThis.fetch = async (_url, init) => {
      calls++
      assert.equal(init?.method, 'POST')
      return jsonResponse(503, {}, { 'Retry-After': '0' })
    }
    await assert.rejects(() => post('/x', { a: 1 }), (err) => err instanceof ApiError && err.status === 503)
    assert.equal(calls, 1)
  })
})

test('DEV-P09 全链路：GET 尊重 Retry-After 秒并仍成功', async () => {
  await withApiModule(async ({ get }) => {
    const calls = []
    const sleeps = []
    const realSetTimeout = globalThis.setTimeout.bind(globalThis)
    globalThis.setTimeout = (fn, ms, ...args) => {
      sleeps.push(ms)
      // 只压缩重试等待；保留 fetchResponse 的 30s 总超时定时器，否则会立刻 abort。
      return realSetTimeout(fn, ms >= 10_000 ? ms : 0, ...args)
    }
    try {
      globalThis.fetch = async () => {
        calls.push(Date.now())
        if (calls.length === 1) return jsonResponse(503, {}, { 'Retry-After': '2' })
        return jsonResponse(200, { ok: true })
      }
      await get('/retry-after')
      assert.equal(calls.length, 2)
      assert.ok(sleeps.includes(2000), `expected 2000ms Retry-After sleep, got ${sleeps}`)
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })
})
