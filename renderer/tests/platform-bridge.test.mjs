import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { sharedNpmAliases } from '../../shared/vite-dep-alias.mjs'

/** POLISH-01（docs/43 §1.1 第 78 行 / §1.2 第 82 行）：统一桌面桥接层契约。 */

const here = path.dirname(fileURLToPath(import.meta.url))
const rendererRoot = path.resolve(here, '..')
const npmAliases = sharedNpmAliases(import.meta.url)

async function withPlatformBridge(run) {
  const previousWindow = globalThis.window
  const previousBridge = globalThis.opsDesktopUI
  delete globalThis.window
  delete globalThis.opsDesktopUI
  const server = await createServer({
    configFile: false,
    root: rendererRoot,
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, ws: false },
    appType: 'custom',
    define: { __OPS_API_BASE__: JSON.stringify('') },
    resolve: {
      alias: [
        { find: /^@\//, replacement: '/' },
        ...Object.entries(npmAliases).map(([find, replacement]) => ({ find, replacement })),
      ],
    },
  })
  try {
    const mod = await server.ssrLoadModule('/lib/platform-bridge.ts')
    await run(mod)
  } finally {
    await server.close()
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousBridge === undefined) delete globalThis.opsDesktopUI
    else globalThis.opsDesktopUI = previousBridge
  }
}

/** 每个需要显式断言的异步意图：(名称, 调用, 是否属于 unified unsupported 结果)。 */
function intentCalls(mod) {
  const mcpOAuthInput = { connection_id: 'conn-1', server_url: 'https://mcp.example.com' }
  const uiaRead = { pid: 1, target_summary: '记事本' }
  const uiaObserve = { pid: 1, target_summary: '记事本', grant_id: 'g-1', generation: 0 }
  return [
    ['getDesktopUpdateStatus', () => mod.getDesktopUpdateStatus()],
    ['checkDesktopUpdate', () => mod.checkDesktopUpdate()],
    ['openDesktopUpdateDownload', () => mod.openDesktopUpdateDownload()],
    ['getDesktopClientDiagnostics', () => mod.getDesktopClientDiagnostics()],
    ['exportDesktopClientDiagnostics', () => mod.exportDesktopClientDiagnostics()],
    ['openDesktopPlatformLogin', () => mod.openDesktopPlatformLogin({ accountId: 'acc-1', platform: 'xhs' })],
    ['setDesktopLocalSettingsPanel', () => mod.setDesktopLocalSettingsPanel('connection')],
    ['openXhsManualImageFolder', () => mod.openXhsManualImageFolder({ workId: 'work-1', files: [] })],
    ['captureDesktopLongImage', () => mod.captureDesktopLongImage('build-1')],
    ['listDesktopComputerWindows', () => mod.listDesktopComputerWindows()],
    ['readDesktopComputerUIA', () => mod.readDesktopComputerUIA(uiaRead)],
    ['invokeDesktopComputerUIA', () => mod.invokeDesktopComputerUIA({ pid: 1, automation_id: 'a-1', target_summary: '记事本' })],
    ['observeDesktopComputerUIA', () => mod.observeDesktopComputerUIA(uiaObserve)],
    ['actDesktopComputerUIA', () => mod.actDesktopComputerUIA({ pid: 1, ref: '@r-1', grant_id: 'g-1', generation: 0, action: 'Click', target_summary: '记事本' })],
    ['invalidateDesktopComputerUIA', () => mod.invalidateDesktopComputerUIA('g-1')],
    ['listDesktopBrowserTabs', () => mod.listDesktopBrowserTabs()],
    ['focusDesktopBrowserTab', () => mod.focusDesktopBrowserTab(17)],
    ['getDesktopBrowserPairingState', () => mod.getDesktopBrowserPairingState()],
    ['confirmDesktopBrowserPairing', () => mod.confirmDesktopBrowserPairing()],
    ['validateDesktopMcpConnection', () => mod.validateDesktopMcpConnection({ connection_id: 'conn-1', transport: 'stdio' })],
    ['startDesktopMcpOAuth', () => mod.startDesktopMcpOAuth(mcpOAuthInput)],
    ['invokeDesktopInBrowse', () => mod.invokeDesktopInBrowse('inbrowse:data-stats')],
    // 规格允许的两处例外：status 约定返回 null，revoke 返回 { ok, supported? }。
    ['getDesktopMcpOAuthStatus', () => mod.getDesktopMcpOAuthStatus(mcpOAuthInput), 'null'],
    ['revokeDesktopMcpOAuth', () => mod.revokeDesktopMcpOAuth(mcpOAuthInput), 'revoke'],
  ]
}

