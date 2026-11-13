// DEV-CU P5-4：电脑控制条的源码级守卫（仓库无 jsdom，组件渲染不进单测）。
// 守住：七态齐全、三入口可达、接管/停止走既有接口、unsupported/disconnected 有明确文案。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../pages/agent/ComputerControlBar.tsx', import.meta.url)), 'utf8')
const page = readFileSync(fileURLToPath(new URL('../pages/Agent.tsx', import.meta.url)), 'utf8')

test('P5-4 七态齐全且顺序可派生', () => {
  for (const phase of ['observing', 'acting', 'waiting_confirmation', 'human_owned', 'stopping', 'disconnected', 'unsupported']) {
    assert.match(src, new RegExp(`'${phase}'`), `缺状态 ${phase}`)
  }
  assert.match(src, /export function computerControlPhase/)
  for (const label of ['观察中', '正在操作', '等待你确认', '已由你接管', '正在停止', '连接已断开', '当前界面不支持自动操作']) {
    assert.match(src, new RegExp(label), `缺状态文案 ${label}`)
  }
})

test('P5-4 三个入口可达：接管 / 停止任务 / 返回聊天', () => {
  for (const label of ['接管', '停止任务', '返回聊天']) assert.match(src, new RegExp(`>\\s*${label}\\s*<`))
  assert.match(src, /computerApi\.handoff\(grant\.id\)/, '接管必须走既有 handoff')
  assert.match(src, /`\/agent\/runs\/\$\{runId\}\/cancel`/, '停止任务必须先取消当前 run')
  assert.match(src, /computerApi\.revoke\(grant\.id\)/, '停止任务必须撤销租约')
  assert.match(src, /onReturnChat/)
})

test('P5-4 unsupported 显示具体原因，不收缩为白名单应用', () => {
  assert.match(src, /capabilities\.available === false/)
  assert.match(src, /原因：\$\{reason\}/)
  assert.match(src, /不会把整个产品收缩为白名单应用/)
  assert.equal(/白名单应用列表|仅支持\s*Word|仅支持\s*Excel/.test(src), false)
})

test('P5-4 断线态：离线 / 锁屏 / 前台丢失都转 disconnected', () => {
  assert.match(src, /\['offline', 'disconnected', 'lost'\]/)
  assert.match(src, /\['lost', 'background'\]/)
  assert.match(src, /已停止接收新输入/)
})

test('P5-4 页面接线：控制条随计算机特性挂载', () => {
  assert.match(page, /import \{ ComputerControlBar \} from '@\/pages\/agent\/ComputerControlBar'/)
  assert.match(page, /<ComputerControlBar/)
  assert.match(page, /features\.computer_use === true/)
  assert.equal(/全部执行|批量执行/.test(src), false)
})
