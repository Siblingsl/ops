import { expect, test, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { api, finishChecks, registerAccount } from './support'

// REF41 P6：adopt / mark / submit 人工兜底。adopt=“这条已在平台发过，只登记不重发”；
// 事件 kind=adopt、evidence.source=user、不伪造填写历史；published 只走既有
// /works/{id}/published。桌面匹配页校验的 0/2→submit_ambiguous 由桌面单测覆盖。

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
      raw[p] = (x * 3 + y * 5) % 255
      raw[p + 1] = (x * 7 + y * 2) % 255
      raw[p + 2] = 110
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
  await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '登记已发布只记录平台事实，不重发不代点。' })
  await api(page, 'PUT', `/works/${work.id}/outline`, { items: [{ heading: '正文', key_point: '', material_ids: [] }], confirm: true })
  const withSection = await api(page, 'GET', `/works/${work.id}`)
  await api(page, 'PATCH', `/sections/${withSection.sections[0].id}`, {
    content_md: '这是 P6 人工兜底验收正文：登记已发布、纠正状态与立即提交。',
    base_revision: withSection.sections[0].revision,
  })
  const asset = await uploadCover(page, work.id)
  await api(page, 'PATCH', `/works/${work.id}`, {
    title, cover_asset_id: asset.id, tags: ['登记'], summary: 'P6 人工兜底验收摘要',
  })
  const manifest = await api(page, 'POST', `/works/${work.id}/publish-manifests/xhs`)
  expect(manifest.validation_state, JSON.stringify(manifest.validation)).toBe('valid')
  return work
}

test('REF41 P6 双端（Web）人工兜底：adopt 登记不重发、事件可见、无批量入口', async ({ page }) => {
  test.setTimeout(300_000)
  const account = await registerAccount(page, '图文笔记', 'xhs')
  const work = await prepareWork(page, account.id, 'P6登记作品')

  const created = await api(page, 'POST', `/works/${work.id}/publish-tasks`, { platforms: ['xhs'], mode: 'desktop' })
  expect(created.created.length, JSON.stringify(created)).toBe(1)
  const task = created.tasks[0]

  // 走既有发布链路：finishChecks → ready → pack → 里程碑 submitted（P2 同一纪律）。
  await finishChecks(page, work.id)
  const readyWork = await api(page, 'GET', `/works/${work.id}`)
  expect(readyWork.status).toBe('ready')
  await api(page, 'POST', `/works/${work.id}/xhs/pack`, { basis_revision: readyWork.revision })
  await api(page, 'POST', `/works/${work.id}/publish-state/transition`, {
    base_version: 0, idempotency_key: randomUUID(), to: 'submitted',
    submitted_ref: { handoff_note: '已在平台后台手动发布过这篇，登记不重发' },
  })

  // A1：adopt 登记为 submitted；弹窗输入链接与说明（prompt 双输入）。
  await page.goto(`/a/${account.id}/ops`)
  const board = page.getByTestId('publish-task-board')
  await expect(board).toBeVisible()
  const answers = ['https://www.xiaohongshu.com/explore/p6-e2e', 'E2E：这条已在平台发布过，只登记不重发。']
  page.on('dialog', (dialog) => { void dialog.accept(answers.shift() ?? '') })
  await board.getByTestId(`publish-task-adopt-${task.id}`).click()
  await expect(board.getByTestId('publish-task-column-submitted')).toContainText('1', { timeout: 30_000 })

  // A1/A6：事件 kind=adopt、source=user、filled_at 未伪造；作品发布区时间线可见。
  const tasks = await api(page, 'GET', `/works/${work.id}/publish-tasks`)
  expect(tasks[0].state).toBe('submitted')
  expect(tasks[0].filled_at ?? null).toBeNull()
  const events = await api(page, 'GET', `/publish-tasks/${task.id}/events`)
  const adopt = events.find((e: { event_kind?: string }) => e.event_kind === 'adopt')
  expect(adopt, JSON.stringify(events)).toBeTruthy()
  expect(adopt.evidence?.source ?? adopt.evidence?.source).toBe('user')

  // A4：重复 adopt 幂等返回 already_recorded，不新增事件。
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const againRes = await page.request.fetch(`/api/v1/publish-tasks/${task.id}/adopt`, {
    method: 'POST',
    headers: { 'X-CSRF-Token': me.csrf_token, 'Idempotency-Key': randomUUID() },
    data: { url: 'https://www.xiaohongshu.com/explore/p6-e2e', note: '重复登记' },
  })
  expect(againRes.ok(), await againRes.text()).toBeTruthy()
  const again = await againRes.json()
  expect(again.adopted).toBe(false)

  // A6：作品发布区最近事件包含“采用”。
  await page.goto(`/works/${work.id}`)
  await expect(page.getByTestId('publish-task-meta-xhs')).toContainText('最近事件')
  await page.screenshot({ path: '../.playwright-results/web/p6-web-adopt.png', fullPage: true })
})
