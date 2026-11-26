import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// OPT-U04（docs/43 §4）：信息架构瘦身与 RC-03 桌面重登去 window.open 依赖。
// 1) Shell 桌面侧栏 3 组结构（AI 对话第一组；运营入口保留；底部不再重复）；
// 2) settingsGroupOf 把 28 项全部确定性归入 5 常用组 + 1 高级区；
// 3) DesktopSettingsHost / platform-connection 优先走 opsDesktopUI 固定 IPC，
//    window.open 只留旧宿主降级分支。

const here = path.dirname(fileURLToPath(import.meta.url))
const rendererRoot = path.resolve(here, '..')
const require = createRequire(import.meta.url)
const ts = require('typescript')

function read(relative) {
  return fs.readFileSync(path.join(rendererRoot, relative), 'utf8')
}

/** 把 settings-registry.ts 转成 CommonJS 在 vm 里执行；lucide-react 只作图标占位。 */
function loadSettingsRegistry() {
  const source = read('lib/settings-registry.ts')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const exports = {}
  const lucideStub = new Proxy({}, { get: (_, key) => (key === '__esModule' ? true : () => null) })
  const module = { exports }
  vm.runInNewContext(compiled, {
    exports,
    module,
    require: (name) => (name === 'lucide-react' ? lucideStub : require(name)),
  })
  return exports
}

const registry = loadSettingsRegistry()
const shell = read('layout/Shell.tsx')
const host = read('layout/DesktopSettingsHost.tsx')
const connection = read('components/platform-connection.tsx')
const preferences = read('pages/settings/Preferences.tsx')
const bridge = read('lib/platform-bridge.ts')

test('OPT-U04：桌面侧栏第一组为「AI 助手 → AI 对话」，三组顺序与成员确定', async () => {
  const { buildSnapshot } = await import('../../scripts/g02-structure-guard.mjs')
  const snapshot = buildSnapshot({ source: 'worktree' })
  assert.deepEqual(
    snapshot.shell.desktopNavGroups.map((group) => ({ label: group.label, items: group.items.map((item) => item.label) })),
    [
      { label: 'AI 助手', items: ['AI 对话'] },
      { label: '创作', items: ['工作台', '选题池', '作品', '内容日历'] },
      { label: '资产与复盘', items: ['素材库', '图片库', '运营', '复盘', '账号档案'] },
    ],
  )
  // 钉死第一项就是 /agent，避免只改 label 不改入口。
  assert.equal(snapshot.shell.desktopNavGroups[0].items[0].path, '/agent')
  // 运营（/ops）必须仍在一级导航里，不得因瘦身丢失入口。
  assert.ok(snapshot.shell.desktopNavGroups.some((group) => group.items.some((item) => item.path === '/ops')))
  // nav / mobileNav / mobileMoreGroups 不动：移动端仍按原分组。
  assert.deepEqual(snapshot.shell.nav.map((item) => item.label), ['工作台', '选题池', '运营', '内容日历', '作品', '素材库', '复盘', '账号档案'])
  assert.deepEqual(snapshot.shell.mobileNav.map((item) => item.label), ['工作台', '收件箱', '作品', '待发布'])
  assert.deepEqual(snapshot.shell.mobileMoreGroups.map((group) => group.label), ['创作', '资源', '运营'])
})

