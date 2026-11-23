import { expect, test, type Page } from '@playwright/test'
import { deflateSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { api, finishChecks, registerAccount } from './support'

// REF41 P2-A7：3 条任务走完 ready → queued → filling → filled → awaiting_user → submitted，
// 看板只展示状态与逐条动作，不允许出现“批量发布/全部执行/全部确认”入口。

function crc32(data: Buffer) {
  let c = 0xffffffff
  for (const byte of data) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer) {
  const typeBuf = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

function coverPNG(width: number, height: number) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 4
      raw[p] = (x * 7 + y * 3) % 255
      raw[p + 1] = (x * 3 + y * 5) % 255
      raw[p + 2] = 140
      raw[p + 3] = 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

async function uploadCover(page: Page, workId: string) {
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const response = await page.request.post(`/api/v1/works/${workId}/assets`, {
    headers: { 'X-CSRF-Token': me.csrf_token },
    multipart: { file: { name: 'cover.png', mimeType: 'image/png', buffer: coverPNG(900, 1200) } },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  return response.json()
}

async function prepareWork(page: Page, accountID: string, title: string) {
  const work = await api(page, 'POST', `/accounts/${accountID}/works`, { title })
  await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '先建任务，再逐条推进，最后人工确认。' })
  await api(page, 'PUT', `/works/${work.id}/outline`, { items: [{ heading: '正文', key_point: '', material_ids: [] }], confirm: true })
  const withSection = await api(page, 'GET', `/works/${work.id}`)
  await api(page, 'PATCH', `/sections/${withSection.sections[0].id}`, {
    content_md: '这是 P2 发布任务正文，用于验证任务状态机与看板文案。',
    base_revision: withSection.sections[0].revision,
  })
  const asset = await uploadCover(page, work.id)
  await api(page, 'PATCH', `/works/${work.id}`, { title, cover_asset_id: asset.id, tags: ['任务'] })
  const manifest = await api(page, 'POST', `/works/${work.id}/publish-manifests/xhs`)
  expect(manifest.validation_state, JSON.stringify(manifest.validation)).toBe('valid')
  return work
}

async function assertNoBatchEntries(page: Page) {
  const forbidden = page.getByRole('button', { name: /批量发布|全部执行|全部确认|批量确认|全部起草|一键发布|批量填写|批量提交/ })
  await expect(forbidden).toHaveCount(0)
  const forbiddenLinks = page.getByRole('link', { name: /批量发布|全部执行|全部确认|批量确认|一键发布/ })
  await expect(forbiddenLinks).toHaveCount(0)
}

test('REF41 P2 双端（Web）发布任务看板：3 条任务逐条推进，无批量发布入口', async ({ page }) => {
  test.setTimeout(180_000)
  const account = await registerAccount(page, '图文笔记', 'xhs')
  const works = [] as Awaited<ReturnType<typeof prepareWork>>[]
  for (let i = 1; i <= 3; i++) works.push(await prepareWork(page, account.id, `P2任务作品${i}`))

  const tasks = [] as { id: string; state_version: number }[]
  for (const work of works) {
    const created = await api(page, 'POST', `/works/${work.id}/publish-tasks`, { platforms: ['xhs'], mode: 'api' })
    expect(created.created.length, JSON.stringify(created)).toBe(1)
    tasks.push(created.tasks[0])
  }
  expect(tasks).toHaveLength(3)

  await page.goto(`/a/${account.id}/ops`)
  const board = page.getByTestId('publish-task-board')
  await expect(board).toBeVisible()
  await expect(board.getByTestId('publish-task-column-queue')).toContainText('3')
  for (const task of tasks) await expect(board.getByTestId(`publish-task-${task.id}`)).toBeVisible()
  await assertNoBatchEntries(page)

  // 逐条推进：排队 → 模拟领取（填写中）→ 回读一致 → 已填入待用户点发布。
  for (const task of tasks) {
    const queued = await api(page, 'POST', `/publish-tasks/${task.id}/queue`, {
      expected_version: 1, idempotency_key: randomUUID(),
    })
    expect(queued.state).toBe('queued')
    const filling = await api(page, 'POST', `/publish-tasks/${task.id}/transition`, {
      to: 'filling', expected_version: 2, idempotency_key: randomUUID(),
      evidence: { device_id: 'web-e2e' },
    })
    expect(filling.state).toBe('filling')
    const filled = await api(page, 'POST', `/publish-tasks/${task.id}/transition`, {
      to: 'filled', expected_version: 3, idempotency_key: randomUUID(),
      evidence: { readback: { ok: true }, readback_ok: true },
    })
    expect(filled.state).toBe('filled')
    const awaiting = await api(page, 'POST', `/publish-tasks/${task.id}/transition`, {
      to: 'awaiting_user', expected_version: 4, idempotency_key: randomUUID(),
      evidence: { screenshot_asset_id: randomUUID() },
    })
    expect(awaiting.state).toBe('awaiting_user')
  }

  await page.reload()
  await expect(board.getByTestId('publish-task-column-filled')).toContainText('3')
  await assertNoBatchEntries(page)

  // 用户逐条确认：每条作品先走既有检查与发布包链路登记 submitted 里程碑，再由任务投影为已提交。
  for (let i = 0; i < tasks.length; i++) {
    const work = works[i]
    await finishChecks(page, work.id)
    const readyWork = await api(page, 'GET', `/works/${work.id}`)
    expect(readyWork.status).toBe('ready')
    await api(page, 'POST', `/works/${work.id}/xhs/pack`, { basis_revision: readyWork.revision })
    await api(page, 'POST', `/works/${work.id}/publish-state/transition`, {
      base_version: 0, idempotency_key: randomUUID(), to: 'submitted',
      submitted_ref: { handoff_note: '已在平台后台点击发布并回填公开链接' },
    })
    const submitted = await api(page, 'POST', `/publish-tasks/${tasks[i].id}/transition`, {
      to: 'submitted', expected_version: 5, idempotency_key: randomUUID(),
    })
    expect(submitted.state).toBe('submitted')
  }

  await page.goto(`/a/${account.id}/ops`)
  await expect(board.getByTestId('publish-task-column-submitted')).toContainText('3')
  await expect(board.getByTestId('publish-task-column-filled')).toContainText('0')
  await assertNoBatchEntries(page)

  // 作品发布区显示单篇任务状态、尝试次数、最近事件，而不是假“已发布”。
  await page.goto(`/works/${works[0].id}`)
  const meta = page.getByTestId('publish-task-meta-xhs')
  await expect(meta).toContainText('任务 已提交')
  await expect(meta).toContainText('尝试')
  await expect(meta).toContainText('最近事件')
  await assertNoBatchEntries(page)

  await page.goto(`/a/${account.id}/ops`)
  await expect(board).toBeVisible()
  await page.screenshot({ path: '../.playwright-results/web/p2-publish-task-board.png', fullPage: true })
})
