import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// OPT-U06（docs/43 §4）：服务端关闭平台采集时必须显式说明原因，不能让客户端静默停采。
// 1) 纯函数只在 enabled === false 时给出原因，旧服务端缺 hint 时回落默认提示；
// 2) 共享查询只走既有 get('/desktop/capabilities')，固定缓存键与 60s staleTime；
// 3) 账号连接卡未连接/已连接两分支与偏好设置都挂载黄色提示条；DesktopStatusBar 不参与。

const here = path.dirname(fileURLToPath(import.meta.url))
const rendererRoot = path.resolve(here, '..')
const require = createRequire(import.meta.url)
const ts = require('typescript')

function read(relative) {
  // 工作区是 CRLF；断言跨行匹配前统一成 LF。
  return fs.readFileSync(path.join(rendererRoot, relative), 'utf8').replace(/\r\n/g, '\n')
}

function loadDesktopCapabilities() {
  const source = read('lib/desktop-capabilities.ts')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const exports = {}
  const module = { exports }
  const queries = []
  const requests = []
  const stubs = {
    '@tanstack/react-query': { useQuery: (options) => { queries.push(options); return { data: undefined } } },
    '@/lib/api': { get: (path) => { requests.push(path); return Promise.resolve({}) } },
  }
  vm.runInNewContext(compiled, {
    exports,
    module,
    require: (name) => stubs[name] ?? require(name),
    console,
  })
  return { exports: module.exports, queries, requests }
}

const loaded = loadDesktopCapabilities()
const { DEFAULT_PLATFORM_DISABLED_HINT, getPlatformCollectionDisabledInfo, useDesktopCapabilities } = loaded.exports

test('OPT-U06 纯函数：仅在 enabled === false 时返回原因，其余一律不误报', () => {
  assert.equal(getPlatformCollectionDisabledInfo({ platform_collection: { enabled: true } }), null)
  assert.equal(getPlatformCollectionDisabledInfo(null), null)
  assert.equal(getPlatformCollectionDisabledInfo(undefined), null)
  assert.equal(getPlatformCollectionDisabledInfo({}), null)
  assert.equal(getPlatformCollectionDisabledInfo({ platform_collection: {} }), null)
  assert.equal(getPlatformCollectionDisabledInfo({ platform_collection: { enabled: false } })?.reason, 'server_disabled')
})

test('OPT-U06 纯函数：环境变量关闭与 kill switch 各自透出后端 hint', () => {
  const env = getPlatformCollectionDisabledInfo({
    platform_collection: {
      enabled: false,
      disabled_reason: 'server_env_disabled',
      disabled_hint: '服务端未开启 OPS_DESKTOP_PLATFORM_ENABLED=1，本机自动采集与状态心跳已暂停',
    },
  })
  assert.equal(env?.reason, 'server_env_disabled')
  assert.equal(env?.hint, '服务端未开启 OPS_DESKTOP_PLATFORM_ENABLED=1，本机自动采集与状态心跳已暂停')
  const kill = getPlatformCollectionDisabledInfo({
    platform_collection: {
      enabled: false,
      disabled_reason: 'kill_switch_enabled',
      disabled_hint: '系统管理员已开启平台采集全局总闸（kill switch），本机自动采集与状态心跳已暂停',
    },
  })
  assert.equal(kill?.reason, 'kill_switch_enabled')
  assert.match(kill?.hint ?? '', /kill switch/)
  assert.equal(/OPS_DESKTOP_PLATFORM_ENABLED/.test(kill?.hint ?? ''), false, 'kill switch 提示不能与环境变量关闭混淆')
})

