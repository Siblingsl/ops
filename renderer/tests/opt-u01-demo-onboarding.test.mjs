import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// OPT-U01（docs/43 §4）：破除冷启动无平台账号拦截，上线“5 分钟演示工作区”。
// 只锁源码契约，不重跑界面：
// 1) 零活跃账号不再被踢去空白设置页，直接渲染示例欢迎页；
// 2) 工作台顶部固定示例提示条 + 3 步首启卡，且都在折叠 <details> 之外；
// 3) 账号页保留既有空态文案与“打开账号入口”，另给示例体验入口；
// 4) 账号切换列表对 is_demo 显式标注「示例」。

const here = path.dirname(fileURLToPath(import.meta.url))
const rendererRoot = path.resolve(here, '..')
const require = createRequire(import.meta.url)
const ts = require('typescript')

function read(relative) {
  // 工作区是 CRLF；断言跨行匹配前统一成 LF。
  return fs.readFileSync(path.join(rendererRoot, relative), 'utf8').replace(/\r\n/g, '\n')
}

function loadDemoOnboarding() {
  const source = read('components/demo-onboarding.tsx')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText
  const module = { exports: {} }
  const exports = module.exports
  // 组件只在真实渲染时调用依赖；这里只执行模块顶层，拿到纯函数。
  vm.runInNewContext(compiled, {
    exports,
    module,
    require: () => ({}),
    console,
  })
  return module.exports
}

const { isOnboardingGuideVisible, pickPeerDemoAccount, hasRealActiveAccount } = loadDemoOnboarding()

test('OPT-U01 纯函数：示例账号 / 未配模型 / 0 作品时显示首启卡，手动收起后不再打扰', () => {
  assert.equal(isOnboardingGuideVisible({ isDemo: false, modelReady: true, totalWorks: 5, dismissed: false }), false)
  assert.equal(isOnboardingGuideVisible({ isDemo: true, modelReady: true, totalWorks: 5, dismissed: false }), true)
  assert.equal(isOnboardingGuideVisible({ isDemo: false, modelReady: false, totalWorks: 5, dismissed: false }), true)
  assert.equal(isOnboardingGuideVisible({ isDemo: false, modelReady: true, totalWorks: 0, dismissed: false }), true)
  assert.equal(isOnboardingGuideVisible({ isDemo: true, modelReady: false, totalWorks: 0, dismissed: true }), false)
})

test('OPT-U01 纯函数：双示例账号可互切，真实号不参与示例切换', () => {
  const accounts = [
    { id: 'demo-wechat', platform: 'wechat_mp', status: 'active', is_demo: true },
    { id: 'demo-xhs', platform: 'xhs', status: 'active', is_demo: true },
    { id: 'real-wechat', platform: 'wechat_mp', status: 'active', is_demo: false },
  ]
  assert.equal(pickPeerDemoAccount(accounts, 'demo-wechat')?.id, 'demo-xhs')
  assert.equal(pickPeerDemoAccount(accounts, 'demo-xhs')?.id, 'demo-wechat')
  assert.equal(pickPeerDemoAccount(accounts, 'real-wechat')?.id, 'demo-wechat')
  assert.equal(pickPeerDemoAccount([accounts[1]], 'demo-xhs'), undefined)
  assert.equal(pickPeerDemoAccount(undefined, 'demo-xhs'), undefined)
})

test('OPT-U01 纯函数：真实活跃账号与示例、停用号严格区分', () => {
  assert.equal(hasRealActiveAccount([{ id: 'a', status: 'active', is_demo: true }]), false)
  assert.equal(hasRealActiveAccount([{ id: 'a', status: 'disabled', is_demo: false }]), false)
  assert.equal(hasRealActiveAccount([{ id: 'a', status: 'active', is_demo: false }]), true)
  assert.equal(hasRealActiveAccount([]), false)
  assert.equal(hasRealActiveAccount(undefined), false)
})

