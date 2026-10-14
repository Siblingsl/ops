import { expect, test } from '@playwright/test'
import { registerAccount } from './support'

test('OPT30 作品列表与图片库使用缩略图，图片库详情仍读原图', async ({ page }) => {
  const account = await registerAccount(page)
  const assetId = '6e5dc31c-ff13-4e2f-a14d-3b29cf70cc30'
  const assetUrl = `/api/v1/assets/${assetId}/file`
  const asset = {
    id: assetId,
    work_id: 'f8d8458f-7a68-4a24-a882-805f4df11130',
    mime: 'image/jpeg',
    width: 900,
    height: 500,
    bytes: 32000,
    position: 0,
    url: assetUrl,
    ai_generated: false,
    created_at: new Date().toISOString(),
    account_id: account.id,
    account_name: account.name,
    work_title: 'OPT30 图片库验收作品',
  }
  const work = {
    id: asset.work_id,
    title: asset.work_title,
    status: 'drafting',
    content_format: 'image_note',
    source_work_id: null,
    source_title: null,
    derived_count: 0,
    cover_asset_id: assetId,
    first_asset_id: assetId,
    char_count: 0,
    section_count: 0,
    published_at: null,
    updated_at: new Date().toISOString(),
  }
  await page.route(url => url.pathname === '/api/v1/assets' && url.search === '', route => route.fulfill({ json: [asset] }))
  await page.route(url => url.pathname === `/api/v1/accounts/${account.id}/works`, route => route.fulfill({ json: [work] }))
  await page.route('**/api/v1/assets/**/file*', route => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU3sAAAAASUVORK5CYII=', 'base64'),
  }))

  await page.goto('/images')
  await expect(page.locator(`img[src="${assetUrl}?variant=256"]`)).toBeVisible()
  await page.getByRole('button', { name: /OPT30 图片库验收作品/ }).click()
  await expect(page.getByRole('dialog').locator('img')).toHaveAttribute('src', assetUrl)

  await page.goto(`/a/${account.id}/works`)
  await expect(page.locator(`img[src="${assetUrl}?variant=256"]`)).toBeVisible()
})
