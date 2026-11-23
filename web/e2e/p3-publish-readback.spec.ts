import { expect, test, type Page } from '@playwright/test'
import { deflateSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { api, registerAccount } from './support'

// REF41 P3-A5：回读不一致 → 作品页逐字段显示期望/实际 → 改为手动 → 重新填写 → 一致。
// 回读证据由测试按 docs/41 P3-A1 结构写入，不使用真实平台；真实平台仍走 blocked。

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
      raw[p] = (x * 5 + y * 2) % 255
      raw[p + 1] = 90
      raw[p + 2] = (x * 2 + y * 7) % 255
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

function readback(screenshotAssetId: string, ok: boolean) {
  return {
    checked_at: new Date().toISOString(),
    adapter_version: 'xhs-fill-v1',
    ok,
    fields: {
      title: { expected_hash: 'title-expected', actual_hash: ok ? 'title-expected' : 'title-actual', ok },
      body: { expected_len: 800, actual_len: ok ? 800 : 798, ok },
      tags: { expected_count: 3, actual_count: 3, first: '#账号名', ok: true },
      cover: { expected_present: true, present: true, expected_ratio: '0.75', actual_ratio: '0.75', ok: true },
      schedule: { expected: null, actual: null, ok: true },
    },
    screenshot_asset_id: screenshotAssetId,
    tab_ref: 'tab-p3',
  }
}

async function prepareWork(page: Page, accountID: string, title: string) {
  const work = await api(page, 'POST', `/accounts/${accountID}/works`, { title })
  await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '回读不一致时停下来，不允许直接提交。' })
  await api(page, 'PUT', `/works/${work.id}/outline`, { items: [{ heading: '正文', key_point: '', material_ids: [] }], confirm: true })
  const withSection = await api(page, 'GET', `/works/${work.id}`)
  await api(page, 'PATCH', `/sections/${withSection.sections[0].id}`, {
    content_md: '这是 P3 回读核对正文，用于验证字段差异与改为手动入口。',
    base_revision: withSection.sections[0].revision,
  })
  const asset = await uploadCover(page, work.id)
  await api(page, 'PATCH', `/works/${work.id}`, { title, cover_asset_id: asset.id, tags: ['账号名'] })
  const manifest = await api(page, 'POST', `/works/${work.id}/publish-manifests/xhs`)
  expect(manifest.validation_state, JSON.stringify(manifest.validation)).toBe('valid')
  return { work, asset }
}

test('REF41 P3 回读核对：字段差异可见，改手动后可重新填写至一致', async ({ page }) => {
  test.setTimeout(180_000)
  const account = await registerAccount(page, '图文笔记', 'xhs')
  const { work, asset } = await prepareWork(page, account.id, 'P3回读核对作品')

  const created = await api(page, 'POST', `/works/${work.id}/publish-tasks`, { platforms: ['xhs'], mode: 'api' })
  expect(created.created.length, JSON.stringify(created)).toBe(1)
  const task = created.tasks[0]
  await api(page, 'POST', `/publish-tasks/${task.id}/queue`, { expected_version: 1, idempotency_key: randomUUID() })
  const filling = await api(page, 'POST', `/publish-tasks/${task.id}/transition`, {
    to: 'filling', expected_version: 2, idempotency_key: randomUUID(), evidence: { device_id: 'web-e2e' },
  })
  expect(filling.state).toBe('filling')

  // 回读不一致：正文 800 → 798，任务 failed，截图引用既有 asset 表。
  const failed = await api(page, 'POST', `/publish-tasks/${task.id}/transition`, {
    to: 'failed', expected_version: 3, idempotency_key: randomUUID(),
    error_code: 'readback_mismatch', error_message: '回读不一致，禁止提交',
    evidence: { readback: readback(asset.id, false) },
  })
  expect(failed.state).toBe('failed')
  expect(failed.last_error_code).toBe('readback_mismatch')

  await page.goto(`/works/${work.id}`)
  const panel = page.getByTestId('publish-readback-panel-xhs')
  await expect(panel).toBeVisible()
  await expect(page.getByTestId('publish-readback-status-xhs')).toContainText('不一致')
  await expect(page.getByTestId('publish-readback-field-xhs-title')).toContainText('期望')
  await expect(page.getByTestId('publish-readback-field-xhs-body')).toContainText('期望 800 字')
  await expect(page.getByTestId('publish-readback-field-xhs-body')).toContainText('实际 798 字')
  await expect(page.getByTestId('publish-readback-field-xhs-tags')).toContainText('首项 #账号名')
  await expect(page.getByTestId('publish-readback-field-xhs-cover')).toContainText('比例 0.75')
  await expect(page.getByTestId('publish-readback-field-xhs-schedule')).toContainText('期望 立即')
  const shotLink = panel.getByRole('link', { name: '查看回读截图' })
  await expect(shotLink).toHaveAttribute('href', `/api/v1/assets/${asset.id}/file`)
  await expect(page.getByTestId('publish-readback-shot-xhs')).toBeVisible()
  await expect(page.getByTestId('publish-readback-shot-xhs')).toHaveAttribute('src', `/api/v1/assets/${asset.id}/file?variant=512`)
  await expect(panel.getByRole('button', { name: '重新填写' })).toBeVisible()
  await expect(panel.getByRole('button', { name: '改为手动' })).toBeVisible()

  // 改手动：只切换通道，不自动提交；随后重新填写并回读一致。
  await panel.getByRole('button', { name: '改为手动' }).click()
  await expect(page.getByTestId('publish-task-meta-xhs')).toContainText('任务 失败')
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}/publish-tasks`))[0].mode).toBe('manual')

  await page.reload()
  await page.getByTestId('publish-readback-panel-xhs').getByRole('button', { name: '重新填写' }).click()
  await expect(page.getByTestId('publish-task-meta-xhs')).toContainText('任务 待排队')
  const queued = await api(page, 'GET', `/works/${work.id}/publish-tasks`)
  expect(queued[0].state).toBe('queued')

  await api(page, 'POST', `/publish-tasks/${task.id}/transition`, {
    to: 'filling', expected_version: queued[0].state_version, idempotency_key: randomUUID(),
    evidence: { device_id: 'web-e2e' },
  })
  const filled = await api(page, 'POST', `/publish-tasks/${task.id}/transition`, {
    to: 'filled', expected_version: queued[0].state_version + 1, idempotency_key: randomUUID(),
    evidence: { readback: readback(asset.id, true), readback_ok: true },
  })
  expect(filled.state).toBe('filled')
  const awaiting = await api(page, 'POST', `/publish-tasks/${task.id}/transition`, {
    to: 'awaiting_user', expected_version: queued[0].state_version + 2, idempotency_key: randomUUID(),
    evidence: { screenshot_asset_id: asset.id, readback: readback(asset.id, true) },
  })
  expect(awaiting.state).toBe('awaiting_user')

  await page.reload()
  await expect(page.getByTestId('publish-readback-panel-xhs')).toBeVisible()
  await expect(page.getByTestId('publish-readback-status-xhs')).toContainText('一致')
  await expect(page.getByTestId('publish-task-meta-xhs')).toContainText('任务 待你点发布')
  await expect(page.getByTestId('publish-readback-panel-xhs').getByRole('button', { name: '重新填写' })).toHaveCount(0)
  await expect(page.getByTestId('publish-readback-panel-xhs').getByRole('button', { name: '改为手动' })).toHaveCount(0)

  await page.screenshot({ path: '../.playwright-results/web/p3-publish-readback.png', fullPage: true })
})
