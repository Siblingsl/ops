import { expect, test } from '@playwright/test'
import { api, createOutline, registerAccount } from './support'

test('P0 PB-14 超出公众号 HTML 字符上限时阻止写入并说明限制', async ({ page }) => {
  await registerAccount(page, '长图文', 'wechat_mp')
  const workId = await createOutline(page)
  const work = await api(page, 'GET', `/works/${workId}`)
  const coverId = '00000000-0000-4000-8000-000000000001'
  const coverUrl = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
  const oversizedWork = {
    ...work,
    status: 'ready',
    sections: work.sections.map((section: Record<string, unknown>, index: number) => index === 0
      ? { ...section, content_md: '超长正文'.repeat(6000) }
      : section),
    assets: [{ id: coverId, url: coverUrl, alt_text: '测试封面' }],
  }
  const crop = { x1: 0, y1: 0, x2: 1, y2: 1 }
  await page.route(`**/api/v1/works/${workId}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    await route.fulfill({ json: oversizedWork })
  })
  await page.route(`**/api/v1/works/${workId}/wechat/push-preview`, async (route) => {
    await route.fulfill({ json: {
      mode: 'new', today_count: 0, daily_limit: 10,
      fields: { author: '', open_comment: false, fans_only_comment: false, source_url: '' },
      credential: { state: 'ok', app_id: 'wx-local-test' },
      status: 'ready', revision: work.revision, backend_url: '', can_push: true,
      material_basis_stale: false, check_revision_stale: false, asset_count: 1,
      cover_asset: coverId, cover_crops: { '2.35_1': crop, '1_1': crop },
      title: work.title, summary: '', content_format: work.content_format, panel_images: 0,
    } })
  })

  await page.goto(`/works/${workId}/push`)
  await expect(page.getByText(/排版后的正文超出公众号限制/)).toBeVisible()
  await expect(page.getByRole('button', { name: '写入草稿箱', exact: true })).toBeDisabled()
})
