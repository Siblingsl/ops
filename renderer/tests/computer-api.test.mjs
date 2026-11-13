import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'
import { sharedNpmAliases } from '../../shared/vite-dep-alias.mjs'

/** DEV-CU P5-1（docs/36 §4.2 / §4.11 / §4.12）：渲染器 computer 客户端契约。 */

async function withComputerApi(run) {
  const previousFetch = globalThis.fetch
  const previousWindow = globalThis.window
  if (!globalThis.window) globalThis.window = globalThis
  const server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, ws: false },
    appType: 'custom',
    define: { __OPS_API_BASE__: JSON.stringify('') },
    resolve: {
      alias: [
        { find: /^@\//, replacement: '/' },
        ...Object.entries(sharedNpmAliases(import.meta.url)).map(([find, replacement]) => ({ find, replacement })),
      ],
    },
  })
  try {
    const mod = await server.ssrLoadModule('/lib/computer-api.ts')
    const apiMod = await server.ssrLoadModule('/lib/api.ts')
    await run(mod, apiMod)
  } finally {
    await server.close()
    globalThis.fetch = previousFetch
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('P5-1：错误码表恰好覆盖 §4.2 的 16 个码，且不含 unknown 兜底码', async () => {
  await withComputerApi(async ({ COMPUTER_ERROR_CODES }) => {
    assert.equal(COMPUTER_ERROR_CODES.length, 16)
    assert.equal(new Set(COMPUTER_ERROR_CODES).size, 16)
    assert.deepEqual([...COMPUTER_ERROR_CODES], [
      'computer_stale_ref',
      'computer_ambiguous_target',
      'computer_target_changed',
      'computer_approval_conflict',
      'computer_foreground_busy',
      'computer_action_not_supported',
      'computer_ui_unsupported',
      'computer_action_failed',
      'computer_app_unresponsive',
      'computer_timeout',
      'computer_policy_denied',
      'computer_scope_denied',
      'computer_device_offline',
      'computer_budget_exceeded',
      'computer_invalid_args',
      'computer_internal',
    ])
    assert.ok(COMPUTER_ERROR_CODES.every((code) => code !== 'unknown' && code.startsWith('computer_')))
  })
})

test('P5-1：16 个码各有独立中文提示，不存在共用兜底句', async () => {
  await withComputerApi(async ({ COMPUTER_ERROR_CODES, COMPUTER_ERROR_HINTS }) => {
    assert.deepEqual(Object.keys(COMPUTER_ERROR_HINTS).sort(), [...COMPUTER_ERROR_CODES].sort())
    const hints = Object.values(COMPUTER_ERROR_HINTS)
    assert.equal(hints.length, 16)
    for (const hint of hints) {
      assert.ok(hint.length > 6, '提示不能为空泛短语')
      assert.match(hint, /[\u4e00-\u9fa5]/, '提示必须是中文')
      assert.doesNotMatch(hint, /未知错误|unknown/)
    }
    // 独立文案：任意两条不得相同（共用兜底会掩盖真实原因）。
    assert.equal(new Set(hints).size, 16)
  })
})

test('P5-1：computerErrorHint 已知码给中文提示，表外码原样透出服务端 message', async () => {
  await withComputerApi(async ({ computerErrorCode, computerErrorHint }, { ApiError }) => {
    const stale = new ApiError(409, 'computer_stale_ref', '目标已变化，请重新观察', undefined, 'req-000000000001')
    assert.equal(computerErrorCode(stale), 'computer_stale_ref')
    assert.equal(computerErrorHint(stale), '目标已变化，需要重新观察后再操作。')

    const busy = new ApiError(409, 'computer_foreground_busy', '前台正被占用')
    assert.equal(computerErrorHint(busy), '前台正被其它任务占用（浏览器协作或已有前台授权）；先停止它再选择。')

    // 表外码不吞：返回服务端 message（含请求 ID 后缀），不能替换成通用文案。
    const tableMiss = new ApiError(502, 'gateway_side_error', '上游网关返回 502', undefined, 'req-abcdef123456')
    assert.equal(computerErrorCode(tableMiss), '')
    assert.match(computerErrorHint(tableMiss), /上游网关返回 502/)
    assert.match(computerErrorHint(tableMiss), /abcdef123456/)

    assert.equal(computerErrorHint(new Error('网络已断开')), '网络已断开')
    assert.equal(computerErrorCode({ code: 'computer_internal' }), '')
  })
})

test('P5-1：错误策略表只声明重新观察与等待时长，不声明自动重试', async () => {
  await withComputerApi(async ({ COMPUTER_ERROR_CODES, COMPUTER_ERROR_POLICY }) => {
    assert.deepEqual(Object.keys(COMPUTER_ERROR_POLICY).sort(), [...COMPUTER_ERROR_CODES].sort())
    for (const code of COMPUTER_ERROR_CODES) {
      assert.deepEqual(Object.keys(COMPUTER_ERROR_POLICY[code]).sort(), ['requiresFreshSnapshot', 'retryAfterMs'])
    }
    for (const code of ['computer_stale_ref', 'computer_ambiguous_target', 'computer_target_changed', 'computer_app_unresponsive', 'computer_timeout']) {
      assert.equal(COMPUTER_ERROR_POLICY[code].requiresFreshSnapshot, true, code)
    }
    assert.equal(COMPUTER_ERROR_POLICY.computer_app_unresponsive.retryAfterMs, 250)
    assert.equal(COMPUTER_ERROR_POLICY.computer_timeout.retryAfterMs, 250)
    for (const code of ['computer_policy_denied', 'computer_scope_denied', 'computer_invalid_args', 'computer_internal']) {
      assert.equal(COMPUTER_ERROR_POLICY[code].requiresFreshSnapshot, false, code)
      assert.equal(COMPUTER_ERROR_POLICY[code].retryAfterMs, null, code)
    }
  })
})

test('P5-1：无桌面桥时本机三意图如实报 computer_ui_unsupported，不抛错也不伪造成功', async () => {
  await withComputerApi(async ({ computerApi }) => {
    const saved = globalThis.window.opsDesktopUI
    delete globalThis.window.opsDesktopUI
    try {
      const observed = await computerApi.local.observe({
        pid: 1, target_summary: '记事本', grant_id: 'g-1', generation: 0,
      })
      assert.equal(observed.ok, false)
      assert.equal(observed.code, 'computer_ui_unsupported')
      const acted = await computerApi.local.act({
        pid: 1, ref: '@s1abc:e1', grant_id: 'g-1', generation: 0, action: 'Click', target_summary: '记事本',
      })
      assert.equal(acted.ok, false)
      assert.equal(acted.code, 'computer_ui_unsupported')
      const invalidated = await computerApi.local.invalidate('g-1')
      assert.equal(invalidated.ok, false)
      assert.equal(invalidated.code, 'computer_ui_unsupported')
    } finally {
      if (saved !== undefined) globalThis.window.opsDesktopUI = saved
    }
  })
})

test('P5-1：本机三意图直通桌面桥，入参原样透传', async () => {
  await withComputerApi(async ({ computerApi }) => {
    const calls = []
    const saved = globalThis.window.opsDesktopUI
    globalThis.window.opsDesktopUI = {
      async observeComputerUIA(input) {
        calls.push({ channel: 'observe', input })
        return { ok: false, code: 'computer_stale_ref', message: '目标已变化' }
      },
      async actComputerUIA(input) {
        calls.push({ channel: 'act', input })
        return { ok: true, action: input.action, disposition: { delivery: 'delivered_verified', retry: 'unsafe' } }
      },
      async invalidateComputerUIA(grantId) {
        calls.push({ channel: 'invalidate', grantId })
        return { ok: true, cleared: 2 }
      },
    }
    try {
      const observed = await computerApi.local.observe({
        pid: 42, target_summary: '记事本', grant_id: 'g-1', generation: 3, max_depth: 4,
      })
      assert.equal(observed.ok, false)
      const acted = await computerApi.local.act({
        pid: 42, ref: '@s1abc:e1', grant_id: 'g-1', generation: 3, action: 'SetValue', value: '你好', target_summary: '记事本',
      })
      assert.equal(acted.ok, true)
      assert.deepEqual(await computerApi.local.invalidate('g-1'), { ok: true, cleared: 2 })
      assert.deepEqual(calls.map((c) => c.channel), ['observe', 'act', 'invalidate'])
      assert.equal(calls[0].input.max_depth, 4)
      assert.equal(calls[1].input.value, '你好')
      assert.equal(calls[2].grantId, 'g-1')
    } finally {
      if (saved === undefined) delete globalThis.window.opsDesktopUI
      else globalThis.window.opsDesktopUI = saved
    }
  })
})

test('P5-1：服务端封装只用 §4.11 已登记路径', async () => {
  await withComputerApi(async ({ computerApi }) => {
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
      return jsonResponse(200, {})
    }
    await computerApi.createGrant('00000001-1111-4111-8111-111111111111', {
      target_handle: 'a'.repeat(32), target_summary: 'notepad · 草稿', scope: 'act',
      request_id: '00000002-1111-4111-8111-111111111111',
    })
    await computerApi.listGrants('00000001-1111-4111-8111-111111111111')
    await computerApi.handoff('00000003-1111-4111-8111-111111111111')
    await computerApi.revoke('00000003-1111-4111-8111-111111111111')
    await computerApi.deviceAck('00000003-1111-4111-8111-111111111111')
    await computerApi.createCommand({
      run_id: '00000004-1111-4111-8111-111111111111',
      grant_id: '00000003-1111-4111-8111-111111111111',
      request_id: '00000005-1111-4111-8111-111111111111',
      action_kind: 'type', payload: { ref: '@s1abc:e1', text: '你好' },
      expected_generation: 2,
      card_id: '00000006-1111-4111-8111-111111111111', approval_hash: 'f'.repeat(64),
    })
    await computerApi.commands('00000004-1111-4111-8111-111111111111')
    await computerApi.capabilities()
    assert.deepEqual(calls.map((c) => [c.method, c.url.replace(/^http:\/\/[^/]+/, '')]), [
      ['POST', '/api/v1/agent/conversations/00000001-1111-4111-8111-111111111111/computer-grants'],
      ['GET', '/api/v1/agent/computer-grants?conversation_id=00000001-1111-4111-8111-111111111111'],
      ['POST', '/api/v1/agent/computer-grants/00000003-1111-4111-8111-111111111111/handoff'],
      ['DELETE', '/api/v1/agent/computer-grants/00000003-1111-4111-8111-111111111111'],
      ['POST', '/api/v1/agent/computer/grants/00000003-1111-4111-8111-111111111111/device-ack'],
      ['POST', '/api/v1/agent/computer/commands'],
      ['GET', '/api/v1/agent/computer/commands?run_id=00000004-1111-4111-8111-111111111111'],
      ['GET', '/api/v1/agent/computer/capabilities'],
    ])
    // 写类载荷必须带卡片与批准哈希（红线 2），不做任何字段删除。
    const commandBody = JSON.parse(calls[5].body)
    assert.equal(commandBody.card_id, '00000006-1111-4111-8111-111111111111')
    assert.equal(commandBody.approval_hash, 'f'.repeat(64))
  })
})

test('P5-1：客户端不暴露任何批量 / 全部执行入口（红线 1 的渲染器侧）', async () => {
  await withComputerApi(async ({ computerApi }) => {
    const names = Object.keys(computerApi)
    for (const name of names) {
      assert.doesNotMatch(name, /batch|all|execute_all|bulk/i, name)
    }
    assert.deepEqual(names.sort(), [
      'capabilities', 'commands', 'createCommand', 'createGrant', 'deviceAck',
      'handoff', 'listGrants', 'local', 'revoke',
    ])
  })
})