test('OPT-U04：桌面底部不再重复渲染「AI 对话」，非桌面降级分支保留', () => {
  // 顶部第一组已承载 /agent；底部桌面态若再渲染 NavItem 会出现两个入口。
  assert.equal((shell.match(/<NavItem to="\/agent" icon=\{Bot\}>AI 对话<\/NavItem>/g) ?? []).length, 1,
    'AI 对话 NavItem 只允许存在于非桌面降级分支一次')
  assert.doesNotMatch(shell, /desktopPresentation\s*\?\s*<NavItem to="\/agent"/)
  assert.match(shell, /\{!desktopPresentation && \(agentMode/)
  // 非桌面分支的「返回工作台」与 showAgent 守卫原样保留。
  assert.match(shell, /返回工作台/)
  assert.match(shell, /showAgent && <NavItem to="\/agent" icon=\{Bot\}>AI 对话<\/NavItem>/)
})

test('OPT-U04：设置分组常量为 5 大常用组 + 1 个折叠高级区，且顺序固定', () => {
  // vm 里构造的数组原型不同，先摊平成宿主 realm 的数组再深比较。
  assert.deepEqual(Array.from(registry.SETTINGS_GROUP_ORDER), ['账号与平台', 'AI 模型', '写作与风格', '团队与工作区', '本机客户端', '高级与诊断'])
  assert.equal(registry.ADVANCED_SETTINGS_GROUP, '高级与诊断')
  assert.equal(Array.from(registry.SETTINGS_GROUP_ORDER).at(-1), registry.ADVANCED_SETTINGS_GROUP, '高级区必须最后')
})

test('OPT-U04：settingsGroupOf 对 28 项逐一命中且无漏项，冻结项与系统工具进高级区', () => {
  const entries = Array.from(registry.settingsEntries)
  assert.equal(entries.length, 28, 'settingsEntries 仍应为 28 项')
  const order = new Set(Array.from(registry.SETTINGS_GROUP_ORDER))
  for (const entry of entries) {
    const group = registry.settingsGroupOf(entry)
    assert.ok(order.has(group), `${entry.path} 归入了未知分组 ${group}`)
  }
  const mapped = entries.map((entry) => `${entry.path}=${registry.settingsGroupOf(entry)}`)
  const expected = [
    '/settings/accounts=账号与平台',
    '/settings/security=账号与平台',
    '/settings/models=AI 模型',
    '/settings/agent=AI 模型',
    '/settings/capabilities=AI 模型',
    '/settings/budget=AI 模型',
    '/settings/preferences=写作与风格',
    '/settings/skills=写作与风格',
    '/settings/memory=写作与风格',
    '/settings/words=写作与风格',
    '/settings/hot-sources=写作与风格',
    '/settings/daily=写作与风格',
    '/settings/members=团队与工作区',
    '/settings/export=团队与工作区',
    '/settings/trash=团队与工作区',
    '/settings/logs=高级与诊断',
    '/settings/usage=高级与诊断',
    '/settings/quality=高级与诊断',
    '/settings/prompts=高级与诊断',
    '/settings/admin=高级与诊断',
    '/settings/plugins=高级与诊断',
    '/settings/desktop-ai=高级与诊断',
    '/settings/mail=高级与诊断',
    '/settings/crawl=高级与诊断',
    '/settings/local/connection=本机客户端',
    '/settings/local/ai=本机客户端',
    '/settings/local/account-device=本机客户端',
    '/settings/local/diagnostics=本机客户端',
  ]
  assert.deepEqual(mapped.slice().sort(), expected.slice().sort())
  // 高级区必含五个系统/诊断页；本机四项全在本机客户端。
  for (const path of ['/settings/logs', '/settings/usage', '/settings/quality', '/settings/prompts', '/settings/admin']) {
    const entry = entries.find((item) => item.path === path)
    assert.equal(registry.settingsGroupOf(entry), registry.ADVANCED_SETTINGS_GROUP, `${path} 必须在高级与诊断`)
  }
  for (const path of ['/settings/local/connection', '/settings/local/ai', '/settings/local/account-device', '/settings/local/diagnostics']) {
    const entry = entries.find((item) => item.path === path)
    assert.equal(registry.settingsGroupOf(entry), '本机客户端', `${path} 必须在本机客户端`)
  }
  // 五个常用组都至少有成员，不出现空组。
  for (const group of Array.from(registry.SETTINGS_GROUP_ORDER).slice(0, 5)) {
    assert.ok(entries.some((entry) => registry.settingsGroupOf(entry) === group), `${group} 不得为空组`)
  }
})

test('OPT-U04：DesktopSettingsHost 按固定顺序渲染 5+1 分组，高级区默认折叠', () => {
  assert.match(host, /SETTINGS_GROUP_ORDER\.filter\(\(group\) => visibleGroups\.has\(group\)\)/)
  assert.match(host, /const basicGroups = groups\.filter\(\(group\) => group !== ADVANCED_SETTINGS_GROUP\)/)
  assert.match(host, /data-testid=\{advanced \? 'desktop-settings-advanced-group' : undefined\}/)
  assert.match(host, /data-testid="desktop-settings-advanced-separator"/)
  assert.match(host, /const advancedExpanded = searching \|\| advancedOpen \|\| currentGroup === ADVANCED_SETTINGS_GROUP/)
  assert.match(host, /const \[advancedOpen, setAdvancedOpen\] = useState\(false\)/, '高级区默认收起')
})

test('OPT-U04：本机设置面板优先走固定 IPC，window.open 只保留旧宿主降级一处', () => {
  assert.match(host, /function syncLocalSettingsPanel\(action: 'connection' \| 'ai' \| 'account-device' \| 'diagnostics' \| 'detach' \| 'close'\)/)
  // POLISH-01 双层断言：宿主走平台桥封装，桥接层再落到固定 IPC。
  assert.match(host, /from '@\/lib\/platform-bridge'/)
  assert.match(host, /hasDesktopBridgeMethod\('setLocalSettingsPanel'\)/)
  assert.match(host, /setDesktopLocalSettingsPanel\(action\)/)
  assert.match(bridge, /\.setLocalSettingsPanel\(action\)/)
  // 1 处定义 + 4 处调用点（进入面板、离开 detach/close、离开前 detach、取消后恢复）。
  assert.ok((host.match(/syncLocalSettingsPanel\(/g) ?? []).length >= 5, '四处 window.open 调用必须全部替换')
  assert.equal((host.match(/window\.open\(/g) ?? []).length, 1, '只允许 helper 内的旧宿主降级 window.open')
  assert.match(host, /window\.open\(`ops-desktop:\/\/ui\/settings\/\$\{action\}`/)
})

test('OPT-U04：平台重登 async 优先走 opsDesktopUI.openPlatformLogin，失败如实提示并保留旧宿主深链', () => {
  assert.match(connection, /const openPlatformLogin = async \(\) => \{/)
  // POLISH-01 双层断言：优先分支走平台桥封装（且该封装先于旧宿主深链出现），桥接层再落到 IPC。
  assert.match(connection, /from '@\/lib\/platform-bridge'/)
  assert.match(connection, /hasDesktopBridgeMethod\('openPlatformLogin'\) && loginPlatform/)
  assert.match(connection, /const res = await openDesktopPlatformLogin\(\{ accountId, platform: loginPlatform \}\)/)
  assert.match(bridge, /\.openPlatformLogin\(input\)/)
  assert.match(connection, /if \(!res\.ok\) \{[\s\S]{0,80}toast\.error\(res\.message\)[\s\S]{0,40}return/)
  // 旧宿主降级的自定义协议深链原样保留（platform-ui.test.mjs 仍按该字符串断言）。
  assert.match(connection, /window\.open\(`ops-desktop:\/\/ui\/platform-login\/\$\{accountId\}\/\$\{platform\}`/)
  // 优先分支必须在 window.open 之前出现：先取 IPC，再决定是否降级。
  assert.ok(connection.indexOf('openDesktopPlatformLogin({') < connection.indexOf('window.open(`ops-desktop://ui/platform-login'))
  // 成功后统一派发本机设置事件，让账号与设备面板接管扫码。
  assert.match(connection, /window\.dispatchEvent\(new CustomEvent\(DESKTOP_LOCAL_SETTINGS_REQUEST, \{ detail: \{ panel: 'account-device' \} \}\)\)/)
})

test('OPT-U04：偏好设置「此电脑」卡片提供三个本机设置直达入口', () => {
  assert.match(preferences, /data-testid="desktop-local-settings-shortcuts"/)
  for (const [label, path] of [['客户端连接', '/settings/local/connection'], ['账号与设备', '/settings/local/account-device'], ['诊断与关于', '/settings/local/diagnostics']]) {
    assert.match(preferences, new RegExp(`>${label}<`))
    assert.match(preferences, new RegExp(`navigate\\('${path.replace(/\//g, '\\/')}'\\)`))
  }
})