const subscriptionCalls = (mod) => [
    ['subscribeDesktopOpenSettings', () => mod.subscribeDesktopOpenSettings(() => {})],
    ['subscribeDesktopLocalSettingsState', () => mod.subscribeDesktopLocalSettingsState(() => {})],
    ['subscribeDesktopPlatformIntentResult', () => mod.subscribeDesktopPlatformIntentResult(() => {})],
    ['subscribeDesktopClientHealth', () => mod.subscribeDesktopClientHealth(() => {})],
    ['subscribeDesktopUpdateStatus', () => mod.subscribeDesktopUpdateStatus(() => {})],
    ['subscribeDesktopInBrowseSnapshot', () => mod.subscribeDesktopInBrowseSnapshot(() => {})],
    ['subscribeDesktopRealtimeEvent', () => mod.subscribeDesktopRealtimeEvent(() => {})],
    ['subscribeDesktopSidepanelDraft', () => mod.subscribeDesktopSidepanelDraft(() => {})],
    ['subscribeDesktopSidepanelStop', () => mod.subscribeDesktopSidepanelStop(() => {})],
  ]

test('POLISH-01 测试 1：window 不存在或桥缺失时全部探针/订阅/意图安全降级', async () => {
  await withPlatformBridge(async (mod) => {
    for (const removeWindow of [true, false]) {
      if (removeWindow) {
        delete globalThis.window
      } else {
        globalThis.window = globalThis
        delete globalThis.opsDesktopUI
      }
      assert.equal(mod.getDesktopBridge(), null)
      assert.equal(mod.isDesktopBridgeAvailable(), false)
      assert.deepEqual(mod.getPlatformBridgeInfo(), { mode: 'web', isElectron: false, supported: false })
      assert.equal(mod.hasDesktopBridgeMethod('onUpdateStatus'), false)
      assert.equal(mod.hasDesktopBridgeMethod('captureLongImage'), false)

      for (const [name, subscribe] of subscriptionCalls(mod)) {
        const unsubscribe = subscribe()
        assert.equal(typeof unsubscribe, 'function', `${name} 必须返回可调用的取消函数`)
        assert.doesNotThrow(() => unsubscribe(), `${name} 的取消函数不得抛错`)
      }

      for (const [name, call, exception] of intentCalls(mod)) {
        const result = await call()
        if (exception === 'null') {
          assert.equal(result, null, `${name} 无桥时必须返回 null`)
          continue
        }
        if (exception === 'revoke') {
          assert.deepEqual(result, { ok: false, supported: false }, `${name} 无桥时必须如实返回未支持`)
          continue
        }
        assert.deepEqual(result, {
          ok: false,
          supported: false,
          code: 'desktop_only',
          message: result.message,
        }, `${name} 无桥时必须返回统一 unsupported 结果`)
        assert.equal(typeof result.message, 'string')
        assert.ok(result.message.length > 0, `${name} 必须给出可读中文提示`)
        assert.match(result.message, /[\u4e00-\u9fa5]/, `${name} 提示必须是中文`)
      }
    }
  })
})

