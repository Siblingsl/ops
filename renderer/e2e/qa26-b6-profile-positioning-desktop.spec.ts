import { expect, test, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

// CF-P2-QA-05 批 6 桌面形态（docs/26 本地遗留表 G2-06，desktop-renderer 项目）：
// 与 web 形态 qa26-g2-profile-samples.spec.ts 的 G2-06 部分同一旅程的桌面工作台形态。
// 定位 tab（默认 tab=positioning）编辑保存 → GET 读回一致。
// 无外部依赖：人工编辑为主，AI 提炼路由不触发也能走查；不得 mock 抬交%。

async function apiFn(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ method, path, body }) => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    const response = await fetch('/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }, { method, path, body })
}

test('DEV-QA26 B6 桌面 G2-06 定位 tab 编辑保存与 GET 读回一致', async ({ page }) => {
  const account = await registerAccount(page)
  await page.goto(`/a/${account.id}/profile`)
  await expect(page.getByRole('main')).toContainText('定位')
  // 定位 tab 是默认 tab，字段与 Web 同构（Field label 包裹）。
  await page.getByLabel('目标读者', { exact: true }).fill('刚入行的运营新人')
  await page.getByLabel('人设与语气', { exact: true }).fill('克制、直接、给步骤')
  await page.getByPlaceholder('职场 效率 新人成长').fill('运营, 写作')
  await page.getByRole('button', { name: '保存档案', exact: true }).click()
  await expect(page.getByText('定位档案已保存')).toBeVisible()
  // GET 读回：三字段与 UI 填写一致（splitList 把「运营, 写作」归一为 ['运营','写作']）。
  await expect.poll(async () => {
    const p = (await apiFn(page, 'GET', `/accounts/${account.id}/profile`)) as { target_audience: string; persona_tone: string; positioning_tags: string[] }
    return p.target_audience === '刚入行的运营新人' && p.persona_tone === '克制、直接、给步骤' && p.positioning_tags.join(',') === '运营,写作'
  }).toBe(true)
})
