import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initializeDesktopPresentation, setDesktopMotion, setDesktopTheme } from '../src/lib/desktop-presentation.js'

function makeRoot() {
  return { documentElement: { dataset: {} } }
}

function makeStorage(entries = {}) {
  const values = new Map(Object.entries(entries))
  return {
    getItem(key) { return values.get(key) ?? null },
    setItem(key, value) { values.set(key, value) },
    values,
  }
}

test('普通浏览器 UA 不启用 Electron 呈现或写入主题', () => {
  const root = makeRoot()
  const storage = makeStorage()

  const theme = initializeDesktopPresentation(root, storage, 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36')

  assert.equal(theme, null)
  assert.deepEqual(root.documentElement.dataset, {})
  assert.equal(storage.values.size, 0)
})

test('Electron UA 启用客户端呈现且无偏好时默认浅色', () => {
  const root = makeRoot()
  const storage = makeStorage()

  const theme = initializeDesktopPresentation(root, storage, 'Mozilla/5.0 Chrome/140.0.0.0 Electron/44.8.0 Safari/537.36')

  assert.equal(theme, 'light')
  assert.equal(root.documentElement.dataset.presentation, 'ops-creative-desktop')
  assert.equal(root.documentElement.dataset.theme, 'light')
})

test('Electron 主进程共享主题覆盖另一个窗口遗留的本地偏好', () => {
  const root = makeRoot()
  const storage = makeStorage({ 'ops-desktop-theme': 'light' })

  const theme = initializeDesktopPresentation(root, storage, 'Electron/44.8.0', false, 'dark')

  assert.equal(theme, 'dark')
  assert.equal(root.documentElement.dataset.theme, 'dark')
  assert.equal(storage.getItem('ops-desktop-theme'), 'dark')
})

test('Electron 主题偏好恢复深色并在切换后持久化', () => {
  const root = makeRoot()
  const storage = makeStorage({ 'ops-desktop-theme': 'dark' })
  initializeDesktopPresentation(root, storage, 'Electron/44.8.0')

  assert.equal(root.documentElement.dataset.theme, 'dark')
  setDesktopTheme(root, storage, 'light')

  assert.equal(root.documentElement.dataset.theme, 'light')
  assert.equal(storage.getItem('ops-desktop-theme'), 'light')
})

test('手动减少动态效果会应用并持久化，系统偏好也会在无手动设置时生效', () => {
  const manualRoot = makeRoot()
  const manualStorage = makeStorage({ 'ops-desktop-motion': 'reduce' })
  initializeDesktopPresentation(manualRoot, manualStorage, 'Electron/44.8.0')
  assert.equal(manualRoot.documentElement.dataset.reducedMotion, 'true')

  setDesktopMotion(manualRoot, manualStorage, false)
  assert.equal(manualRoot.documentElement.dataset.reducedMotion, 'false')
  assert.equal(manualStorage.getItem('ops-desktop-motion'), 'soft')

  const systemRoot = makeRoot()
  initializeDesktopPresentation(systemRoot, makeStorage(), 'Electron/44.8.0', true)
  assert.equal(systemRoot.documentElement.dataset.reducedMotion, 'true')
})

test('Electron 初始主题通过被拦截的 UI 意图同步，不导航离开业务页面', () => {
  const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')

  assert.match(main, /window\.open\(`ops-desktop:\/\/ui\/theme\/\$\{initialDesktopTheme\}`/)
  assert.doesNotMatch(main, /location\.assign\(`ops-desktop:\/\/ui\/theme/)
})
