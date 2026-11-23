import { expect, test, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { api, finishChecks, registerAccount } from './support'

// REF41 P4：三平台×三通道能力矩阵、禁用原因、四态文案。
// 不使用真实平台账号；桌面离线/未校准按缺连接与缺成功校准的真实事实展示。

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
  await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '先看清能力与禁用原因，再逐篇人工确认。' })
  await api(page, 'PUT', `/works/${work.id}/outline`, { items: [{ heading: '正文', key_point: '', material_ids: [] }], confirm: true })
  const withSection = await api(page, 'GET', `/works/${work.id}`)
  await api(page, 'PATCH', `/sections/${withSection.sections[0].id}`, {
    content_md: '这是 P4 发布能力与四态文案验收正文，不触发任何真实平台发布。',
    base_revision: withSection.sections[0].revision,
  })
  const asset = await uploadCover(page, work.id)
  await api(page, 'PATCH', `/works/${work.id}`, {
    title, cover_asset_id: asset.id, tags: ['能力'], summary: 'P4 发布能力矩阵验收摘要',
  })
  const manifest = await api(page, 'POST', `/works/${work.id}/publish-manifests/xhs`)
  expect(manifest.validation_state, JSON.stringify(manifest.validation)).toBe('valid')
  return { work, asset }
}