test('POLISH-01 测试 2：注入模拟桥后探针准确、订阅可取消、代表性意图入参与返回值原样透传', async () => {
  await withPlatformBridge(async (mod) => {
    const calls = []
    const listeners = {}
    const sentinels = {
      update: { ok: true, status: { status: 'up-to-date', currentVersion: '1.0.0' } },
      diagnostics: {
        ok: true,
        diagnostics: {
          appVersion: '1.0.0', electronVersion: '44.9.1', platform: 'win32', arch: 'x64',
          connectionState: 'online', mode: 'desktop', channelState: 'ready', channelMessage: '连接正常',
          routeRevision: 2, signedIn: true, reauthRequired: false, storageAvailable: true,
          localConfigAvailable: true, deviceRegistered: true, modelCount: 1, activeModelRequests: 0,
        },
      },
      diagnosticsExport: { ok: true, canceled: false },
      platformLogin: { ok: true },
      localSettings: { ok: true },
      xhs: { ok: true, count: 1, fileNames: ['01_封面.png'] },
      windows: { ok: true, windows: [] },
      tabs: { ok: true, tabs: [] },
      mcp: { ok: true, catalog: { tools: [], server_info: { name: 'mock', version: '1.0.0', protocol_version: '2025-06-18' }, catalog_revision: 'r-1' } },
    }
    const mock = {
      onOpenSettings(listener) { listeners.openSettings = listener; return () => { delete listeners.openSettings } },
      onLocalSettingsState(listener) { listeners.localState = listener; return () => { delete listeners.localState } },
      onPlatformIntentResult(listener) { listeners.intent = listener; return () => { delete listeners.intent } },
      onClientHealth(listener) { listeners.health = listener; return () => { delete listeners.health } },
      onUpdateStatus(listener) { listeners.update = listener; return () => { delete listeners.update } },
      onInBrowseSnapshot(listener) { listeners.inBrowse = listener; return () => { delete listeners.inBrowse } },
      onRealtimeEvent(listener) { listeners.realtime = listener; return () => { delete listeners.realtime } },
      onSidepanelDraft(listener) { listeners.draft = listener; return () => { delete listeners.draft } },
      onSidepanelStop(listener) { listeners.stop = listener; return () => { delete listeners.stop } },
      async getUpdateStatus() { calls.push(['getUpdateStatus']); return sentinels.update },
      async checkUpdate() { calls.push(['checkUpdate']); return sentinels.update },
      async openUpdateDownload() { calls.push(['openUpdateDownload']); return { ok: true } },
      async getClientDiagnostics() { calls.push(['getClientDiagnostics']); return sentinels.diagnostics },
      async exportClientDiagnostics() { calls.push(['exportClientDiagnostics']); return sentinels.diagnosticsExport },
      async openPlatformLogin(input) { calls.push(['openPlatformLogin', input]); return sentinels.platformLogin },
      async setLocalSettingsPanel(action) { calls.push(['setLocalSettingsPanel', action]); return sentinels.localSettings },
      async openXhsManualImageFolder(input) { calls.push(['openXhsManualImageFolder', input]); return sentinels.xhs },
      async captureLongImage(buildId) { calls.push(['captureLongImage', buildId]); return { ok: false, code: 'capture_failed', message: '长图失败' } },
      async listComputerWindows() { calls.push(['listComputerWindows']); return sentinels.windows },
      async readComputerUIA(input) { calls.push(['readComputerUIA', input]); return { ok: false, code: 'computer_stale_ref', message: '目标已变化' } },
      async invokeComputerUIA(input) { calls.push(['invokeComputerUIA', input]); return { ok: true, action: input.action } },
      async observeComputerUIA(input) { calls.push(['observeComputerUIA', input]); return { ok: false, code: 'computer_timeout', message: '超时' } },
      async actComputerUIA(input) { calls.push(['actComputerUIA', input]); return { ok: true, action: input.action, disposition: { delivery: 'delivered_verified', retry: 'unsafe' } } },
      async invalidateComputerUIA(grantId) { calls.push(['invalidateComputerUIA', grantId]); return { ok: true, cleared: 1 } },
      async listBrowserTabs() { calls.push(['listBrowserTabs']); return sentinels.tabs },
      async focusBrowserTab(tabId) { calls.push(['focusBrowserTab', tabId]); return { ok: true, tab_id: tabId } },
      async getBrowserPairingState() { calls.push(['getBrowserPairingState']); return { ok: true, snapshot: { state: 'paired', pairing: null, extension_instance_id: 'ext-1', host_pid: 42 } } },
      async confirmBrowserPairing() { calls.push(['confirmBrowserPairing']); return { ok: true, extension_instance_id: 'ext-1' } },
      async validateMcpConnection(input) { calls.push(['validateMcpConnection', input]); return sentinels.mcp },
      async startMcpOAuth(input) { calls.push(['startMcpOAuth', input]); return { ok: true, state: 'authorizing', reason: '' } },
      async getMcpOAuthStatus(input) { calls.push(['getMcpOAuthStatus', input]); return { state: 'authorized', expires_at: null, has_refresh: false } },
      async revokeMcpOAuth(input) { calls.push(['revokeMcpOAuth', input]); return { ok: true } },
      async invokeInBrowse(channel, payload) { calls.push(['invokeInBrowse', channel, payload]); return { ok: true, echo: channel } },
    }
    globalThis.window = globalThis
    globalThis.opsDesktopUI = mock

    try {
      assert.equal(mod.isDesktopBridgeAvailable(), true)
      assert.deepEqual(mod.getPlatformBridgeInfo(), { mode: 'desktop', isElectron: false, supported: true })
      assert.equal(mod.getDesktopBridge(), mock)
      // 方法级探针区分已实现 / 未实现：整桥存在但旧宿主可能缺个别固定意图。
      assert.equal(mod.hasDesktopBridgeMethod('onUpdateStatus'), true)
      assert.equal(mod.hasDesktopBridgeMethod('checkUpdate'), true)
      assert.equal(mod.hasDesktopBridgeMethod('onOpenSettings'), true)
      const savedReadUIA = mock.readComputerUIA
      delete mock.readComputerUIA
      assert.equal(mod.hasDesktopBridgeMethod('readComputerUIA'), false, '缺失的方法必须判为未实现')
      const readUIA = await mod.readDesktopComputerUIA({ pid: 1, target_summary: '记事本' })
      assert.equal(readUIA.ok, false)
      assert.equal(readUIA.code, 'desktop_only')
      mock.readComputerUIA = savedReadUIA

      // 订阅：注册生效、取消函数可调用且取消后不再收到事件。
      let openSettingsHits = 0
      const offOpen = mod.subscribeDesktopOpenSettings(() => { openSettingsHits += 1 })
      assert.equal(typeof offOpen, 'function')
      listeners.openSettings()
      offOpen()
      assert.equal(openSettingsHits, 1)
      assert.equal(listeners.openSettings, undefined, '取消订阅必须真正解绑')

      let snapshot = null
      const offSnapshot = mod.subscribeDesktopInBrowseSnapshot((value) => { snapshot = value })
      listeners.inBrowse({ url: 'https://example.com', title: '示例', loading: false, bounds: null, navigationGeneration: 1, detached: false })
      offSnapshot()
      // 更宽的业务快照经桥接层单点泛型适配，字段原样到达业务组件。
      assert.equal(snapshot.url, 'https://example.com')
      assert.equal(snapshot.detached, false)

      // 代表性意图：入参原样透传，返回值保持同一引用（不复制、不改写）。
      assert.equal(await mod.getDesktopUpdateStatus(), sentinels.update)
      // POLISH-02：本机诊断摘要与脱敏导出原样透传（无参固定意图）。
      assert.equal(mod.hasDesktopBridgeMethod('getClientDiagnostics'), true)
      assert.equal(mod.hasDesktopBridgeMethod('exportClientDiagnostics'), true)
      assert.equal(await mod.getDesktopClientDiagnostics(), sentinels.diagnostics)
      assert.deepEqual(calls.find((call) => call[0] === 'getClientDiagnostics'), ['getClientDiagnostics'])
      assert.equal(await mod.exportDesktopClientDiagnostics(), sentinels.diagnosticsExport)
      assert.deepEqual(calls.find((call) => call[0] === 'exportClientDiagnostics'), ['exportClientDiagnostics'])
      const loginInput = { accountId: 'acc-1', platform: 'wechat_mp' }
      assert.equal(await mod.openDesktopPlatformLogin(loginInput), sentinels.platformLogin)
      assert.equal(calls.find((call) => call[0] === 'openPlatformLogin')[1], loginInput)
      assert.equal(await mod.setDesktopLocalSettingsPanel('diagnostics'), sentinels.localSettings)
      assert.equal(calls.find((call) => call[0] === 'setLocalSettingsPanel')[1], 'diagnostics')
      const xhsInput = { workId: 'work-1', files: [{ ext: 'png', bytes: new Uint8Array([1, 2, 3]) }] }
      assert.equal(await mod.openXhsManualImageFolder(xhsInput), sentinels.xhs)
      assert.equal(calls.find((call) => call[0] === 'openXhsManualImageFolder')[1], xhsInput)
      assert.equal(await mod.listDesktopComputerWindows(), sentinels.windows)
      assert.equal(await mod.listDesktopBrowserTabs(), sentinels.tabs)
      const mcpInput = { connection_id: 'conn-1', transport: 'stdio', command: 'npx', args: ['mock'] }
      assert.equal(await mod.validateDesktopMcpConnection(mcpInput), sentinels.mcp)
      assert.equal(calls.find((call) => call[0] === 'validateMcpConnection')[1], mcpInput)
      const inBrowsePayload = { dataBase64: 'AAEC' }
      assert.deepEqual(await mod.invokeDesktopInBrowse('voice:realtime-append', inBrowsePayload), { ok: true, data: { ok: true, echo: 'voice:realtime-append' } })
      assert.equal(mod.getDesktopInBrowseInvoker(), mock.invokeInBrowse)
      assert.equal(calls.find((call) => call[0] === 'invokeInBrowse')[1], 'voice:realtime-append')
      assert.equal(calls.find((call) => call[0] === 'invokeInBrowse')[2], inBrowsePayload)

      // 桥存在但返回值是业务失败时，原样透出（不伪造成功）。
      const longImage = await mod.captureDesktopLongImage('build-9')
      assert.equal(longImage.ok, false)
      assert.equal(longImage.code, 'capture_failed')
      assert.equal(longImage.message, '长图失败')
    } finally {
      delete globalThis.opsDesktopUI
      delete globalThis.window
    }
  })
})

test('POLISH-01 测试 3：业务 UI 层零直接引用 opsDesktopUI（必须 100% 经 platform-bridge）', () => {
  const roots = ['components', 'layout', 'pages']
  const offenders = []
  const walk = (relative) => {
    const absolute = path.join(rendererRoot, relative)
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(relative, entry.name)
      if (entry.isDirectory()) {
        walk(child)
        continue
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue
      const source = stripComments(fs.readFileSync(path.join(absolute, entry.name), 'utf8').replace(/\r\n/g, '\n'))
      if (source.includes('opsDesktopUI')) offenders.push(child)
    }
  }
  for (const root of roots) walk(root)
  assert.deepEqual(offenders, [], `以下业务文件仍直连桌面桥：${offenders.join('、')}`)
})

/** 去掉块注释与行注释后再做静态断言，避免注释里的历史说明被误判。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s*\/\/[^\n]*/g, '')
}
