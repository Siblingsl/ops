import { expect, test } from '@playwright/test'
import { api, createOutline, registerAccount } from './support'

test('OPT66 双标签卡片保存对比，两种选择、再次冲突及后续修订正确', async ({ page, context }) => {
  const account = await registerAccount(page, '图文卡片')
  await page.goto(`/a/${account.id}`)
  const id = await createOutline(page)
  const work = await api(page, 'GET', `/works/${id}`)
  expect(work.cards).toHaveLength(0)
  const other = await context.newPage()
  await other.goto(`/works/${id}`)
  const current = async (sectionId: string) => (await api(page, 'GET', `/works/${id}`)).sections.find((s: any) => s.id === sectionId)
  for (const [index, choice] of ['mine', 'server'].entries()) {
    const section = work.sections[index]
    const mine = page.locator(`[data-card-section="${section.id}"]`)
    const theirs = other.locator(`[data-card-section="${section.id}"]`)
    const serverText = `另一标签页保存的卡片正文 ${choice}`
    await theirs.locator('textarea').fill(serverText)
    await theirs.locator('textarea').blur()
    await expect.poll(async () => (await current(section.id)).content_md).toBe(serverText)
    const mineText = `本标签页保留的卡片正文 ${choice}`
    await mine.locator('textarea').fill(mineText)
    await mine.locator('textarea').blur()
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '这一段已在其他地方修改过', exact: true }) })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(serverText, { exact: true })).toBeVisible()
    await expect(dialog.getByText(mineText, { exact: true })).toBeVisible()
    let before = await current(section.id)
    if (choice === 'mine') {
      const newerText = '对比期间另一标签页再次保存'
      await theirs.locator('textarea').fill(newerText)
      await theirs.locator('textarea').blur()
      await expect.poll(async () => (await current(section.id)).content_md).toBe(newerText)
      await dialog.getByRole('button', { name: '保留我现在的版本', exact: true }).click()
      await expect(dialog.getByText(newerText, { exact: true })).toBeVisible()
      expect((await current(section.id)).content_md).toBe(newerText)
      before = await current(section.id)
      await dialog.getByRole('button', { name: '保留我现在的版本', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect.poll(async () => (await current(section.id)).content_md).toBe(mineText)
      expect((await current(section.id)).revision).toBe(before.revision + 1)
      await expect(mine.locator('textarea')).toHaveValue(mineText)
    } else {
      await dialog.getByRole('button', { name: '使用另一处的版本', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(mine.locator('textarea')).toHaveValue(serverText)
      expect((await current(section.id)).revision).toBe(before.revision)
    }
    before = await current(section.id)
    await mine.locator('textarea').fill(`解决冲突后继续编辑 ${choice}`)
    await mine.locator('textarea').blur()
    await expect.poll(async () => (await current(section.id)).content_md).toBe(`解决冲突后继续编辑 ${choice}`)
    expect((await current(section.id)).revision).toBe(before.revision + 1)
    await expect(dialog).toHaveCount(0)
  }
  await other.close()
})
