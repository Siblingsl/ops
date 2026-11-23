import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { TODAY_OPS_BLOCK_ORDER, todayOpsWelcomeSummary, visibleTodayOpsItems } from '../lib/today-ops.js'

test('FN-11 六块顺序固定，每块最多只展示 3 条', () => {
  assert.deepEqual(TODAY_OPS_BLOCK_ORDER, ['pending', 'publishing', 'today', 'comments', 'routines', 'risks'])
  const items = Array.from({ length: 5 }, (_, index) => ({ id: `i${index}` }))
  assert.equal(visibleTodayOpsItems({ items }).length, 3)
  assert.equal(visibleTodayOpsItems({ items: [] }).length, 0)
  assert.equal(visibleTodayOpsItems({}).length, 0)
})

test('FN-11 欢迎摘要只在 today_ops 数据存在时显示，并优先提示风险', () => {
  assert.equal(todayOpsWelcomeSummary(null), '')
  assert.equal(todayOpsWelcomeSummary({ summary: { pending: 3, risks: 0, publishing: 2 } }), '今天 3 项待处理 · 2 条待发布 · 查看今日运营')
  assert.equal(todayOpsWelcomeSummary({ summary: { pending: 3, risks: 1, publishing: 2 } }), '今天 3 项待处理 · 1 项风险 · 查看今日运营')
})

test('FN-11 前端门控：today_ops 必须同时具备 workbench_ui，完整页不进入 Shell 一级导航', () => {
  const agent = readFileSync(new URL('../pages/Agent.tsx', import.meta.url), 'utf8')
  const shell = readFileSync(new URL('../layout/Shell.tsx', import.meta.url), 'utf8')
  assert.match(agent, /const todayOpsEnabled = workbenchUI && bootstrapData\?\.features\?\.today_ops === true/)
  assert.match(agent, /todayOpsEnabled && todayOpsOpen && <TodayOpsPanel/)
  assert.doesNotMatch(shell, /today_ops|今日运营/, '不得改 Shell.tsx 的菜单项或分组')
})

test('FN-11 只读：聚合组件和端点不得出现批量/写入动作', () => {
  const panel = readFileSync(new URL('../pages/agent/TodayOpsPanel.tsx', import.meta.url), 'utf8')
  const endpoint = readFileSync(new URL('../../server/internal/app/agent_today_ops.go', import.meta.url), 'utf8')
  assert.doesNotMatch(panel, /(全部处理|全部执行|一键处理|批量处理|批量执行)/)
  assert.doesNotMatch(endpoint, /(INSERT INTO|UPDATE |DELETE FROM)/)
})
