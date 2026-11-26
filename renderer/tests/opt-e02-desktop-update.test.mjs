import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// OPT-E02（docs/43 §5）：桌面端轻量更新提示的渲染器契约。
// 1) 底栏只在 updateAvailable && latestVersion 时渲染温和提示，且弹窗只由点击打开；
// 2) 设置页提供版本状态与「检查更新」，不支持时温和提示；
// 3) 更新弹窗只走 openUpdateDownload 固定意图，不直接 window.open 任意 URL；
// 4) 守住 UI-09 三态与 OPT-U06 守卫，底栏仍为 26px。

const here = path.dirname(fileURLToPath(import.meta.url))
const rendererRoot = path.resolve(here, '..')

function read(relative) {
  // 工作区是 CRLF；断言跨行匹配前统一成 LF。
  return fs.readFileSync(path.join(rendererRoot, relative), 'utf8').replace(/\r\n/g, '\n')
}

test('OPT-E02 底栏：仅在新版本时插入温和提示，弹窗不自动打开', () => {
  const source = read('layout/DesktopStatusBar.tsx')
  assert.match(source, /const stateLabels = \{ online: '已连接', checking: '连接中…', offline: '离线，点击重试' \} as const/)
  assert.match(source, /data-testid="desktop-statusbar"/)
  assert.match(source, /className="desktop-statusbar-save desktop-statusbar-retry"/)
  assert.match(source, /desktop-statusbar-spacer/)
  assert.match(source, /\{updateStatus\?\.updateAvailable && updateStatus\.latestVersion && \(/)
  assert.match(source, /data-testid="desktop-update-pill"/)
  assert.match(source, /发现新版本 v\{updateStatus\.latestVersion\}/)
  // 只有点击提示才打开弹窗；不存在自动 setUpdateDialogOpen(true)。
  assert.equal(source.split('setUpdateDialogOpen(true)').length - 1, 1)
  assert.match(source, /onClick=\{\(\) => setUpdateDialogOpen\(true\)\}/)
  assert.match(source, /const \[updateDialogOpen, setUpdateDialogOpen\] = useState\(false\)/)
  assert.match(source, /<DesktopUpdateDialog open=\{updateDialogOpen\} /)
  // 只订阅白名单推送 + 首挂同步一次，不直接请求服务端版本接口。
  // POLISH-01：组件必须经过统一平台桥；底层 IPC 只在 lib/platform-bridge.ts 调用一次。
  assert.match(source, /from '@\/lib\/platform-bridge'/)
  assert.match(source, /subscribeDesktopUpdateStatus\(setUpdateStatus\)/)
  assert.match(source, /getDesktopUpdateStatus\(\)/)
  const bridge = read('lib/platform-bridge.ts')
  // 双层断言：桥接层是唯一读取 window.opsDesktopUI 的地方，并确实调用四个更新方法。
  assert.equal((bridge.match(/window\.opsDesktopUI/g) ?? []).length, 1, '只有 getDesktopBridge 读取全局桥')
  assert.match(bridge, /\.onUpdateStatus\(listener\)/)
  assert.match(bridge, /\.getUpdateStatus\(\)/)
  assert.match(bridge, /\.checkUpdate\(\)/)
  assert.match(bridge, /\.openUpdateDownload\(\)/)
  assert.equal(/\bfetch\(|\/desktop\/release|window\.open\(/.test(source), false)
  // OPT-U06 / UI-09 守卫：底栏不承载平台采集禁用文案，也不引入 SSE/feature flag 字样。
  assert.equal(/disabled_hint|disabled_reason|platform-collection-disabled-notice|preferences-platform-disabled-notice/.test(source), false)
  assert.equal(/SSE|feature flag/.test(source), false)
  // 26px 总高由既有样式定义，本任务不改样式。
  const css = read('styles/desktop-creative.css')
  assert.match(css, /\.desktop-statusbar \{[\s\S]*?height: 26px;/)
});

test('OPT-E02 设置页：版本行在「本机客户端管理」之前，检查更新只走固定意图', () => {
  const source = read('pages/settings/Preferences.tsx')
  const updateRow = source.indexOf('data-testid="desktop-update-row"')
  const localRow = source.indexOf('<Row title="本机客户端管理"')
  assert.ok(updateRow > 0, '必须渲染客户端版本与更新行');
  assert.ok(localRow > updateRow, '版本行必须在本机客户端管理行之前');
  assert.match(source, /<Row title="客户端版本与更新" desc=\{`当前版本 \$\{currentVersionText\} · \$\{updateStatusText\}`\}>/)
  assert.match(source, /data-testid="desktop-check-update-btn"/)
  // POLISH-01：设置页同样只经过平台桥封装，不在页面里直连 IPC。
  assert.match(source, /from '@\/lib\/platform-bridge'/)
  assert.match(source, /const result = await checkDesktopUpdate\(\)/)
  assert.match(source, /当前环境不支持客户端更新检查/)
  assert.match(source, /发现新版本 v\$\{result\.status\.latestVersion\}/)
  assert.match(source, /已是最新版本/)
  assert.match(source, /服务端未配置更新源/)
  assert.match(source, /检查失败：/)
  assert.match(source, /尚未检查/)
  assert.match(source, /<DesktopUpdateDialog open=\{updateDialogOpen\} onClose=\{\(\) => setUpdateDialogOpen\(false\)\} status=\{updateStatus\} \/>/)
  // 版本/更新这一段不直接请求版本接口，也不直接 window.open（页面其它既有入口不受影响）。
  const updateSection = source.slice(updateRow, localRow)
  assert.equal(/\bfetch\(|\/desktop\/release|window\.open\(/.test(updateSection), false)
  assert.match(source, /subscribeDesktopUpdateStatus\(setUpdateStatus\)/)
});

test('OPT-E02 更新弹窗：基于 Dialog，下载只走 openUpdateDownload', () => {
  const source = read('components/desktop-update-dialog.tsx')
  assert.match(source, /import \{ Dialog \} from '@\/components\/dialog'/)
  assert.match(source, /<Dialog/)
  assert.match(source, /data-testid="desktop-update-dialog"/)
  assert.match(source, /暂无详细更新说明/)
  assert.match(source, /服务端未配置下载链接，请联系管理员获取最新安装包/)
  assert.match(source, /SHA-256 校验值/)
  // POLISH-01：弹窗只经平台桥调用固定意图，桥接层再落到 IPC。
  assert.match(source, /hasDesktopBridgeMethod\('openUpdateDownload'\)/)
  assert.match(source, /await openDesktopUpdateDownload\(\)/)
  assert.match(source, /if \(!result\.ok\) toast\.error\(result\.message\)/)
  // 绝不把任意字符串交给 window.open，也不自行拼接下载地址。
  assert.equal(/window\.open\(/.test(source), false)
  assert.equal(/shell\.openExternal/.test(source), false)
});

test('OPT-E02 类型契约：window.opsDesktopUI 暴露 4 个更新方法，状态固定 9 键', () => {
  const source = read('lib/desktop-presentation.d.ts')
  for (const signature of [
    'onUpdateStatus(listener: (status: DesktopUpdateStatus) => void): () => void',
    'getUpdateStatus(): Promise<DesktopUpdateStatusResult>',
    'checkUpdate(): Promise<DesktopUpdateStatusResult>',
    'openUpdateDownload(): Promise<DesktopUpdateOpenResult>',
  ]) {
    assert.ok(source.includes(signature), `缺少类型签名：${signature}`);
  }
  assert.match(source, /export type DesktopUpdateStatus = \{[\s\S]*?currentVersion: string[\s\S]*?latestVersion: string[\s\S]*?updateAvailable: boolean[\s\S]*?releaseNotes: string[\s\S]*?downloadUrl: string[\s\S]*?sha256: string[\s\S]*?checkedAt: number \| null[\s\S]*?error: string[\s\S]*?\}/)
});
