import { expect, test, type Page } from '@playwright/test'
import { api, createOutline, registerAccount } from './support'

async function passChecks(page: Page, workID: string) {
  const initial = await api(page, 'GET', `/works/${workID}/checks/latest`) as { run?: { fact_status: string } }
  if (!initial.run) await api(page, 'POST', `/works/${workID}/checks`, {})
  await expect.poll(async () => {
    const latest = await api(page, 'GET', `/works/${workID}/checks/latest`) as { run?: { fact_status: string } }
    return latest.run?.fact_status !== 'pending'
  }, { timeout: 20_000 }).toBeTruthy()
  const { run } = await api(page, 'GET', `/works/${workID}/checks/latest`) as { run: { items: Array<{ id: string; category: string; passed: boolean; resolution: string | null; message: string; detail: string }> } }
  for (const item of run.items) {
    if (item.category === 'format') expect(item.passed, `${item.message}: ${item.detail}`).toBeTruthy()
    else if (!item.resolution) {
      const resolution = item.category === 'fact' || item.category === 'stale' ? 'verified' : item.category === 'sensitive' ? 'kept' : 'acknowledged'
      await api(page, 'PATCH', `/check-items/${item.id}`, item.category === 'rewrite'
        ? { resolution, reason: 'E2E 检查项按流程确认，这条理由满足二十个字的要求。' }
        : { resolution })
    }
  }
  await api(page, 'POST', `/works/${workID}/checks/complete`, {})
  await expect.poll(async () => (await api(page, 'GET', `/works/${workID}`) as { status: string }).status, { timeout: 20_000 }).toBe('ready')
}

