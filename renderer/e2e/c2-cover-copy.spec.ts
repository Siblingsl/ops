import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

async function useDesktopPresentation(page: Page) {
  await page.addInitScript(() => {
    const apply = () => {
      document.documentElement.dataset.presentation = 'ops-creative-desktop'
      document.documentElement.dataset.theme = 'light'
      document.documentElement.dataset.reducedMotion = 'soft'
    }
    if (document.documentElement) apply()
    else document.addEventListener('DOMContentLoaded', apply, { once: true })
  })
}

/**
 * REF41 C2：封面文案规则、实时字数与超长/禁用词阻止生成（桌面工作台形态）。
 * 进入桌面编辑器布局，校验同一 /cover-presets 规则与构建 options；服务端仍逐预设复核。
 */
const coverCrops = {
  '2.35_1': { x1: 0, y1: 0.1, x2: 1, y2: 0.6 },
  '1_1': { x1: 0.2, y1: 0, x2: 0.8, y2: 1 },
}

async function wechatWork(page: Page, origin: string, accountId: string, title: string) {
  const work = await api(page, 'POST', `/accounts/${accountId}/works`, { title, content_format: 'long_article' })
  const viewed = await api(page, 'PATCH', `/works/${work.id}`, {
    viewpoint: '桌面封面文案验收：主标题不超过十个字，副标题不超过十六个字。', base_revision: work.revision,
  })
  return await api(page, 'PUT', `/works/${work.id}/outline`, {
    confirm: true, base_revision: viewed.revision,
    items: [{ heading: '封面文案', key_point: '可读性与字数上限', material_ids: [] }],
  }) as { id: string }
}

async function uploadCover(page: Page, origin: string, workId: string, width: number, height: number) {
  return page.evaluate(async ({ origin, workId, width, height }) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')!
    const gradient = ctx.createLinearGradient(0, 0, width, height)
    gradient.addColorStop(0, '#2f6fed')
    gradient.addColorStop(1, '#f5a524')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, width, height)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
    const me = await (await fetch(`${origin}/api/v1/auth/me`)).json()
    const form = new FormData()
    form.append('file', new File([blob], 'cover-copy.png', { type: 'image/png' }))
    const response = await fetch(`${origin}/api/v1/works/${workId}/assets`, { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': me.csrf_token }, body: form })
    if (!response.ok) throw new Error(`upload asset: ${response.status} ${await response.text()}`)
    return (await response.json() as { id: string }).id
  }, { origin, workId, width, height })
}

async function setCover(page: Page, workId: string, assetId: string) {
  const current = await api(page, 'GET', `/works/${workId}`) as { revision: number }
  await api(page, 'PATCH', `/works/${workId}`, { cover_asset_id: assetId, cover_crops: coverCrops, base_revision: current.revision })
}

test('C2 桌面封面文案规则、字数校验与超长阻止生成', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  const origin = baseURL ?? 'http://127.0.0.1:5287'
  const account = await registerAccount(page, '长图文', 'wechat_mp', undefined, origin)
  const work = await wechatWork(page, origin, account.id, '桌面封面文案验收')
  await setCover(page, work.id, await uploadCover(page, origin, work.id, 1600, 1200))
  await useDesktopPresentation(page)
  await page.goto(`${origin}/works/${work.id}`)
  await expect(page.getByTestId('desktop-editor-layout')).toBeVisible()
  await expect(page.getByTestId('desktop-editor-steps')).toBeVisible()
  const panel = page.getByTestId('cover-build-panel')
  await expect(panel).toBeVisible()
  const editor = panel.getByTestId('cover-copy-editor')
  await expect(editor).toBeVisible()
  await expect(editor).toContainText('主标题')
  await expect(panel.getByTestId('cover-copy-title-count')).toContainText('0/10 字')
  await expect(panel.getByTestId('cover-copy-subtitle-count')).toContainText('0/16 字')

  await panel.getByTestId('cover-copy-title').fill('这是一个超过十个字的主标题')
  await expect(panel.getByTestId('cover-copy-title-count')).toContainText('/10 字')
  await expect(panel.getByTestId('cover-copy-error')).toContainText('主标题超长')
  await expect(panel.getByRole('button', { name: '生成交付包', exact: true })).toBeDisabled()
  await panel.getByTestId('cover-copy-title').fill('封面文案')
  await panel.getByTestId('cover-copy-subtitle').fill('这是一段明显超过十六个字的副标题内容用于测试')
  await expect(panel.getByTestId('cover-copy-subtitle-count')).toContainText('/16 字')
  await expect(panel.getByTestId('cover-copy-error')).toContainText('副标题超长')

  await panel.getByTestId('cover-copy-title').fill('震惊封面')
  await panel.getByTestId('cover-copy-subtitle').fill('')
  await expect(panel.getByTestId('cover-copy-error')).toContainText('禁用词')
  await expect(panel.getByTestId('cover-copy-suggestion-0')).toBeVisible()
  await panel.getByTestId('cover-copy-suggestion-0').click()
  await expect(panel.getByTestId('cover-copy-title')).not.toHaveValue('震惊封面')

  await panel.getByTestId('cover-copy-title').fill('封面文案验收')
  await panel.getByTestId('cover-copy-subtitle').fill('先把封面写清楚')
  await expect(panel.getByTestId('cover-copy-error')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '生成交付包', exact: true })).toBeEnabled()
  const created = page.waitForResponse((response) => response.url().endsWith(`/works/${work.id}/builds`) && response.request().method() === 'POST')
  await panel.getByRole('button', { name: '生成交付包', exact: true }).click()
  const response = await created
  expect(response.status()).toBe(201)
  const payload = response.request().postDataJSON() as { options: { presets: string[]; title?: string; subtitle?: string } }
  expect(payload.options.title).toBe('封面文案验收')
  expect(payload.options.subtitle).toBe('先把封面写清楚')
  expect(payload.options.presets).toEqual(['wechat_235', 'wechat_square'])
  await expect(panel.getByText(/逐预设像素校验已完成/)).toBeVisible({ timeout: 20_000 })

  // C2-N6 产品口径：字段不足时如实少给，不用模板凑数。
  const titleOnly = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '只有标题', content_format: 'long_article' })
  await setCover(page, titleOnly.id, await uploadCover(page, origin, titleOnly.id, 1600, 1200))
  await page.goto(`${origin}/works/${titleOnly.id}`)
  const titleOnlyPanel = page.getByTestId('cover-build-panel')
  await expect(titleOnlyPanel).toBeVisible()
  await expect(titleOnlyPanel.getByTestId('cover-copy-suggestions-short')).toContainText('仅 1 套建议')
})