test('OPT-U01 冷启动：Home 零活跃账号直接渲染 ColdStartWelcome，不再强制跳设置页', () => {
  const app = read('App.tsx')
  assert.match(app, /if \(active\.length === 0\) return <ColdStartWelcome \/>/)
  assert.doesNotMatch(app, /Navigate to=me\.data\?\.role === 'owner' \? '\/settings\/accounts/)
  assert.doesNotMatch(app, /if \(!selection\.account\) return <Navigate to="\/settings\/accounts" replace \/>/)
  // 桌面端未记住账号：自动落到第一个活跃账号并 rememberAccount，不卡死。
  assert.match(app, /const fallbackId = desktop && active\.length > 0 && !selection\.account \? active\[0\]\.id : undefined/)
  assert.match(app, /if \(fallbackId\) rememberAccount\(fallbackId, userId, workspaceId\)/)
  assert.ok(app.includes('return <Navigate to={`/a/${fallbackId ?? active[0].id}`} replace />'))
})

test('OPT-U01 欢迎页与示例提示条：显式文案、双示例互切、owner 确认清空', () => {
  const demo = read('components/demo-onboarding.tsx')
  assert.match(demo, /data-testid="cold-start-welcome"/)
  assert.match(demo, /data-testid="cold-start-enter-demo"/)
  assert.ok(demo.includes('先用示例账号体验 5 分钟写作（无需绑定真实号）'))
  assert.match(demo, /data-testid="demo-mode-banner"/)
  assert.ok(demo.includes('当前处于示例体验模式 · 不可对外推送 · 随时可一键清空'))
  assert.match(demo, /data-testid="demo-clear-button"/)
  assert.ok(demo.includes('清空所有示例账号与示例稿件'))
  assert.match(demo, /pickPeerDemoAccount\(accounts, account\.id\)/)
})

test('OPT-U01 工作台：示例提示条与 3 步首启卡在 creative-welcome 下方且不在折叠 <details> 内', () => {
  const dash = read('pages/Dashboard.tsx')
  const bannerAt = dash.indexOf('<DemoModeBanner account={account} />')
  const stepsAt = dash.indexOf('<OnboardingStepsCard account={account} modelReady={data.setup.ai}')
  const detailsAt = dash.indexOf('<details ref={extrasRef}')
  assert.ok(bannerAt > 0 && stepsAt > 0 && detailsAt > 0)
  assert.ok(bannerAt < detailsAt, '示例提示条必须在折叠区之外')
  assert.ok(stepsAt < detailsAt, '3 步首启卡必须在折叠区之外')
  assert.match(dash, /data-testid="demo-account-badge"/)
  assert.doesNotMatch(dash, /<DemoCard\b/)
  // 普通 Dashboard 同样复用两块组件。
  assert.match(dash, /<DemoModeBanner account=\{acc\} \/>/)
  assert.match(dash, /<OnboardingStepsCard account=\{acc\} modelReady=\{s\.ai\}/)
})

test('OPT-U01 账号页：保留既有空态文案与“打开账号入口”，新增示例体验入口与示例徽标', () => {
  const accounts = read('pages/settings/Accounts.tsx')
  assert.ok(accounts.includes("'当前工作区还没有平台账号'"))
  assert.ok(accounts.includes("'打开账号入口'"))
  assert.match(accounts, /data-testid="accounts-enter-demo"/)
  assert.ok(accounts.includes('先用示例账号体验 5 分钟'))
  assert.match(accounts, /current\.is_demo && <Badge className="shrink-0" tone="gamboge">示例<\/Badge>/)
  assert.match(accounts, /a\.is_demo && <Badge tone="gamboge">示例<\/Badge>/)
})

test('OPT-U01 账号切换：桌面与窄屏两处列表都对 is_demo 标注「示例」，导航数组不动', () => {
  const shell = read('layout/WorkspaceAccountTree.tsx')
  const matches = shell.match(/a\.is_demo && <span className="shrink-0 rounded bg-gamboge-100 px-1\.5 py-0\.5 text-\[10\.5px\] font-medium text-gamboge-700">示例<\/span>/g) ?? []
  assert.equal(matches.length, 2, '桌面与非桌面账号切换列表各一处示例徽标')
})
