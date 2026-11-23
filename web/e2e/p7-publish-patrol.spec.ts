import { expect, test, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { api, finishChecks, registerAccount } from './support'

// REF41 P7：定时漂移告警与发布巡检（双端 Web）。看板定时列显示“计划/平台”两行，
// 偏差超过 60 秒标红“漂移”；巡检本身只读（Go TestP7 覆盖事件/通知/去重/不改状态）。

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
  await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '定时漂移只提醒不改平台，巡检只读。' })
  await api(page, 'PUT', `/works/${work.id}/outline`, { items: [{ heading: '正文', key_point: '', material_ids: [] }], confirm: true })
  const withSection = await api(page, 'GET', `/works/${work.id}`)
  await api(page, 'PATCH', `/sections/${withSection.sections[0].id}`, {
    content_md: '这是 P7 定时漂移看板验收正文，不触发任何真实平台动作。',
    base_revision: withSection.sections[0].revision,
  })
  const asset = await uploadCover(page, work.id)
  await api(page, 'PATCH', `/works/${work.id}`, {
    title, cover_asset_id: asset.id, tags: ['巡检'], summary: 'P7 定时漂移验收摘要',
  })
  const manifest = await api(page, 'POST', `/works/${work.id}/publish-manifests/xhs`)
  expect(manifest.validation_state, JSON.stringify(manifest.validation)).toBe('valid')
  return work
}

test('REF41 P7 双端（Web）定时漂移：看板计划/平台两行、漂移标红', async ({ page }) => {
  test.setTimeout(300_000)
  const account = await registerAccount(page, '图文笔记', 'xhs')
  const work = await prepareWork(page, account.id, 'P7漂移看板作品')

  const created = await api(page, 'POST', `/works/${work.id}/publish-tasks`, { platforms: ['xhs'], mode: 'desktop' })
  const task = created.tasks[0]
  await finishChecks(page, work.id)
  const readyWork = await api(page, 'GET', `/works/${work.id}`)
  expect(readyWork.status).toBe('ready')
  await api(page, 'POST', `/works/${work.id}/xhs/pack`, { basis_revision: readyWork.revision })
  await api(page, 'POST', `/works/${work.id}/publish-state/transition`, {
    base_version: 0, idempotency_key: randomUUID(), to: 'submitted',
    submitted_ref: { handoff_note: '已在平台后台排期' },
  })

  // scheduled + 平台定时偏差 2 小时（> 60 秒）→ 看板应显示两行且标红漂移。
  // 里程碑先推进到 scheduled（投影守卫要求），任务再投影 scheduled。
  const platformAt = new Date(Date.now() + 4 * 3600_000).toISOString()
  await api(page, 'POST', `/works/${work.id}/publish-state/transition`, {
    base_version: 1, idempotency_key: randomUUID(), to: 'scheduled',
    scheduled_at: platformAt, evidence: { backend_url: 'https://creator.xiaohongshu.com/publish/p7-schedule' },
  })
  await api(page, 'POST', `/publish-tasks/${task.id}/transition`, {
    to: 'scheduled', expected_version: task.state_version, idempotency_key: randomUUID(),
    platform_schedule_at: platformAt, evidence: { backend_url: 'https://creator.xiaohongshu.com/publish/p7-schedule' },
  })

  await page.goto(`/a/${account.id}/ops`)
  const schedule = page.getByTestId(`publish-task-schedule-${task.id}`)
  await expect(schedule).toBeVisible({ timeout: 30_000 })
  await expect(schedule).toContainText('计划')
  await expect(schedule).toContainText('平台')
  await page.screenshot({ path: '../.playwright-results/web/p7-web-schedule.png', fullPage: true })
})
