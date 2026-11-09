import assert from 'node:assert/strict'
import { test } from 'node:test'

const store = new Map()
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
}
globalThis.window = { dispatchEvent() {} }

const { rememberRecent, recentItems, setRecentOwner } = await import('../lib/recent.ts')

test('桌面最近打开按用户和工作区隔离，并在切回工作区后恢复', () => {
  setRecentOwner('user-a', 'workspace-1')
  rememberRecent({ type: 'work', title: '工作区 1 的作品', link: '/works/work-1' })

  setRecentOwner('user-a', 'workspace-2')
  assert.deepEqual(recentItems(), [])
  rememberRecent({ type: 'work', title: '工作区 2 的作品', link: '/works/work-2' })

  setRecentOwner('user-a', 'workspace-1')
  assert.deepEqual(recentItems().map((item) => item.title), ['工作区 1 的作品'])

  setRecentOwner('user-b', 'workspace-1')
  assert.deepEqual(recentItems(), [])
})
