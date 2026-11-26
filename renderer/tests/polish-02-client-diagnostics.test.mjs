import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// POLISH-02（docs/43 §4 第 3.2 条）：偏好设置「此电脑」内的本机连接/运行/版本诊断。
// 1) 类型契约：两个无参方法与严格 16 键摘要，越界字段不可进类型；
// 2) 设置页双层守卫：只经 @/lib/platform-bridge、紧跟「本机客户端管理」、testid 完整、
//    取消保存不弹成功提示、不直连 opsDesktopUI / opsDesktopSettings，也不新增 window.open / fetch；
// 3) 桥接层守卫：底层确实调用 .getClientDiagnostics() 与 .exportClientDiagnostics()，
//    window.opsDesktopUI 全文件仍只有 getDesktopBridge 一处读取。

const here = path.dirname(fileURLToPath(import.meta.url))
const rendererRoot = path.resolve(here, '..')

function read(relative) {
  // 工作区是 CRLF；断言跨行匹配前统一成 LF。
  return fs.readFileSync(path.join(rendererRoot, relative), 'utf8').replace(/\r\n/g, '\n')
}

const DIAGNOSTICS_KEYS = [
  'activeModelRequests', 'appVersion', 'arch', 'channelMessage', 'channelState',
  'connectionState', 'deviceRegistered', 'electronVersion', 'localConfigAvailable',
  'mode', 'modelCount', 'platform', 'reauthRequired', 'routeRevision',
  'signedIn', 'storageAvailable',
]
const FORBIDDEN_KEYS = ['apiKey', 'token', 'cookie', 'password', 'deviceId', 'username', 'workspaceName', 'apiOrigin', 'filePath']

test('POLISH-02 类型契约：两个无参方法签名与严格 16 键摘要', () => {
  const source = read('lib/desktop-presentation.d.ts')
  for (const signature of [
    'getClientDiagnostics(): Promise<DesktopClientDiagnosticsResult>',
    'exportClientDiagnostics(): Promise<DesktopClientDiagnosticsExportResult>',
  ]) {
    assert.ok(source.includes(signature), `缺少类型签名：${signature}`)
  }
  const block = source.match(/export type DesktopClientDiagnostics = \{([\s\S]*?)\n\}/)
  assert.ok(block, '必须声明 DesktopClientDiagnostics')
  const keys = [...block[1].matchAll(/^\s{2}([A-Za-z]+):/gm)].map((match) => match[1])
  assert.equal(keys.length, 16, '摘要必须严格 16 键')
  assert.deepEqual(keys.slice().sort(), DIAGNOSTICS_KEYS, '摘要键名必须与 preload 白名单一致')
  for (const key of FORBIDDEN_KEYS) {
    assert.equal(block[1].includes(`${key}:`), false, `摘要类型不得包含 ${key}`)
  }
  assert.match(source, /export type DesktopClientDiagnosticsResult =\n\s*\| \{ ok: false; code: string; message: string \}\n\s*\| \{ ok: true; diagnostics: DesktopClientDiagnostics \}/)
  assert.match(source, /export type DesktopClientDiagnosticsExportResult =\n\s*\| \{ ok: false; code: string; message: string \}\n\s*\| \{ ok: true; canceled: boolean \}/)
})

