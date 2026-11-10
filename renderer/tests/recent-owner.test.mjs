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

test('桌面未确认登录身份时不读也不写最近打开', () => {
  setRecentOwner(undefined, undefined)
  rememberRecent({ type: 'work', title: '匿名写的', link: '/works/anon' })
  assert.deepEqual(recentItems(), [])
})

test('桌面同一用户去重与 20 条上限', () => {
  setRecentOwner('user-c', 'workspace-c')
  rememberRecent({ type: 'work', title: '第一篇', link: '/works/1' })
  rememberRecent({ type: 'work', title: '第一篇（重复）', link: '/works/1' })
  assert.equal(recentItems().length, 1)
  assert.equal(recentItems()[0].title, '第一篇（重复）')
  for (let i = 0; i < 25; i++) {
    rememberRecent({ type: 'work', title: `第 ${i} 篇`, link: `/works/n${i}` })
  }
  assert.equal(recentItems().length, 20)
})
