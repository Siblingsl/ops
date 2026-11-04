import assert from 'node:assert/strict'
import { test } from 'node:test'

// A-26-1：同一浏览器先后登录不同用户时，「最近打开」必须按登录用户隔离。
// 旧实现用全局 key `ops.recent`，切换用户后侧栏会把上一个用户看过的作品标题显示给下一个用户。
// 这里用 stub 的 localStorage/window 验证 recent.ts 的隔离语义（不依赖 React 与 API）。

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}
globalThis.window = { dispatchEvent() {} }

const { rememberRecent, recentItems, setRecentOwner } = await import('../src/lib/recent.ts')

test('A-26-1 未确认登录身份时不读也不写最近打开', () => {
  setRecentOwner(undefined, undefined)
  rememberRecent({ type: 'work', title: '匿名写的', link: '/works/anon' })
  assert.deepEqual(recentItems(), [])
})

test('A-26-1 两个用户各自隔离：B 看不到 A 的记录，切回 A 记录还在', () => {
  setRecentOwner('user-a', 'workspace-a')
  rememberRecent({ type: 'work', title: 'A 的作品标题', link: '/works/a1' })
  assert.equal(recentItems().length, 1)

  setRecentOwner('user-b', 'workspace-b')
  assert.deepEqual(recentItems(), [], '用户 B 不得看到用户 A 的最近打开')
  rememberRecent({ type: 'work', title: 'B 的作品标题', link: '/works/b1' })
  assert.deepEqual(recentItems().map((x) => x.title), ['B 的作品标题'])

  setRecentOwner('user-a', 'workspace-a')
  assert.deepEqual(recentItems().map((x) => x.title), ['A 的作品标题'])
  assert.ok(!store.has('ops.recent'), '不得再写旧的全局 key')
})

test('A-26-2 同一用户的最近打开按工作区隔离', () => {
  setRecentOwner('user-a', 'workspace-1')
  rememberRecent({ type: 'work', title: '工作区 1 的作品', link: '/works/work-1' })

  setRecentOwner('user-a', 'workspace-2')
  assert.deepEqual(recentItems(), [], '工作区 2 不得看到工作区 1 的作品')
  rememberRecent({ type: 'work', title: '工作区 2 的作品', link: '/works/work-2' })

  setRecentOwner('user-a', 'workspace-1')
  assert.deepEqual(recentItems().map((item) => item.title), ['工作区 1 的作品'])
})

test('A-26-1 同一用户去重与 20 条上限', () => {
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
