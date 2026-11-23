import { expect, test } from '@playwright/test'
import { deflateSync } from 'node:zlib'
import { api, registerAccount } from './support'

// 3:4 PNG，用来验证小红书封面比例；不依赖额外图片库。
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

function makePNG(width: number, height: number) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const offset = row + 1 + x * 4
      raw[offset] = (x * 7 + y * 3) % 255
      raw[offset + 1] = (x * 3 + y * 5) % 255
      raw[offset + 2] = 140
      raw[offset + 3] = 255
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

async function uploadCover(page: import('@playwright/test').Page, workId: string) {
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const response = await page.request.post(`/api/v1/works/${workId}/assets`, {
    headers: { 'X-CSRF-Token': me.csrf_token },
    multipart: { file: { name: 'cover.png', mimeType: 'image/png', buffer: makePNG(900, 1200) } },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  return response.json()
}

test('REF41 P1 双端发布分区：生成 → block → 改稿 → 重新生成', async ({ page }) => {
  test.setTimeout(90_000)
  const account = await registerAccount(page, '图文笔记', 'xhs')
  const longTitle = '这是一条故意超过二十个字的小红书发布标题用于触发长度校验'
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: longTitle })
  await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '先准备字段，再逐项校验，最后才考虑发布。' })
  await api(page, 'PUT', `/works/${work.id}/outline`, { items: [{ heading: '正文', key_point: '', material_ids: [] }], confirm: true })
  const withSection = await api(page, 'GET', `/works/${work.id}`)
  await api(page, 'PATCH', `/sections/${withSection.sections[0].id}`, {
    content_md: '这是发布正文，用于验证 manifest 的长度、标签和封面规则。',
    base_revision: withSection.sections[0].revision,
  })
  const asset = await uploadCover(page, work.id)
  await api(page, 'PATCH', `/works/${work.id}`, { title: longTitle, cover_asset_id: asset.id, tags: ['测试'] })

  await page.goto(`/works/${work.id}`)
  const panel = page.getByTestId('publish-manifest-panel')
  await expect(panel).toBeVisible()
  const card = panel.getByTestId('publish-platform-xhs')
  await expect(card.getByTestId('publish-status-xhs')).toHaveText('素材已备好')
  await card.getByRole('button', { name: '生成', exact: true }).click()
  await expect(card.getByTestId('publish-status-xhs')).toHaveText('校验未通过')
  await expect(card.getByTestId('publish-checks-xhs')).toContainText('标题需为 1–20 字')

  // 改稿：标题变短，稿子 revision 变化，manifest 读取时变 stale。
  await page.locator('.work-title button').click()
  await page.getByLabel('作品标题').fill('P1 小红书短标题')
  await page.getByLabel('作品标题').press('Enter')
  await expect(card.getByTestId('publish-status-xhs')).toHaveText('已过期')
  await expect(card.getByRole('button', { name: '重新生成', exact: true })).toBeVisible()

  await card.getByRole('button', { name: '重新生成', exact: true }).click()
  await expect(card.getByTestId('publish-status-xhs')).toHaveText('素材已备好')
  await expect(card.getByText('全部 block 项通过', { exact: true })).toBeVisible()
  // 未回填公开链接前，不能出现假“已发布”。
  await expect(card.getByTestId('publish-status-xhs')).not.toHaveText('已发布')

  await page.screenshot({ path: '../.playwright-results/web/p1-publish-manifest.png', fullPage: true })
})
