import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))

test('FN-10 运营目录是 480 只读抽屉，五类资料逐条引用且不批量', () => {
  const drawer = readFileSync(root + 'pages/agent/OperationDirectoryDrawer.tsx', 'utf8')
  assert.match(drawer, /width="w-\[480px\]"/)
  for (const label of ['作品', '选题', '素材', '图片', '日历']) assert.match(drawer, new RegExp(`label: '${label}'`))
  assert.match(drawer, /\/agent\/context-candidates/)
  assert.match(drawer, /\/calendar\?from=/)
  assert.match(drawer, /reference_scope: 'turn'/)
  assert.equal(/(?:全选|批量引用|全部添加|checkbox)/.test(drawer), false, '运营目录不得提供批量/多选操作')
})

test('FN-10 仅在 operations_directory 开启时出现，并复用当前账号引用', () => {
  const agent = readFileSync(root + 'pages/Agent.tsx', 'utf8')
  assert.match(agent, /bootstrapData\.features\.operations_directory === true/)
  assert.match(agent, /<OperationDirectoryDrawer[\s\S]*?accountID=\{selectedAccount\}[\s\S]*?selected=\{contextRefs\}/)
  const flags = readFileSync(root + '../server/internal/app/agent_workbench.go', 'utf8')
  assert.match(flags, /"operations_directory", "side_chat", "today_ops"/)
  const gates = readFileSync(root + '../server/internal/app/runtime_gates.go', 'utf8')
  assert.match(gates, /features\["operations_directory"\] && \(!features\["workbench_ui"\] \|\| !features\["context_refs"\]\)/)
})
