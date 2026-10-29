import { expect, test } from '@playwright/test'
import { registerAccount } from './support'

test('Web 平台作品只读展示并提示到桌面刷新指标', async ({ page }) => {
  const account = await registerAccount(page)
  const mirror = {
    id: 'web-mirror', title: '平台作品回归', external_id: 'remote-1', platform: 'xhs',
    remote_content_type: 'image_note', remote_status: 'published', content_state: 'not_requested',
    summary: '', is_bound: false, last_seen_at: new Date().toISOString(),
    bindings: [], body_text: '', body_structure: [], media_refs: [], topics: [], tags: [],
    metric_observations: [], field_coverage: {},
  }
  await page.route(`**/api/v1/accounts/${account.id}/platform-works?**`, route => route.fulfill({ json: { items: [mirror], next_cursor: null } }))
  await page.route(`**/api/v1/accounts/${account.id}/platform-works/${mirror.id}`, route => route.fulfill({ json: { work: mirror } }))
  await page.goto(`/a/${account.id}/works?source=platform`)
  await page.getByRole('button', { name: /平台作品回归/ }).click()
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: mirror.title }) })
  await expect(dialog.getByRole('button', { name: '刷新此篇指标' })).toBeDisabled()
  await expect(dialog.getByText('请在 OPS 桌面客户端刷新平台指标。')).toBeVisible()
})