test('OPT-U06 纯函数：旧服务端 enabled=false 但没有 hint 时回落默认提示', () => {
  const legacy = getPlatformCollectionDisabledInfo({ platform_collection: { enabled: false } })
  assert.equal(legacy?.reason, 'server_disabled')
  assert.equal(legacy?.hint, DEFAULT_PLATFORM_DISABLED_HINT)
  const blank = getPlatformCollectionDisabledInfo({
    platform_collection: { enabled: false, disabled_reason: '   ', disabled_hint: '  ' },
  })
  assert.equal(blank?.reason, 'server_disabled')
  assert.equal(blank?.hint, DEFAULT_PLATFORM_DISABLED_HINT)
})

test('OPT-U06 共享查询：固定缓存键、60s staleTime、不重试、只走既有 get', async () => {
  const query = useDesktopCapabilities(true)
  assert.ok(query)
  const options = loaded.queries.at(-1)
  assert.equal(JSON.stringify(options.queryKey), '["desktop-capabilities"]')
  assert.equal(options.enabled, true)
  assert.equal(options.staleTime, 60_000)
  assert.equal(options.retry, false)
  await options.queryFn()
  assert.deepEqual(loaded.requests, ['/desktop/capabilities'])
  const source = read('lib/desktop-capabilities.ts')
  assert.match(source, /get<DesktopCapabilitiesResponse>\('\/desktop\/capabilities'\)/)
  assert.equal(/\bfetch\(/.test(source), false, '共享查询必须复用 get，不能直接 fetch')
})

test('OPT-U06 账号连接卡：未连接与已连接两分支都挂载黄色提示条', () => {
  const source = read('components/platform-connection.tsx')
  assert.equal(source.split('data-testid="platform-collection-disabled-notice"').length - 1, 2)
  assert.match(source, /<Notice tone="gamboge" data-testid="platform-collection-disabled-notice">\{platformDisabled\.hint\}<\/Notice>/)
  // 未连接分支：卡片正文最上方；已连接分支：操作按钮之后、同步原因之前。
  assert.match(source, /desktop-platform-disconnected p-4[^>]*>\n          \{desktopPresentation && !isToutiao && platformDisabled && \(/)
  assert.match(source, /\{renderedActions\}\n      \{desktopPresentation && !isToutiao && platformDisabled && <div className="border-b border-line\/60 px-5 py-3">/)
  // 同步被阻止时优先显示真实原因，而不是笼统的“服务端或工作区尚未启用”。
  assert.match(source, /if \(platformDisabled\) return platformDisabled\.hint/)
  assert.ok(source.indexOf('if (platformDisabled) return platformDisabled.hint') < source.indexOf("if (presence !== 'online')"), '服务端禁用原因必须先于客户端离线提示')
  // 原有守卫红线继续成立：不新增直接 fetch/eval 或设置宿主依赖。
  assert.equal(/opsDesktopSettings/.test(source), false)
  assert.equal(/\bfetch\(|\beval\(/.test(source), false)
})

test('OPT-U06 偏好设置：平台采集行显示「服务端已暂停采集」并挂载黄色提示条', () => {
  const source = read('pages/settings/Preferences.tsx')
  assert.match(source, /const platformDisabled = getPlatformCollectionDisabledInfo\(capabilitiesQuery\.data\)/)
  assert.match(source, /服务端已暂停采集/)
  assert.ok(source.includes('data-testid="preferences-platform-disabled-notice"'))
  assert.match(source, /<Notice tone="gamboge" data-testid="preferences-platform-disabled-notice">\{platformDisabled\.hint\}<\/Notice>/)
  // 未关闭时不改变原有状态文案。
  assert.match(source, /采集需处理/)
})

test('OPT-U06 边界：DesktopStatusBar 保持 UI-09 原样，不承载平台采集提示', () => {
  const source = read('layout/DesktopStatusBar.tsx')
  assert.match(source, /UI-09/)
  assert.match(source, /stateLabels/)
  assert.equal(/disabled_hint|disabled_reason/.test(source), false)
  assert.equal(/platform-collection-disabled-notice|preferences-platform-disabled-notice/.test(source), false)
})
