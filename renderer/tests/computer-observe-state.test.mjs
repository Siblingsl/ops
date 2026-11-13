// DEV-CU P5-2（docs/36 §P5-2 / §4.5 / §4.2 / §6-C03）：观察状态机三组组件级断言。
// 仓库没有 jsdom / testing-library，按既有口径用 vite ssrLoadModule 直接加载 TS 状态模块，
// 断言与组件共享同一套纯逻辑；组件只负责渲染，不含额外判断。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true }, logLevel: 'silent' })
const mod = await server.ssrLoadModule('/lib/computer-observe-state.ts')

const node = (over = {}) => ({
  ref_id: '', role: 'edit', name: '', value: '', available_actions: [], states: [],
  bounds: { x: 0, y: 0, width: 10, height: 10 }, children_count: 0, depth: 0, children: [], ...over,
})
const observeOk = (over = {}) => ({
  ok: true, snapshot_id: 's1abc', revision: 3, ref_count: 2, complete: true,
  identity_unproven: false,
  tree: node({ ref_id: '@s1abc:e1', role: 'edit', name: '搜索框', value: '',
    children: [node({ ref_id: '@s1abc:b1', role: 'button', name: '搜索', value: '' })] }),
  ...over,
})

// ① 授权成功 → 观察：进入 ready，展示 snapshot_id / revision / ref_count / 摘要项。
test('P5-2 ① 授权成功即观察：ready 展示 snapshot_id / revision / ref_count', () => {
  let s = mod.initialComputerObserveState
  assert.equal(s.phase, 'idle')
  assert.equal(mod.computerObserveCanAct(s), false)

  s = mod.beginComputerAuthorize()
  assert.equal(s.phase, 'authorizing')
  s = mod.beginComputerObserve({ grantId: 'g-1', generation: 7 })
  assert.equal(s.phase, 'observing')
  assert.equal(s.grantId, 'g-1')
  assert.equal(s.generation, 7)

  s = mod.applyComputerObserve(s, observeOk())
  assert.equal(s.phase, 'ready')
  assert.equal(s.snapshotId, 's1abc')
  assert.equal(s.revision, 3)
  assert.equal(s.refCount, 2)
  assert.equal(s.complete, true)
  assert.equal(s.identityUnproven, false)
  assert.equal(s.items.length, 2)
  // 只四键：不含标题 / 进程 / 句柄 / bounds / available_actions
  assert.deepEqual(Object.keys(s.items[0]).sort(), ['name', 'ref', 'role', 'value'])
  assert.deepEqual(s.items.map((i) => i.ref), ['@s1abc:e1', '@s1abc:b1'])
  assert.equal(JSON.stringify(s).includes('title'), false, '摘要不得带窗口标题')
  assert.equal(mod.computerObserveCanAct(s), true)
  assert.equal(mod.isCurrentComputerRef(s, '@s1abc:e1'), true)
  assert.equal(mod.isCurrentComputerRef(s, '@s0old:e1'), false)
})

// ② 观察失败：码原样保留、16 码给中文提示、表外码回落 message、旧快照不残留。
test('P5-2 ② 观察失败：中文提示 + 码 + 旧快照清空', () => {
  const ready = mod.applyComputerObserve(
    mod.beginComputerObserve({ grantId: 'g-1', generation: 7 }),
    observeOk(),
  )
  const stale = mod.applyComputerObserve(ready, {
    ok: false, code: 'computer_stale_ref', message: '目标窗口已变化',
  })
  assert.equal(stale.phase, 'failed')
  assert.equal(stale.code, 'computer_stale_ref')
  assert.equal(stale.hint, '目标已变化，需要重新观察后再操作。')
  assert.equal(stale.snapshotId, '')
  assert.equal(stale.revision, 0)
  assert.deepEqual(stale.items, [])
  assert.equal(mod.computerObserveCanAct(stale), false)

  const busy = mod.applyComputerObserve(ready, {
    ok: false, code: 'computer_foreground_busy', message: '前台被占用',
  })
  assert.match(busy.hint, /前台/)

  // 表外码不吞错：原样透出服务端 message
  const unknown = mod.applyComputerObserve(ready, {
    ok: false, code: 'computer_worker_unavailable', message: '本机窗口枚举不可用（req-abcdef123456）',
  })
  assert.equal(unknown.hint, '本机窗口枚举不可用（req-abcdef123456）')
  assert.equal(unknown.code, 'computer_worker_unavailable')
})

// ③ 每次动作前重新观察（C03）：消费后旧 ref 失效，必须重新观察；跨快照 ref 亦失效。
test('P5-2 ③ 快照消费与修订：旧 ref 一律失效，重新观察后换新快照', () => {
  const ready = mod.applyComputerObserve(
    mod.beginComputerObserve({ grantId: 'g-1', generation: 7 }),
    observeOk(),
  )
  const consumed = mod.consumeComputerSnapshot(ready)
  assert.equal(consumed.phase, 'consumed')
  assert.deepEqual(consumed.items, [])
  assert.equal(mod.computerObserveCanAct(consumed), false)
  assert.equal(mod.isCurrentComputerRef(consumed, '@s1abc:e1'), false, '消费后旧 ref 必须失效')

  const next = mod.applyComputerObserve(consumed, observeOk({ snapshot_id: 's2def', revision: 4 }))
  assert.equal(next.phase, 'ready')
  assert.equal(next.revision, 4)
  assert.equal(mod.isCurrentComputerRef(next, '@s1abc:e1'), false, '跨快照旧 ref 失效')
  assert.equal(mod.isCurrentComputerRef(next, '@s2def:e1'), true)

  // 未 ready 的状态被 consume 原样返回，不会把 failed 洗成 consumed
  const failed = mod.applyComputerObserve(next, { ok: false, code: 'computer_timeout', message: '超时' })
  assert.equal(mod.consumeComputerSnapshot(failed).phase, 'failed')
})

// ④ 摘要截断与上限：name 80 / value 60、最多 8 项、无 ref 节点跳过、深树不炸。
test('P5-2 ④ 摘要只取白名单字段并截断，最多 8 项', () => {
  const children = []
  for (let i = 0; i < 20; i += 1) {
    children.push(node({ ref_id: `@s1abc:e${i}`, name: `控件${i}`, value: i === 0 ? 'v'.repeat(200) : '' }))
  }
  const tree = node({ ref_id: '@s1abc:root', role: 'window', name: 'n'.repeat(200), children })
  const items = mod.summarizeObserveTree(tree, 8)
  assert.equal(items.length, 8)
  assert.equal(items[0].name.length, 80)
  assert.equal(items[0].name.endsWith('…'), true)
  assert.equal(items[1].value.length, 60)
  assert.equal(items.every((i) => Object.keys(i).sort().join(',') === 'name,ref,role,value'), true)

  const noRef = node({ ref_id: '', children: [node({ ref_id: '', role: 'text' })] })
  assert.deepEqual(mod.summarizeObserveTree(noRef), [])
})

await server.close()
