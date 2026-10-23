import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runFlushers } from '../src/pages/work/work-save-queue.ts'

const turn = () => new Promise(resolve => setImmediate(resolve))

test('NW-C4 同作品字段按顺序保存，后一个等待前一个完成', async () => {
  const started = []
  let release
  const running = runFlushers([
    async () => { started.push('viewpoint'); await new Promise(resolve => { release = resolve }) },
    async () => { started.push('title-summary') },
    async () => { started.push('images') },
  ])
  await turn()
  assert.deepEqual(started, ['viewpoint'])
  release()
  await running
  assert.deepEqual(started, ['viewpoint', 'title-summary', 'images'])
})

test('NW-C4 保存失败会阻止后续字段刷新', async () => {
  const started = []
  await assert.rejects(runFlushers([
    async () => { started.push('viewpoint'); throw new Error('save failed') },
    async () => { started.push('title-summary') },
  ]), /save failed/)
  assert.deepEqual(started, ['viewpoint'])
})
