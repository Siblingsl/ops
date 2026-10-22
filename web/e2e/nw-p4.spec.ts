import { expect, test } from '@playwright/test'
import { api, createOutline, registerAccount } from './support'

test('NW-C5 观点冲突时弹出对比，不静默覆盖', async ({ page }) => {
  const account = await registerAccount(page)
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '冲突验收' })
  await page.goto(`/works/${work.id}`)
  const viewpoint = page.locator('#step-viewpoint textarea').first()
  await viewpoint.fill('我这一版的观点')

  // 另一个标签页抢先保存，服务端 revision 前进。
  const fresh = await api(page, 'GET', `/works/${work.id}`)
  await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '另一处的观点', base_revision: fresh.revision })

  await viewpoint.blur()
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '核心观点已在其他地方修改过', exact: true }) })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('另一处的观点')).toBeVisible()
  await expect(dialog.getByText('我这一版的观点')).toBeVisible()
  await dialog.getByRole('button', { name: '保留我现在的版本', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`)).viewpoint).toBe('我这一版的观点')
})

test('NW-C5 标题回车即保存', async ({ page }) => {
  const account = await registerAccount(page)
  const id = await createOutline(page)
  await page.goto(`/works/${id}`)
  const title = page.getByRole('textbox', { name: '标题' })
  await title.fill('回车保存的标题')
  await title.press('Enter')
  await expect.poll(async () => (await api(page, 'GET', `/works/${id}`)).title).toBe('回车保存的标题')
})

test('NW-B5 首次路径包含"写下第一篇作品"', async ({ page }) => {
  await registerAccount(page)
  await expect(page.getByText('从第一篇作品开始')).toBeVisible()
  await expect(page.getByText('写下第一篇作品')).toBeVisible()
})
