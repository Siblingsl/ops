import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// TL-06（docs/38 §11.3）：显式并行协作入口、一次性任务开关与任务面板范围展示的源码守卫。
// 行为/数据由 Go TestTL06ExplicitSubagentsAndRunContextInjection 与真实 Electron E2E 覆盖。
const read = (path) => readFileSync(resolve(process.cwd(), path), 'utf8')

test('TL-06：添加菜单“并行协作”仅在 subagents 开启时条件渲染，提示 2 个只读子任务（D-224）', () => {
  const addMenu = read('pages/agent/AddMenu.tsx')
  assert.match(addMenu, /subagentsEnabled/)
  // D-224（OPT-S02）：冻结能力不再以“未开放”灰色占位常驻，仅在开关显式为 true 时条件渲染。
  assert.match(addMenu, /\.\.\.\(subagentsEnabled \? \[\{ id: 'subagents' as const, label: '并行协作', hint: '本次任务允许拆成 2 个只读子任务'/)
  assert.doesNotMatch(addMenu, /未开放/)
  assert.doesNotMatch(addMenu, /disabled: !subagentsEnabled/)
})

test('TL-06：开启后显示 chip、发送 allow_subagents 并打开任务面板，切换会话重置', () => {
  const agent = ['pages/Agent.tsx', 'pages/agent/AgentComposer.tsx'].map(read).join('\n')
  assert.match(agent, /agent-subagents-chip/)
  assert.match(agent, /allow_subagents: edit \? false : subagentsArmed/)
  assert.match(agent, /allow_subagents: true/)
  assert.match(agent, /action === 'subagents'\) \{ setSubagentsArmed\(true\); setWorkbenchPanelTab\('task'\); setWorkbenchPanelOpen\(true\) \}/)
  assert.match(agent, /useEffect\(\(\) => \{ setReviewActionID\(null\); setSubagentsArmed\(false\) \}, \[conversationId\]\)/)
})

test('TL-06：任务面板展示每项范围/模型/耗用，不渲染子 run 内部字段', () => {
  const panel = read('pages/agent/DelegationPanel.tsx')
  assert.match(panel, /allowed_tool_count/)
  assert.match(panel, /context_ref_count/)
  assert.match(panel, /范围：\{d\.context_ref_count \?\? 0\} 项引用/)
  assert.match(panel, /模型 \{d\.model \|\| '继承父模型'\}/)
  assert.match(panel, /耗用 \$\{d\.usage!\.total_tokens\} tokens/)
  assert.doesNotMatch(panel, /child_run_id.*<|prompt_tokens.*<|args_json|result_json/)
})
