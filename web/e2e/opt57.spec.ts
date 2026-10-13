import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('OPT57 收集后一次点击去整理，空素材入口与逐条可选关联当前作品', async ({ page }) => {
  const account = await registerAccount(page)
  await page.keyboard.press('Control+Shift+i')
  const collect = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '随手记', exact: true }) })
  await collect.getByPlaceholder('一句话也行：看到的、想到的、被问到的…').fill('这条灵感稍后存为素材，不自动关联。')
  await collect.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('button', { name: '去整理', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/a/${account.id}/topics(?:\\?|$)`))
  await expect(page.getByText('这条灵感稍后存为素材，不自动关联。', { exact: true })).toBeVisible()
  const second = await api(page, 'POST', '/inbox', { account_id: account.id, content: '这条由作者确认后关联当前作品。' })
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '整理素材验收' })
  await page.goto(`/works/${work.id}`)
  await page.getByRole('button', { name: '选择素材', exact: true }).click()
  await expect(page.getByRole('link', { name: '去素材库添加', exact: true })).toHaveAttribute('href', `/a/${account.id}/materials`)
  await page.getByRole('button', { name: '从收件箱整理', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/works/${work.id}$`))
  await page.getByText('这条灵感稍后存为素材，不自动关联。', { exact: true }).locator('..').getByRole('button', { name: '整理', exact: true }).click()
  const convert = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '整理这条灵感', exact: true }) })
  await convert.getByRole('button', { name: '存为素材', exact: true }).first().click()
  await expect(convert.getByRole('checkbox', { name: '同时关联到当前作品', exact: true })).not.toBeChecked()
  await convert.getByRole('button', { name: '存为素材', exact: true }).last().click()
  await expect(convert).toHaveCount(0)
  expect((await api(page, 'GET', `/works/${work.id}`)).material_ids).toEqual([])
  const existing = await api(page, 'POST', '/materials', { account_id: account.id, kind: 'case', content: '已有选择应保留。' })
  let latest = await api(page, 'GET', `/works/${work.id}`)
  await api(page, 'PATCH', `/works/${work.id}`, { material_ids: [existing.id], base_revision: latest.revision })
  let converts = 0
  page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith(`/inbox/${second.id}/convert`)) converts++ })
  let failLink = true
  await page.route(`**/api/v1/works/${work.id}`, route => {
    if (route.request().method() === 'PATCH' && failLink) {
      failLink = false
      return route.fulfill({ status: 503, json: { error: { code: 'temporarily_unavailable', message: '关联暂时失败' } } })
    }
    return route.continue()
  })
  await page.getByText(second.content, { exact: true }).locator('..').getByRole('button', { name: '整理', exact: true }).click()
  await convert.getByRole('button', { name: '存为素材', exact: true }).first().click()
  await convert.getByRole('checkbox', { name: '同时关联到当前作品', exact: true }).check()
  await convert.getByRole('button', { name: '存为素材', exact: true }).last().click()
  await expect(convert.getByText('素材已存入，可重试关联当前作品，或取消关联后完成。')).toBeVisible()
  await convert.getByRole('button', { name: '重试关联', exact: true }).click()
  await expect(convert).toHaveCount(0)
  latest = await api(page, 'GET', `/works/${work.id}`)
  expect(latest.material_ids).toContain(existing.id)
  expect(latest.material_ids).toHaveLength(2)
  expect(converts).toBe(1)
  expect((await api(page, 'GET', '/inbox')).find((item: { id: string }) => item.id === second.id)).toBeUndefined()
})