test('POLISH-02 设置页：诊断行紧跟「本机客户端管理」，只经平台桥且 testid 完整', () => {
  const source = read('pages/settings/Preferences.tsx')
  const updateRow = source.indexOf('data-testid="desktop-update-row"')
  const localRow = source.indexOf('<Row title="本机客户端管理"')
  const diagnosticsRow = source.indexOf('data-testid="desktop-client-diagnostics-row"')
  assert.ok(updateRow > 0, '必须保留客户端版本与更新行')
  assert.ok(localRow > updateRow, '版本行必须仍在本机客户端管理行之前（OPT-E02 守卫）')
  assert.ok(diagnosticsRow > localRow, '诊断行必须紧跟在本机客户端管理之后')
  // 必须真正落在「此电脑」卡片内，且不得插到版本行与本机管理行之间。
  const cardStart = source.indexOf('<CardHeader title="此电脑"')
  const cardEnd = source.indexOf('</Card>', cardStart)
  assert.ok(cardStart > 0 && diagnosticsRow > cardStart && diagnosticsRow < cardEnd, '诊断行必须在「此电脑」卡片内')
  assert.equal(source.indexOf('data-testid="desktop-client-diagnostics-row"', diagnosticsRow + 1), -1, '诊断行只允许出现一次')

  // 既有直达入口与 testid 原样保留，说明可微调但按钮不可丢。
  assert.match(source, /data-testid="desktop-local-settings-shortcuts"/)
  for (const [label, target] of [['客户端连接', '/settings/local/connection'], ['账号与设备', '/settings/local/account-device'], ['诊断与关于', '/settings/local/diagnostics']]) {
    assert.match(source, new RegExp(`>${label}<`))
    assert.match(source, new RegExp(`navigate\\('${target.replace(/\//g, '\\/')}'\\)`))
  }
  assert.match(source, /title="本机连接与诊断"/)
  assert.match(source, /data-testid="desktop-client-diagnostics-summary"/)
  assert.match(source, /data-testid="desktop-refresh-diagnostics-btn"/)
  assert.match(source, /data-testid="desktop-export-diagnostics-btn"/)

  // 只经平台桥：页面不得直连桌面桥，也不得退回独立设置页的原生桥。
  assert.match(source, /from '@\/lib\/platform-bridge'/)
  assert.equal(/opsDesktopUI/.test(source), false, '页面不得直连 window.opsDesktopUI')
  assert.equal(/opsDesktopSettings/.test(source), false, '页面不得直连 opsDesktopSettings 原生分区')
  assert.match(source, /hasDesktopBridgeMethod\('getClientDiagnostics'\)/)
  assert.match(source, /getDesktopClientDiagnostics\(\)/)
  assert.match(source, /hasDesktopBridgeMethod\('exportClientDiagnostics'\)/)
  assert.match(source, /exportDesktopClientDiagnostics\(\)/)
  // 首次挂载自动拉取一次只读摘要，且带防重入。
  assert.match(source, /if \(!desktop \|\| !hasDesktopBridgeMethod\('getClientDiagnostics'\)\) return\n\s*void refreshClientDiagnostics\(\)/)
  assert.match(source, /loading=\{refreshingDiagnostics\}/)
  assert.match(source, /loading=\{exportingDiagnostics\}/)

  const sectionEnd = source.indexOf('</Row>', diagnosticsRow)
  const section = source.slice(diagnosticsRow, sectionEnd)
  assert.ok(sectionEnd > diagnosticsRow && section.length > 0)
  // 诊断这一段只渲染只读摘要与两个按钮，不新增任意 window.open / fetch，也不直连桥或原生设置分区。
  assert.equal(/window\.open\(|\bfetch\(|opsDesktopUI|opsDesktopSettings/.test(section), false)
  assert.match(section, /onClick=\{\(\) => void refreshClientDiagnostics\(\)\}/)
  assert.match(section, /onClick=\{\(\) => void exportDiagnostics\(\)\}/)

  // 导出 handler 在组件内（不在这段 JSX 里）：取消保存必须静默返回，分支出现在成功提示之前。
  assert.match(source, /if \(!hasDesktopBridgeMethod\('exportClientDiagnostics'\)\) \{[\s\S]{0,80}toast\.info\('当前环境不支持导出脱敏诊断信息'\)/)
  assert.match(source, /const result = await exportDesktopClientDiagnostics\(\)/)
  assert.match(source, /if \(!result\.ok\) \{[\s\S]{0,60}toast\.error\(result\.message\)/)
  const cancelIndex = source.indexOf('if (result.canceled) return')
  const successIndex = source.indexOf("toast.success('已导出脱敏诊断信息'")
  assert.ok(cancelIndex > 0, '必须显式处理用户取消')
  assert.ok(successIndex > cancelIndex, '取消分支必须在成功提示之前')
  // 错误态如实提示，不伪造在线或健康状态。
  assert.match(source, /setDiagnosticsError\(result\.message\)/)
})

test('POLISH-02 桥接层：底层落到两个固定意图，window.opsDesktopUI 仍只读一处', () => {
  const bridge = read('lib/platform-bridge.ts')
  assert.match(bridge, /export async function getDesktopClientDiagnostics\(\)/)
  assert.match(bridge, /export async function exportDesktopClientDiagnostics\(\)/)
  assert.match(bridge, /\.getClientDiagnostics\(\)/)
  assert.match(bridge, /\.exportClientDiagnostics\(\)/)
  assert.equal((bridge.match(/window\.opsDesktopUI/g) ?? []).length, 1, '只有 getDesktopBridge 读取全局桥')
  assert.match(bridge, /unsupportedBridgeResult\('当前 OPS 桌面客户端不支持读取本机诊断状态，请重启客户端后重试。'\)/)
  assert.match(bridge, /unsupportedBridgeResult\('当前 OPS 桌面客户端不支持导出脱敏诊断信息，请重启客户端后重试。'\)/)
})
