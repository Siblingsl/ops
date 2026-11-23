import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// FN-02：PendingList 为 TSX 组件，逻辑在组件内；守卫直接断言源码行为契约。
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'pages/agent/PendingList.tsx'), 'utf8')
const workbench = readFileSync(join(root, 'pages/agent/Workbench.tsx'), 'utf8')

test('FN-02：待处理中心只收集 pending 卡片与问题，过期可标记、空不渲染', () => {
  // 收集范围：卡片 pending/needs_input；问题 pending。
  assert.match(source, /action\.status !== 'pending' && action\.status !== 'needs_input'/)
  assert.match(source, /question\.status !== 'pending'/)
  // 空列表不渲染块。
  assert.match(source, /if \(!entries\.length\) return null/)
  // 过期条目标记且不给定位按钮。
  assert.match(source, /is-expired/)
  assert.match(source, /!entry\.expired && <button/)
  // >5 条折叠为查看全部。
  assert.match(source, /entries\.slice\(0, 5\)/)
  assert.match(source, /查看全部/)
  // 定位：scrollIntoView + data-highlight 1.5s。
  assert.match(source, /scrollIntoView\(\{ behavior: 'smooth', block: 'center' \}\)/)
  assert.match(source, /data-highlight/, '1.5s')
  assert.match(source, /setTimeout[\s\S]{0,80}1_500\)/)
  // Workbench 任务页在标题下挂载，来自真实 actions/questions。
  assert.match(workbench, /<PendingList entries=\{collectPendingEntries\(actions, questions \?\? \[\]\)\} \/>/)
})
