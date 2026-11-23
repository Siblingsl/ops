import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// UI-09：全局底栏不再出现开发文案；三态文案固定；离线是可点重试按钮。
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bar = readFileSync(join(root, 'layout/DesktopStatusBar.tsx'), 'utf8')
const connection = readFileSync(join(root, 'lib/connection-state.ts'), 'utf8')

test('UI-09：底栏无开发文案，连接态驱动三态与重试', () => {
  // UI 层不再渲染开发文案（注释里的引用不算渲染）。
  assert.equal(/>\s*操作状态由当前页面反馈/.test(bar), false, '底栏仍渲染开发文案')
  // 三态固定文案。
  for (const label of ['已连接', '连接中…', '离线，点击重试']) assert.match(bar, new RegExp(label))
  // 离线是可点的重试按钮；checking/online 是 span。
  assert.match(bar, /button[^>]*desktop-statusbar-retry|desktop-statusbar-retry[^>]*onClick/)
  assert.match(bar, /state === 'offline'/)
  // 连接态来自真实探测（/healthz）+ online/offline 事件，不伪造。
  assert.match(connection, /api\/v1\/healthz/)
  assert.match(connection, /addEventListener\('online'/)
  assert.match(connection, /addEventListener\('offline'/)
  // 主界面文案不出现 run/SSE/feature flag 由 P0 spec 断言，此处守组件层。
  assert.equal(/>\s*SSE|>\s*feature flag/.test(bar), false)
})