async function uploadImage(page: Page, workID: string) {
  return page.evaluate(async ({ workID }) => {
    const canvas = document.createElement('canvas')
    canvas.width = 800
    canvas.height = 1000
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#335f8f'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((item) => resolve(item!), 'image/png'))
    const me = await (await fetch('/api/v1/auth/me')).json()
    const form = new FormData()
    form.append('file', new File([blob], 'panel-review.png', { type: 'image/png' }))
    const response = await fetch(`/api/v1/works/${workID}/assets`, { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': me.csrf_token }, body: form })
    if (!response.ok) throw new Error(`upload image: ${response.status} ${await response.text()}`)
    return (await response.json() as { id: string }).id
  }, { workID })
}

/**
 * REF41 C1：智囊团五席评审、汇总冲突并列、建议采纳/忽略与 partial 文案（浏览器形态）。
 * 真实链路走 mock 模型；partial 分支用接口响应夹具验证“N/5 席完成”和失败席不伪造意见。
 */
test('C1 浏览器智囊团五席、冲突并列与部分失败文案', async ({ page }) => {
  test.setTimeout(120_000)
  const account = await registerAccount(page, '图文笔记', 'xhs')
  const workID = await createOutline(page)
  const draft = await api(page, 'GET', `/works/${workID}`) as { revision: number }
  await api(page, 'PATCH', `/works/${workID}`, { title: '智囊团五席评审验收', base_revision: draft.revision })
  const full = await api(page, 'GET', `/works/${workID}`) as { sections: Array<{ id: string; revision: number }> }
  for (const [index, section] of full.sections.entries()) {
    await api(page, 'PATCH', `/sections/${section.id}`, { content_md: `第 ${index + 1} 段：先给出可核对的事实，再说明判断与边界。`, base_revision: section.revision })
  }
  await uploadImage(page, workID)
  await passChecks(page, workID)
  await api(page, 'POST', `/works/${workID}/xhs/pack`, {})
  await page.goto(`/a/${account.id}/review?work=${workID}`)

  const card = page.getByTestId('panel-review-card')
  await expect(card).toBeVisible()
  await expect(card.getByTestId('panel-review-empty')).toBeVisible()
  const created = page.waitForResponse((response) => response.url().endsWith(`/works/${workID}/panel-review`) && response.request().method() === 'POST')
  await card.getByRole('button', { name: '发起五席评审', exact: true }).click()
  const createdResponse = await created
  expect(createdResponse.status()).toBe(200)
  const reviewID = (await createdResponse.json() as { id: string }).id

  await expect(card.getByTestId('panel-audience-tags')).toContainText('目标读者')
  await expect(card.getByTestId('panel-audience-tags')).toContainText('同行专家')
  await expect(card.getByTestId('panel-audience-tags')).toContainText('平台运营')
  await expect(card.getByTestId('panel-audience-tags')).toContainText('品牌方')
  await expect(card.getByTestId('panel-audience-tags')).toContainText('新手读者')
  await expect(card.getByTestId('panel-review-status')).toContainText('已完成', { timeout: 30_000 })
  await expect(card.getByTestId('panel-summary')).toContainText('开头补一个具体场景')
  await expect(card.getByTestId('panel-conflicts')).toContainText('同行专家：正文引用的经验缺少来源说明')
  await expect(card.getByTestId('panel-conflicts')).toContainText('目标读者：标题缺少具体对象')
  await expect(card.getByTestId('panel-conflicts').locator('div.rounded-lg')).toHaveCount(2)

  // 展开首席详情，逐条建议可采纳/忽略；只写本机记录，不发写回请求。
  const firstSeat = card.getByTestId('panel-seat-0')
  await firstSeat.getByRole('button', { name: '展开详情' }).click()
  await expect(firstSeat).toContainText('优点')
  await expect(firstSeat).toContainText('建议（只记录，不改稿）')
  await firstSeat.getByTestId('panel-suggestion-0-0').getByRole('button', { name: '采纳' }).click()
  await expect.poll(() => page.evaluate((id) => localStorage.getItem(`ops.panel-decisions.v1:${id}`), reviewID)).toContain(':0:0":"adopt"')

  // partial 夹具：4 席成功 + 1 席失败；只显示成功席，不补空白意见。
  const failedAudience = '品牌方'
  await page.route(`**/api/v1/works/${workID}/panel-reviews`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ reviews: [{
        id: reviewID, work_id: workID, work_revision: 1,
        audiences: ['目标读者', '同行专家', '平台运营', '品牌方', '新手读者'],
        status: 'partial',
        results: [
          { audience: '目标读者', verdict: '方向清楚', strengths: ['定位一致'], risks: ['标题缺少具体对象'], questions: ['读完能做什么？'], suggestions: ['开头补场景'] },
          { audience: '同行专家', verdict: '可读', strengths: ['结构完整'], risks: ['正文引用缺少来源'], questions: [], suggestions: ['补来源'] },
          { audience: '平台运营', verdict: '合规', strengths: ['无违规'], risks: ['互动引导不足'], questions: [], suggestions: ['结尾加互动'] },
          { audience: failedAudience, verdict: '', failed: true, error: '该席调用失败', strengths: [], risks: [], questions: [], suggestions: [] },
          { audience: '新手读者', verdict: '术语偏多', strengths: [], risks: ['理解门槛'], questions: [], suggestions: ['降低术语'] },
        ],
        summary: { consensus: ['开头补场景'], conflicts: [{ topic: '风险', views: ['目标读者：标题缺少具体对象', '同行专家：正文引用缺少来源'] }], top_risks: ['标题缺少具体对象'] },
        model: 'mock-writer', prompt_version: 'panel-v1', created_at: new Date().toISOString(), finished_at: new Date().toISOString(),
      }] }),
    })
  })
  await card.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(card.getByTestId('panel-review-status')).toContainText('部分完成')
  await expect(card.getByText('已完成 4/5 席')).toBeVisible()
  await expect(card.getByTestId('panel-partial-copy')).toContainText('失败席标为“本席未完成”')
  await expect(card.getByTestId('panel-seat-3')).toContainText('本席未完成')
  await expect(card.getByTestId('panel-seat-3')).not.toContainText('标题缺少具体对象')
})
