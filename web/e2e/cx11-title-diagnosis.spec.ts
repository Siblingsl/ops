import { expect, test } from '@playwright/test'
import { api, mockModelBaseUrl, registerAccount } from './support'

test.describe('DEV-CX11 Web 标题诊断', () => {
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟模型')

  test('临时标题诊断、候选采用可撤销且不自动保存', async ({ page }) => {
    const account = await registerAccount(page, '图文笔记', 'xhs', `cx11-title-web-${Date.now()}`)
    await api(page, 'PUT', `/accounts/${account.id}/profile`, {
      positioning_tags: ['内容'], target_audience: '希望快速理解内容的读者', persona_tone: '清楚克制',
      banned_words: [], style_summary: '', default_theme: 'ink', wechat_defaults: {},
    })
    const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '保存的旧标题' })
    const current = await api(page, 'GET', `/works/${work.id}`)
    const changed = await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '按可信材料给读者清楚步骤', base_revision: current.revision })
    const outlined = await api(page, 'PUT', `/works/${work.id}/outline`, {
      confirm: true, base_revision: changed.revision,
      items: [{ heading: '当前章节', key_point: '根据正文说明步骤', material_ids: [] }],
    })
    await api(page, 'PATCH', `/sections/${outlined.sections[0].id}`, {
      content_md: '这段正文解释三天内可以完成的具体步骤。', base_revision: outlined.sections[0].revision,
    })
    const provider = await api(page, 'POST', '/model-providers', {
      name: 'CX11 Web 标题诊断模拟模型', base_url: mockModelBaseUrl(), api_key: 'local-cx11-title-web-key', models: ['mock-writer'],
    })
    await api(page, 'PUT', '/model-routes', [{ task_type: 'cx_title_diagnose', provider_id: provider.id, model: 'mock-writer' }])
    await page.goto(`/works/${work.id}`)
    const title = page.locator('#step-title input').first()
    if (!(await title.isVisible())) await page.keyboard.press('F11')
    await expect(title).toBeVisible()
    await title.fill('三天内看懂内容')
    const generated = page.waitForResponse((response) => response.url().includes(`/works/${work.id}/diagnose-title`) && response.request().method() === 'POST')
    await page.getByRole('button', { name: '诊断标题', exact: true }).click()
    expect((await generated).ok()).toBeTruthy()
    const report = page.getByTestId('title-diagnosis-report')
    await expect(report).toBeVisible()
    await expect(report.getByText('规则 50/60')).toBeVisible()
    await expect(report.getByText('语义 32/40')).toBeVisible()
    await expect(report.getByText('临时标题')).toBeVisible()
    expect((await api(page, 'GET', `/works/${work.id}`)).title).toBe('保存的旧标题')
    await report.getByRole('button', { name: '采用候选：先说明核心，再展开步骤' }).click()
    await expect(title).toHaveValue('先说明核心，再展开步骤')
    expect((await api(page, 'GET', `/works/${work.id}`)).title).toBe('保存的旧标题')
    await report.getByRole('button', { name: '撤销采用' }).click()
    await expect(title).toHaveValue('三天内看懂内容')
    await report.getByRole('button', { name: '查看历史' }).click()
    await expect(report.getByText('临时标题').last()).toBeVisible()
  })

  // DEV-CX13-D：登记上下文窗口后，发送前预算闸门在调模型前返回 409 context_budget_exceeded，
  // 界面提示缩小范围；长正文让估算（runes×2/3）超过 1200×3/4。
  test('DEV-CX13-D 上下文窗口登记后标题候选 409 的界面呈现', async ({ page }) => {
    const account = await registerAccount(page, '长图文', 'wechat_mp', `cx13-budget-web-${Date.now()}`)
    const work = await api(page, 'POST', `/accounts/${account.id}/works`, {}) as { id: string; revision: number }
    const current = await api(page, 'GET', `/works/${work.id}`)
    const changed = await api(page, 'PATCH', `/works/${work.id}`, { viewpoint: '上下文预算闸门验收', base_revision: current.revision })
    const outlined = await api(page, 'PUT', `/works/${work.id}/outline`, {
      confirm: true, base_revision: changed.revision,
      items: [{ heading: '预算段落', key_point: '长正文', material_ids: [] }],
    })
    const longBody = '把反馈周期缩短到当天可见，写一句话也能积累素材，这种渐进的积累比一次性长文更容易保持动力，也更容易在回读时发现值得展开的线索。'.repeat(32)
    await api(page, 'PATCH', `/sections/${outlined.sections[0].id}`, { content_md: longBody, base_revision: outlined.sections[0].revision })
    const provider = await api(page, 'POST', '/model-providers', {
      name: 'Web 预算登记模型', base_url: mockModelBaseUrl(), api_key: 'local-cx13-budget-key', models: ['mock-writer'], context_window_tokens: 1200,
    }) as { id: string }
    await api(page, 'PUT', '/model-routes', [{ task_type: 'title', provider_id: provider.id, model: 'mock-writer' }])

    await page.goto(`/works/${work.id}`)
    const generated = page.waitForResponse((response) => response.url().includes(`/works/${work.id}/titles`) && response.request().method() === 'POST')
    await page.getByRole('button', { name: '候选', exact: true }).click()
    const response = await generated
    expect(response.status()).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('context_budget_exceeded')
    // 界面出现缩小范围提示（错误提示保留到人工关闭，不会被快速吞掉）。
    await expect(page.getByText(/接近上限/).first()).toBeVisible()
  })

})
