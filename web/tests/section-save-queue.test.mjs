import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSectionSaveQueue } from '../src/pages/work/section-save-queue.ts'

const turn = () => new Promise(resolve => setImmediate(resolve))

test('OPT63 同段只有一个保存在途，排队修改合并完整快照并使用最新修订', async () => {
  const calls = []
  const gates = []
  let revision = 1
  let active = 0
  let peak = 0
  const queue = createSectionSaveQueue(async snapshot => {
    active++
    peak = Math.max(peak, active)
    calls.push({ ...snapshot, base_revision: revision })
    await new Promise(resolve => gates.push(resolve))
    revision++
    active--
    return true
  })
  const first = queue.enqueue({ heading: '标题一', content_md: '正文一' })
  await turn()
  const second = queue.enqueue({ heading: '标题二', content_md: '正文一' })
  const third = queue.enqueue({ heading: '标题二', content_md: '正文二' })
  assert.equal(calls.length, 1)
  assert.equal(queue.busy, true)
  let flushed = false
  const flushedResult = queue.flush().then(saved => { flushed = true; return saved })
  gates.shift()()
  assert.equal(await first, true)
  await turn()
  assert.equal(flushed, false)
  assert.deepEqual(calls[1], { heading: '标题二', content_md: '正文二', base_revision: 2 })
  gates.shift()()
  assert.deepEqual(await Promise.all([second, third, flushedResult]), [true, true, true])
  assert.equal(peak, 1)
  assert.equal(revision, 3)
  assert.equal(queue.busy, false)
})

test('OPT63 冲突停止后续保存，flush 失败；人工处理后可再次保存', async () => {
  let release
  let count = 0
  const queue = createSectionSaveQueue(async () => {
    count++
    if (count === 1) {
      await new Promise(resolve => { release = resolve })
      return false
    }
    return true
  })
  const first = queue.enqueue({ heading: '旧标题', content_md: '旧正文' })
  await turn()
  const second = queue.enqueue({ heading: '新标题', content_md: '新正文' })
  const flushed = queue.flush()
  release()
  assert.deepEqual(await Promise.all([first, second, flushed]), [false, false, false])
  assert.equal(count, 1)
  assert.equal(await queue.enqueue({ heading: '人工选择', content_md: '人工选择的正文' }), true)
  await queue.flush()
  assert.equal(count, 2)
})

test('OPT63 保存前的同步修改合并，接受 AI 的元信息随快照保留', async () => {
  const calls = []
  const queue = createSectionSaveQueue(async snapshot => { calls.push(snapshot); return true })
  const first = queue.enqueue({ heading: '标题', content_md: 'AI 候选', applied: { kind: 'rewrite', ai_call_id: 'test-call' } })
  const second = queue.enqueue({ heading: '人工改标题', content_md: 'AI 候选' })
  assert.deepEqual(await Promise.all([first, second]), [true, true])
  await queue.flush()
  assert.deepEqual(calls, [{ heading: '人工改标题', content_md: 'AI 候选', applied: { kind: 'rewrite', ai_call_id: 'test-call' } }])
})

test('OPT63 成功回调立即追加保存仍会执行，flush 等待追加快照', async () => {
  const calls = []
  let release
  const queue = createSectionSaveQueue(async snapshot => {
    calls.push(snapshot)
    if (calls.length === 2) await new Promise(resolve => { release = resolve })
    return true
  })
  assert.equal(await queue.enqueue({ heading: '先保存', content_md: '第一版' }), true)
  const second = queue.enqueue({ heading: '回调追加', content_md: '第二版' })
  let flushed = false
  const waiting = queue.flush().then(saved => { flushed = true; return saved })
  await turn()
  assert.equal(calls.length, 2)
  assert.equal(flushed, false)
  release()
  assert.deepEqual(await Promise.all([second, waiting]), [true, true])
})
