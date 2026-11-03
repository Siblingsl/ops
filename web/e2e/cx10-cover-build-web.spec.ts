import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

/**
 * DEV-CX10 / FR-CX-09：多比例封面交付构建（cover_images）。
 *
 * 断言的是"用户看得见的行为"：面板只给当前平台合法预设、低分辨率必须确认后才能放大、
 * 一次点击完成渲染→打包→创建→上传→complete；服务端逐预设校验像素与文件名，
 * complete 仍停在 scanner_unverified，不置 built、不开放下载，也不新建派生图片。
 * 服务端契约由 `server/internal/app/cx10_cover_build_test.go` 覆盖。
 */

const coverCrops = {
  '2.35_1': { x1: 0, y1: 0.1, x2: 1, y2: 0.6 },
  '1_1': { x1: 0.2, y1: 0, x2: 0.8, y2: 1 },
}

async function wechatWork(page: Page, accountId: string, title: string) {
  const work = await api(page, 'POST', `/accounts/${accountId}/works`, { title, content_format: 'long_article' })
  // H-02：确认大纲前必须先写下自己的核心观点。
  const viewed = await api(page, 'PATCH', `/works/${work.id}`, {
    viewpoint: '封面交付验收：公众号头条大图与转发小图来自同一张封面。', base_revision: work.revision,
  })
  const outlined = await api(page, 'PUT', `/works/${work.id}/outline`, {
    confirm: true, base_revision: viewed.revision,
    items: [{ heading: '封面预设', key_point: '多比例封面验收', material_ids: [] }],
  })
  return outlined as { id: string; sections: { id: string }[] }
}

/** 在页面里用 canvas 生成一张确定性的 PNG 并作为作品图片上传，返回资产。 */
async function uploadCover(page: Page, workId: string, width: number, height: number) {
  return page.evaluate(async ({ workId, width, height }) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')!
    const gradient = ctx.createLinearGradient(0, 0, width, height)
    gradient.addColorStop(0, '#2f6fed')
    gradient.addColorStop(1, '#f5a524')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(10, 10, 32, 32)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
    const me = await (await fetch('/api/v1/auth/me')).json()
    const form = new FormData()
    form.append('file', new File([blob], 'cover.png', { type: 'image/png' }))
    const response = await fetch(`/api/v1/works/${workId}/assets`, { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': me.csrf_token }, body: form })
    const body = await response.text()
    if (!response.ok) throw new Error(`upload asset: ${response.status} ${body}`)
    return JSON.parse(body) as { id: string }
  }, { workId, width, height })
}

async function setCover(page: Page, workId: string, assetId: string) {
  const current = await api(page, 'GET', `/works/${workId}`) as { revision: number }
  return api(page, 'PATCH', `/works/${workId}`, {
    cover_asset_id: assetId, cover_crops: coverCrops, base_revision: current.revision,
  })
}

test('CX10 浏览器多比例封面交付构建逐预设校验与隐私门禁', async ({ page }) => {
  test.setTimeout(120_000)
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const work = await wechatWork(page, account.id, '封面交付构建')
  const panel = page.getByTestId('cover-build-panel')

  // 1) 低分辨率封面：500×400 的源图对两个预设都要放大，必须先确认才允许生成，且不会创建构建。
  const small = await uploadCover(page, work.id, 500, 400)
  await setCover(page, work.id, small.id)
  await page.goto(`/works/${work.id}`)
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId('cover-preset-options')).toContainText('900×383')
  await expect(panel.getByTestId('cover-preset-options')).toContainText('383×383')
  await expect(panel.getByTestId('cover-preset-options')).not.toContainText('1080×1440')
  await expect(panel.getByText(/需要放大输出/)).toBeVisible()
  await panel.getByRole('button', { name: '生成交付包', exact: true }).click()
  await expect(panel.getByText(/请确认接受放大后重试/)).toBeVisible()
  let uploads = 0
  page.on('request', (r) => { if (r.method() === 'POST' && /\/builds\/[0-9a-f-]+\/artifacts/.test(r.url())) uploads++ })
  await page.waitForTimeout(400)
  expect(uploads).toBe(0)
  await panel.getByRole('checkbox', { name: /放大不会增加细节/ }).check()
  await panel.getByRole('button', { name: '生成交付包', exact: true }).click()
  await expect(panel.getByText(/逐预设像素校验已完成/)).toBeVisible({ timeout: 20_000 })

  // 2) 清晰封面：预设独立命名，逐预设像素写入 validation，门禁保持关闭。
  const big = await uploadCover(page, work.id, 1600, 1200)
  await setCover(page, work.id, big.id)
  await page.reload()
  await expect(panel).toBeVisible()
  await expect(panel.getByText(/需要放大输出/)).toHaveCount(0)
  const created = page.waitForResponse((r) => r.url().endsWith(`/works/${work.id}/builds`) && r.request().method() === 'POST')
  const completion = page.waitForResponse((r) => r.url().includes('/complete') && r.request().method() === 'POST')
  await panel.getByRole('button', { name: '生成交付包', exact: true }).click()
  const createResponse = await created
  expect(createResponse.status()).toBe(201)
  const createBody = await createResponse.json() as { build_id: string; status: string }
  expect(createBody.status).toBe('running')
  const completionResponse = await completion
  expect(completionResponse.status()).toBe(503)
  expect(await completionResponse.text()).toContain('scanner_unverified')
  await expect(panel.getByTestId('cover-build-detail')).toContainText('cover-wechat_235-900x383.png 900×383')
  await expect(panel.getByTestId('cover-build-detail')).toContainText('cover-wechat_square-383x383.png 383×383')
  await expect(panel.getByTestId('cover-build-detail')).toContainText('scanner_unverified')
  await expect(panel.getByTestId('cover-build-detail')).toContainText('下载门禁：build_not_complete')

  const builds = await api(page, 'GET', `/works/${work.id}/builds`) as { items: Array<{ id: string; status: string; error_code: string; is_current: boolean; targets: string[] }> }
  expect(builds.items[0]).toMatchObject({ status: 'failed', error_code: 'scanner_unverified', is_current: true, targets: ['cover_images'] })
  const detail = await api(page, 'GET', `/builds/${builds.items[0].id}`) as {
    artifacts: Array<{ kind: string; downloadable: boolean }>
    validation: { covers: { count: number; entries: Array<{ name: string; width: number; height: number }> } }
    download_gate: { allowed: boolean; reason: string }
  }
  expect(detail.artifacts.map((item) => item.kind)).toEqual(['zip'])
  expect(detail.artifacts.every((item) => !item.downloadable)).toBe(true)
  expect(detail.download_gate).toMatchObject({ allowed: false, reason: 'build_not_complete' })
  expect(detail.validation.covers.count).toBe(2)
  expect(detail.validation.covers.entries.map((entry) => entry.name)).toEqual(['cover-wechat_235-900x383.png', 'cover-wechat_square-383x383.png'])

  // 不新建派生 asset：构建完成后作品图片数不变（仍是两张上传图）。
  expect(((await api(page, 'GET', `/works/${work.id}`)) as { assets: unknown[] }).assets).toHaveLength(2)
})
