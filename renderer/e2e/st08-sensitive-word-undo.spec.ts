import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount, selectDesktopSetting } from './support'

async function electronPresentation(page: Page) {
  await page.addInitScript(() => {
    const agent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${agent} Electron/44.8.0` })
    Object.defineProperty(window, 'opsDesktopUI', {
      configurable: true,
      value: {
        onOpenSettings() { return () => {} },
        onLocalSettingsState() { return () => {} },
      },
    })
  })
}

test('ST-08 deleting a custom sensitive word can be undone from the toast', async ({ page }) => {
  const account = await registerAccount(page)
  await electronPresentation(page)
  await page.goto(`/a/${account.id}`)

  await page.getByRole('button', { name: /^用户菜单/ }).click()
  await page.getByRole('menuitem', { name: '设置…', exact: true }).click()
  const settings = page.getByTestId('desktop-settings-window')
  await expect(settings).toBeVisible()
  await selectDesktopSetting(page, '敏感词库')

  const word = `st08-undo-${Date.now()}`
  await settings.getByLabel(/^敏感词/).fill(word)
  await settings.getByRole('button', { name: '添加', exact: true }).click()
  const chip = settings.getByText(word, { exact: true }).locator('xpath=..')
  await expect(chip).toBeVisible()

  await chip.getByRole('button', { name: '删除', exact: true }).click()
  const undo = page.getByRole('button', { name: '撤销', exact: true })
  await expect(undo).toBeVisible()
  await expect.poll(async () => (await api(page, 'GET', '/sensitive-words')).some((row: { word: string }) => row.word === word)).toBe(false)

  await undo.click()
  await expect.poll(async () => (await api(page, 'GET', '/sensitive-words')).some((row: { word: string }) => row.word === word)).toBe(true)
  await expect(settings.getByText(word, { exact: true })).toBeVisible()
})