test('REF41 P4 双端（Web）能力矩阵、禁用原因与四态文案', async ({ page }) => {
  test.setTimeout(300_000)
  const account = await registerAccount(page, '图文笔记', 'xhs')
  const wechat = await api(page, 'POST', '/accounts', {
    platform: 'wechat_mp', name: 'P4 无凭证公众号', content_format: 'long_article',
  })
  const wechatWork = await api(page, 'POST', `/accounts/${wechat.id}/works`, { title: 'P4 公众号能力' })

  // A1：三平台×三通道字段完整；A4：缺凭证原因可见且按钮禁用。
  await page.goto(`/works/${wechatWork.id}`)
  for (const platform of ['wechat_mp', 'xhs', 'toutiao']) {
    const panel = page.getByTestId(`publish-capability-panel-${platform}`)
    await expect(panel).toBeVisible()
    for (const channel of ['api', 'desktop', 'manual']) {
      await expect(page.getByTestId(`publish-capability-${platform}-${channel}`)).toBeVisible()
    }
  }
  await expect(page.getByTestId('publish-capability-disabled-wechat_mp-api')).toBeDisabled()
  await expect(page.getByTestId('publish-capability-reason-wechat_mp-api')).toContainText('缺少公众号 AppID/Secret')
  await expect(page.getByTestId('publish-capability-available-wechat_mp-manual')).toContainText('可用')
  for (const platform of ['wechat_mp', 'xhs', 'toutiao']) {
    await expect(page.getByTestId(`publish-status-${platform}`)).toContainText('素材已备好')
  }
  await page.screenshot({ path: '../.playwright-results/web/p4-web-capability-wechat.png', fullPage: true })

  const { work, asset } = await prepareWork(page, account.id, 'P4 能力与四态作品')
  await page.goto(`/works/${work.id}`)
  await expect(page.getByTestId('publish-capability-xhs-desktop')).toBeVisible()
  await expect(page.getByTestId('publish-capability-disabled-xhs-desktop')).toBeDisabled()
  await expect(page.getByTestId('publish-capability-reason-xhs-desktop')).toContainText('桌面客户端未连接')
  await expect(page.getByTestId('publish-capability-reason-xhs-desktop')).toContainText('该账号尚未完成一次成功填写')
  await expect(page.getByTestId('publish-status-xhs')).toContainText('素材已备好')

  const created = await api(page, 'POST', `/works/${work.id}/publish-tasks`, { platforms: ['xhs'], mode: 'api' })
  expect(created.created.length, JSON.stringify(created)).toBe(1)
  const task = created.tasks[0]
  await api(page, 'POST', `/publish-tasks/${task.id}/queue`, { expected_version: 1, idempotency_key: randomUUID() })
  await api(page, 'POST', `/publish-tasks/${task.id}/transition`, {
    to: 'filling', expected_version: 2, idempotency_key: randomUUID(), evidence: { device_id: 'web-e2e-p4' },
  })
  const filled = await api(page, 'POST', `/publish-tasks/${task.id}/transition`, {
    to: 'filled', expected_version: 3, idempotency_key: randomUUID(),
    evidence: { readback: { ok: true, adapter_version: 'xhs-fill-v1', fields: {} }, readback_ok: true },
  })
  expect(filled.state).toBe('filled')
  await page.reload()
  await expect(page.getByTestId('publish-status-xhs')).toContainText('已填入后台')

  const awaiting = await api(page, 'POST', `/publish-tasks/${task.id}/transition`, {
    to: 'awaiting_user', expected_version: 4, idempotency_key: randomUUID(),
    evidence: { screenshot_asset_id: asset.id, readback: { ok: true, screenshot_asset_id: asset.id } },
  })
  expect(awaiting.state).toBe('awaiting_user')
  await page.reload()
  await expect(page.getByTestId('publish-status-xhs')).toContainText('已填入后台（待你点发布）')

  await finishChecks(page, work.id)
  const readyWork = await api(page, 'GET', `/works/${work.id}`)
  expect(readyWork.status).toBe('ready')
  await api(page, 'POST', `/works/${work.id}/xhs/pack`, { basis_revision: readyWork.revision })
  await api(page, 'POST', `/works/${work.id}/publish-state/transition`, {
    base_version: 0, idempotency_key: randomUUID(), to: 'submitted',
    submitted_ref: { handoff_note: '已在平台后台人工点击发布' },
  })
  const submitted = await api(page, 'POST', `/publish-tasks/${task.id}/transition`, {
    to: 'submitted', expected_version: 5, idempotency_key: randomUUID(),
  })
  expect(submitted.state).toBe('submitted')
  await page.reload()
  await expect(page.getByTestId('publish-status-xhs')).toContainText('已交接')

  // A3：只有 work.status=published 才出现“已发布”。
  const published = await prepareWork(page, account.id, 'P4 已发布作品')
  await finishChecks(page, published.work.id)
  const readyPublished = await api(page, 'GET', `/works/${published.work.id}`)
  await api(page, 'POST', `/works/${published.work.id}/xhs/pack`, { basis_revision: readyPublished.revision })
  // 为公众号/头条建任务，使 meta 行真实存在，验证跨平台不显示“已发布”。
  await api(page, 'POST', `/works/${published.work.id}/publish-manifests/wechat_mp`, {})
  await api(page, 'POST', `/works/${published.work.id}/publish-manifests/toutiao`, {})
  await api(page, 'POST', `/works/${published.work.id}/publish-tasks`, { platforms: ['wechat_mp', 'toutiao'], mode: 'desktop' })
  await api(page, 'POST', `/works/${published.work.id}/published`, {})
  await page.goto(`/works/${published.work.id}`)
  await expect(page.getByTestId('publish-status-xhs')).toContainText('已发布')
  // 非作品平台：xhs pack 推进 publish_revision 后其 manifest 合法地变为 stale（“已过期”），
  // 但绝不得出现“已发布”。接受 packed/stale 两种真实状态。
  const wechatBadge = page.getByTestId('publish-status-wechat_mp')
  const toutiaoBadge = page.getByTestId('publish-status-toutiao')
  await expect(wechatBadge.filter({ hasNotText: '已发布' })).toBeVisible()
  await expect(toutiaoBadge.filter({ hasNotText: '已发布' })).toBeVisible()
  // meta 行不得出现“已发布”（P4-A3：badge 与 meta 行共用平台守卫；任务已建，meta 行必在）。
  await expect(page.getByTestId('publish-task-meta-wechat_mp')).not.toContainText('已发布')
  await expect(page.getByTestId('publish-task-meta-toutiao')).not.toContainText('已发布')
  await expect(page.getByTestId('publish-capability-xhs-desktop')).toBeVisible()
  await expect(page.getByTestId('publish-capability-reason-xhs-desktop')).toContainText('桌面客户端未连接')
  await page.screenshot({ path: '../.playwright-results/web/p4-web-capability-published.png', fullPage: true })

  // 禁止批量入口在能力面板出现后仍然不存在。
  const forbidden = page.getByRole('button', { name: /批量发布|全部执行|全部确认|批量确认|一键发布|批量填写|批量提交/ })
  await expect(forbidden).toHaveCount(0)
})
