import { expect, test } from '@playwright/test'
import { api, createOutline, registerAccount } from './support'

test('OPT49 事实核查按素材支撑和待核实分组，仍逐条确认', async ({ page }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const id = await createOutline(page)
  const material = await api(page, 'POST', '/materials', {
    account_id: account.id,
    kind: 'data',
    content: '年度记录：去年团队完成18个项目。',
  })
  const work = await api(page, 'GET', `/works/${id}`)
  await api(page, 'PATCH', `/works/${id}`, { material_ids: [material.id], base_revision: work.revision })
  const section = work.sections[0]
  const body = '去年团队完成18个项目。转化率提升37%。'
  await page.goto(`/works/${id}`)
  const editor = page.locator(`#sec-${section.id} .tiptap`)
  await editor.fill(body)
  await expect.poll(async () => {
    const fresh = await api(page, 'GET', `/works/${id}`)
    return fresh.sections[0].content_md.trim()
  }).toBe(body)

  await page.goto(`/works/${id}/check`)
  await expect.poll(async () => (await api(page, 'GET', `/works/${id}/checks/latest`)).run?.fact_status, { timeout: 30_000 }).toBe('done')
  const { run } = await api(page, 'GET', `/works/${id}/checks/latest`)
  const facts = run.items.filter((item: any) => item.category === 'fact' && item.matched_text)
  expect(facts).toHaveLength(2)
  const supported = facts.find((item: any) => item.location.material_support)
  const unverified = facts.find((item: any) => !item.location.material_support)
  expect(supported.matched_text).toBe('去年团队完成18个项目。')
  expect(supported.location.material_support.quote).toBe('去年团队完成18个项目。')
  expect(unverified.matched_text).toBe('转化率提升37%。')
  expect(supported.resolution).toBeNull()
  expect(unverified.resolution).toBeNull()
  await expect(page.getByTestId('fact-subgroup-supported')).toContainText('有素材支撑')
  await expect(page.getByTestId('fact-subgroup-unverified')).toContainText('待核实')
  await expect(page.getByText('关联素材引句：「去年团队完成18个项目。」', { exact: true })).toBeVisible()

  const saved = page.waitForResponse((response) => response.url().endsWith(`/check-items/${supported.id}`) && response.request().method() === 'PATCH')
  const supportedRadio = page.locator(`input[name="${supported.id}"]`).first()
  await supportedRadio.click()
  expect((await saved).ok()).toBeTruthy()
  await expect(supportedRadio).toBeChecked()
  await expect.poll(async () => {
    const latest = (await api(page, 'GET', `/works/${id}/checks/latest`)).run
    return latest.items.find((item: any) => item.id === supported.id)?.resolution
  }).toBe('verified')
  const latest = (await api(page, 'GET', `/works/${id}/checks/latest`)).run
  expect(latest.items.find((item: any) => item.id === unverified.id).resolution).toBeNull()
  await expect(page.getByRole('button', { name: '确认完成检查', exact: true })).toBeDisabled()
})
