import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

// DEV-CX13-C / FR-CX-19：选题库存五态与 Q-CX-06 渐进核验（web 形态）。
// 存量 unknown 逐题核验后才进新排期；水位条只统计有效 ready；放弃的恢复是显式动作。

const NOTE19 = '一二三四五六七八九十一二三四五六七八九'
const NOTE20 = NOTE19 + '十'

async function openMenu(page: Page) {
  await page.getByRole('button', { name: '更多', exact: true }).click()
}

async function topicFromApi(page: Page, accountId: string, topicId: string) {
  const list = await api(page, 'GET', `/accounts/${accountId}/topics`)
  return (list as { id: string }[]).find((t) => t.id === topicId)
}

test.describe('DEV-CX13-C Web 选题库存', () => {
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟模型')

  test('存量待核验 → 核验 → 进新排期 → 取消排期 → 放弃 → 恢复，水位随动', async ({ page }) => {
    const account = await registerAccount(page, '图文笔记', 'xhs', `cx13-stock-web-${Date.now()}`)
    const created = await api(page, 'POST', `/accounts/${account.id}/topics`, {
      title: '新手如何稳定日更', angle: '从执行步骤说明',
    })
    const topicId = (created as { topic: { id: string } }).topic.id
    const topicsUrl = `/a/${account.id}/topics`
    await page.goto(topicsUrl)

    // 存量 unknown：待核验徽标 + 空库存水位（0/12，需补给 12）。
    await expect(page.getByTestId('stock-unknown')).toHaveText(/待核验/)
    const waterline = page.getByTestId('topic-stock-waterline')
    await expect(waterline).toBeVisible()
    await expect(waterline.getByTestId('stock-effective')).toContainText('0/12')
    await expect(waterline).toContainText('需补给 12')

    // 未核验 idea 不提供「进入可排期」入口，只有核验动作。
    await openMenu(page)
    await expect(page.getByRole('button', { name: '进入可排期', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '核验选题', exact: true }).click()

    // 核验对话框：note 19 码点拒绝（按钮禁用），20 码点通过。
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '核验选题', exact: true }) })
    const note = dialog.getByRole('textbox', { name: /核验说明/ })
    await note.fill(NOTE19)
    await expect(dialog.getByRole('button', { name: '确认核验', exact: true })).toBeDisabled()
    await note.fill(NOTE20)
    await dialog.getByRole('button', { name: '确认核验', exact: true }).click()
    await expect(page.getByTestId('stock-verified')).toHaveText(/已核验/)
    const verified = await topicFromApi(page, account.id, topicId)
    expect(verified?.stock_status).toBe('verified')
    expect(verified?.verified_at).toBeTruthy()

    // verified → ready：缺计划日期禁用；填日期后进入可排期并计入水位。
    await openMenu(page)
    await page.getByRole('button', { name: '进入可排期', exact: true }).click()
    const readyDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '进入可排期', exact: true }) })
    await expect(readyDialog.getByRole('button', { name: '进入可排期', exact: true })).toBeDisabled()
    await readyDialog.locator('input[type=date]').fill('2030-01-02')
    await readyDialog.getByRole('button', { name: '进入可排期', exact: true }).click()
    await expect(page.getByTestId('stock-ready')).toHaveText(/库存·可排期/)
    await expect(waterline.getByTestId('stock-effective')).toContainText('1/12')
    const ready = await topicFromApi(page, account.id, topicId)
    expect(ready?.stock_status).toBe('ready')
    expect(ready?.planned_date).toBe('2030-01-02')
    expect(ready?.status).toBe('pending')

    // ready → verified：取消排期保留核验记录，水位回落。
    await openMenu(page)
    await page.getByRole('button', { name: '取消排期', exact: true }).click()
    await expect(page.getByTestId('stock-verified')).toHaveText(/已核验/)
    await expect(waterline.getByTestId('stock-effective')).toContainText('0/12')

    // 放弃（status 直改同步 dropped）→ 已放弃 tab → 显式恢复为想法。
    await openMenu(page)
    await page.getByRole('button', { name: '放弃', exact: true }).click()
    await expect(page.getByTestId('stock-unknown')).toHaveCount(0)
    await page.goto(`${topicsUrl}?tab=dropped`)
    await openMenu(page)
    await page.getByRole('button', { name: '恢复为想法', exact: true }).click()
    await page.goto(topicsUrl)
    await expect(page.getByTestId('stock-unknown')).toHaveText(/待核验/)
    const restored = await topicFromApi(page, account.id, topicId)
    expect(restored?.stock_status).toBe('idea')
    expect(restored?.status).toBe('pending')
    // 恢复是显式动作：不继承任何核验记录（不伪造历史核验）。
    expect(restored?.verified_at).toBeFalsy()

    await page.goto(`/a/${account.id}/profile`)
    const target = page.getByLabel('目标库存', { exact: true })
    const warn = page.getByLabel('补给警戒', { exact: true })
    await expect(target).toHaveValue('12')
    await expect(warn).toHaveValue('6')
    await page.getByLabel('目标读者', { exact: true }).fill('关注效率的读者')
    const profileSave = page.waitForRequest((request) => request.url().includes(`/accounts/${account.id}/profile`) && request.method() === 'PUT')
    await page.getByRole('button', { name: '保存档案', exact: true }).click()
    expect((await profileSave).postDataJSON()).not.toHaveProperty('topic_stock_policy')
    await expect(page.getByText('定位档案已保存，之后的 AI 生成都会使用新档案')).toBeVisible()
    await target.fill('5')
    await expect(page.getByRole('button', { name: '保存档案', exact: true })).toBeDisabled()
    await target.fill('20')
    await warn.fill('8')
    await page.getByRole('button', { name: '保存档案', exact: true }).click()
    await expect.poll(async () => (await api(page, 'GET', `/accounts/${account.id}/topic-stock`) as { target: number }).target).toBe(20)
    await page.goto(topicsUrl)
    await expect(page.getByTestId('stock-effective')).toContainText('0/20')

    // 模拟编辑者界面权限；服务端拒绝越权修改由 Go 权限测试覆盖。
    await page.route('**/api/v1/auth/me', async (route) => {
      const response = await route.fetch()
      const me = await response.json()
      await route.fulfill({ response, json: { ...me, role: 'editor' } })
    })
    await page.goto(`/a/${account.id}/profile`)
    await expect(page.getByRole('button', { name: '保存档案', exact: true })).toBeVisible()
    await expect(page.getByLabel('目标库存', { exact: true })).toHaveCount(0)
    await expect(page.getByLabel('补给警戒', { exact: true })).toHaveCount(0)
  })
})
