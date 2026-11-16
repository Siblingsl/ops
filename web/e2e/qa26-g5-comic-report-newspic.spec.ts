import { expect, test, type Page } from '@playwright/test'
import { api, finishChecks, mockModelBaseUrl, registerAccount } from './support'

// CF-P2-QA-02 批次 QA-B5（docs/26 G4-12/G5-03/G5-10，docs/34 §14.7）：
// G4-12 漫画编辑器：comic 作品 → 核心观点 → 生成分镜 → 确认分镜 → 逐格文案（存根（stub）路径断言到确认）。
// G5-03 检查报告页：完成检查后 /works/:id/check/report 打印档案渲染（标题/结论/逐项）。
// G5-10 公众号图片消息草稿：comic+panel images → H-04 逐项确认 → pushNewspic（mock wechat newspic 草稿）
// → pushed + wechat_draft_media_id 读回。真实平台写入由 mock 微信 API 承载，不代表真实草稿箱。

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

test('DEV-QA26 G4-12 漫画分镜、G5-03 报告页与 G5-10 图片消息草稿', async ({ page, baseURL }) => {
  // G5-10 图片消息草稿仅公众号有写入接口；xhs/头条按发布包手动发布。
  const account = await registerAccount(page, '漫画', 'wechat_mp', `qa26-g5-comic-${Date.now()}`)
  // 公众号凭证：mock 微信 API 通过自检 → credential.state=ok（阻断器 credOk 解除）
  await api(page, 'PUT', `/accounts/${account.id}/wechat-credential`, { app_id: 'wx1234567890', app_secret: 'local-e2e-secret' })
  await api(page, 'POST', `/accounts/${account.id}/wechat-credential/test`)
  const provider = await api(page, 'POST', '/model-providers', {
    name: 'QA-B5 漫画模拟模型', base_url: mockModelBaseUrl(), api_key: 'local-e2e-key', models: ['mock-comic-e2e'],
  })
  await api(page, 'POST', `/model-providers/${provider.id}/selftest`, {})
  await api(page, 'PUT', '/model-routes', [
    ...['default', 'outline', 'comic_storyboard', 'comic_panel_text', 'image_gen'].map((task_type) => ({ task_type, provider_id: provider.id, model: 'mock-comic-e2e' })),
  ])

  // G4-12：comic 作品 → 观点 → 生成分镜 → 确认分镜
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'QA-B5 漫画作品' })
  await page.goto(`/works/${work.id}`)
  await page.getByPlaceholder(/用一两句话写下这组漫画要表达的观点/).fill('工具不是越多越好，留下真正顺手的三件就够。')
  await page.getByRole('button', { name: /生成分镜/ }).first().click()
  // storyboard/generate 只在响应中给 panels（不落库）；「确认分镜」PUT 后才持久化。
  await page.getByRole('button', { name: /确认分镜/ }).first().click()
  await expect(page.getByText('分镜已确认')).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => {
    const w = (await api(page, 'GET', `/works/${work.id}`)) as { panels?: Array<{ id: string }>; outline_confirmed_at?: string | null }
    return (w.panels ?? []).length
  }, { timeout: 30_000 }).toBeGreaterThan(0)

  // 逐格文案（mock comic_panel_text）：panels/{id}/text → narration 读回（全部格）
  const w1 = (await api(page, 'GET', `/works/${work.id}`)) as { panels: Array<{ id: string }> }
  for (const p of w1.panels) {
    await api(page, 'POST', `/panels/${p.id}/text`, {})
  }
  await expect.poll(async () => {
    const w = (await api(page, 'GET', `/works/${work.id}`)) as { panels?: Array<{ narration?: string }> }
    return (w.panels ?? []).filter(p => (p.narration ?? '').length > 0).length
  }, { timeout: 60_000 }).toBe(w1.panels.length)

  // 每格生成图片（panel generate-image，mock 1x1 PNG）——检查项 panel_images 要求全部格都有图
  for (const p of w1.panels) {
    await api(page, 'POST', `/panels/${p.id}/generate-image`, {})
  }
  await expect.poll(async () => {
    const w = (await api(page, 'GET', `/works/${work.id}`)) as { panels?: Array<{ asset_id?: string | null }> }
    return (w.panels ?? []).filter(p => p.asset_id).length
  }, { timeout: 120_000 }).toBe(w1.panels.length)

  // G5-03：完成检查（H-04 逐项）→ 报告页渲染
  await finishChecks(page, work.id)
  await page.goto(`/works/${work.id}/check/report`)
  await expect(page.getByText(/检查报告|发布前检查/).first()).toBeVisible()
  await expect.poll(async () => {
    const report = (await apiFn(page, 'GET', `/works/${work.id}/checks/report`)) as { items?: unknown[]; run?: { id?: string } | null }
    return !!report.run || (report.items ?? []).length > 0
  }).toBe(true)

  // G5-10：公众号图片消息草稿（mock wechat newpic）。预览生成后按钮才可用。
  await page.goto(`/works/${work.id}/push`)
  await expect(page.getByRole('button', { name: '写入图片消息草稿' })).toBeEnabled({ timeout: 60_000 })
  await page.getByRole('button', { name: '写入图片消息草稿' }).click()
  await expect.poll(async () => {
    const w = (await api(page, 'GET', `/works/${work.id}`)) as { status?: string; wechat_draft_media_id?: string | null }
    return w.status === 'pushed' && !!w.wechat_draft_media_id
  }, { timeout: 60_000 }).toBe(true)
})
