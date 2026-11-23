// REF41 P2-A7（桌面）：桌面看板独立实现，同样不得出现批量执行入口。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const root = process.cwd()
const board = readFileSync(join(root, 'components/publish-task-board.tsx'), 'utf8')
const manifest = readFileSync(join(root, 'components/publish-manifest.tsx'), 'utf8')

test('桌面发布任务看板具备文档要求的列与逐条操作', () => {
  for (const label of ['待排队', '填写中', '已填入待你点', '已提交', '已预约', '已发布', '失败', '掉线', '重试', '改为手动', '跳过']) {
    assert.ok(board.includes(label), `桌面看板缺少文案：${label}`)
  }
})

test('桌面看板与作品发布区不提供批量执行按钮', () => {
  const bulkButton = /<Button[^>]*>\s*(批量发布|全部执行|全部确认|一键发布|批量执行|全部入库)/m
  assert.equal(bulkButton.test(board), false, '桌面看板出现批量执行按钮')
  assert.equal(bulkButton.test(manifest), false, '桌面作品发布区出现批量执行按钮')
  assert.ok(manifest.includes('最近事件'), '桌面作品发布区必须显示最近事件')
  assert.ok(manifest.includes('attempt'), '桌面作品发布区必须显示尝试次数')
})
