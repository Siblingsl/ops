// DEV-CU P5-3：电脑操作确认卡片的源码级守卫（仓库无 jsdom，组件渲染不进单测）。
// 守住四件事：
// 1) computer_command 卡片不走 /agent/actions/{id}/execute，而是带 card_id+approval_hash
//    走 /agent/computer/commands；
// 2) 一次点击只发一条命令（请求体取卡片内绑定的 payload，不被本地编辑改写）；
// 3) unknown_outcome 明确提示人工核对、不提供重试入口；
// 4) 全页不存在「全部执行」类批量入口。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const cards = readFileSync(fileURLToPath(new URL('../pages/agent/ActionCards.tsx', import.meta.url)), 'utf8')
const page = readFileSync(fileURLToPath(new URL('../pages/Agent.tsx', import.meta.url)), 'utf8')
const types = readFileSync(fileURLToPath(new URL('../lib/agent.ts', import.meta.url)), 'utf8')

test('P5-3 类型：AgentAction 暴露电脑执行凭据', () => {
  assert.match(types, /computer_execution\?: \{/)
  for (const key of ['grant_id', 'generation', 'action_kind', 'payload', 'target_ref', 'approval_hash']) {
    assert.match(types, new RegExp(key), `computer_execution 必须含 ${key}`)
  }
})

test('P5-3 执行：电脑卡片走电脑命令入口，带 card_id + approval_hash', () => {
  assert.match(cards, /if \(action\.computer_execution && request\)/)
  assert.match(cards, /post<[^>]*>\('/)
  assert.match(cards, /\/agent\/computer\/commands/)
  assert.match(cards, /card_id: action\.id/)
  assert.match(cards, /approval_hash: exec\.approval_hash/)
  assert.match(cards, /payload: exec\.payload/, '执行载荷必须取卡片绑定值，不能被本地编辑替换')
  assert.match(cards, /request_id: crypto\.randomUUID\(\)/)
})

test('P5-3 单选：一次点击只发一条命令，无批量执行', () => {
  // 分支内只允许出现一次命令 POST；出现 second post 或循环即视为批量入口。
  const block = cards.slice(cards.indexOf('if (action.computer_execution && request)'), cards.indexOf('if (request) {'))
  assert.equal(block.split('/agent/computer/commands').length - 1, 1)
  assert.equal(/forEach|\.map\(/.test(block), false)
  assert.equal(/全部执行|批量执行/.test(cards), false)
  assert.equal(/全部执行|批量执行/.test(page), false)
})

test('P5-3 未知结果：提示人工核对且不出现重试入口', () => {
  assert.match(cards, /result\?\.state === 'unknown_outcome'/)
  assert.match(cards, /命令可能已生效/)
  assert.match(cards, /不要重复操作/)
  assert.match(cards, /status: 'failed'/)
  assert.equal(/重试|retry/i.test(cards), false, '卡片不得提供 unknown_outcome 重试入口')
})
