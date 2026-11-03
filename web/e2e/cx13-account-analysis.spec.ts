import { expect, test } from '@playwright/test'
import { api, mockModelBaseUrl, registerAccount } from './support'

test.describe('DEV-CX13-D Web 账号内容与主页自检', () => {
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟模型')

  test('账号分析预览、生成、编辑与逐条反馈', async ({ page }) => {
    const account = await registerAccount(page, '图文笔记', 'xhs', `cx13-analysis-web-${Date.now()}`)
    const provider = await api(page, 'POST', '/model-providers', {
      name: 'CX13 Web 账号分析模拟模型', base_url: mockModelBaseUrl(), api_key: 'local-cx13-analysis-web-key', models: ['mock-writer'],
    })
    await api(page, 'PUT', '/model-routes', [{ task_type: 'cx_account_analyze', provider_id: provider.id, model: 'mock-writer' }])
    await page.goto(`/a/${account.id}/profile?tab=analysis`)
    const panel = page.getByTestId('account-analysis-tab')
    await expect(panel).toBeVisible()
    await panel.getByRole('button', { name: '预览本次依据与模型' }).click()
    const preview = page.getByTestId('account-analysis-preview')
    await expect(preview.getByText('cx_account_analyze')).toBeVisible()
    const generated = page.waitForResponse((response) => response.url().includes(`/accounts/${account.id}/account-analysis`) && response.request().method() === 'POST')
    await preview.getByRole('button', { name: '生成账号分析' }).click()
    expect((await generated).ok()).toBeTruthy()
    const report = page.getByTestId('account-analysis-report')
    await expect(report.getByText('检查主页介绍是否清楚表达内容方向')).toBeVisible()
    await report.getByRole('button', { name: '编辑报告' }).click()
    await report.getByLabel('分析摘要').fill('Web 作者确认后的账号分析摘要')
    const saved = page.waitForResponse((response) => response.url().includes('/account-analysis') && response.request().method() === 'PATCH')
    await report.getByRole('button', { name: '保存报告' }).click()
    expect((await saved).ok()).toBeTruthy()
    await expect(report.getByText('Web 作者确认后的账号分析摘要')).toBeVisible()
    const adopted = page.waitForResponse((response) => response.url().includes('/account-analysis') && response.request().method() === 'PATCH')
    await report.getByRole('button', { name: '标记采用' }).click()
    expect((await adopted).ok()).toBeTruthy()
    const history = await api(page, 'GET', `/accounts/${account.id}/analyses?kind=account_analysis`)
    expect(history.items[0].result_revision).toBe(3)
    expect(history.items[0].result.action_states).toEqual([{ action_index: 0, status: 'adopted' }])
    expect(history.items[0].result.analysis.overview).toBe('Web 作者确认后的账号分析摘要')
  })

  test('主页自检保留来源、模拟标识与缺方案 unknown', async ({ page }) => {
    const account = await registerAccount(page, '图文笔记', 'xhs', `cx13-profile-web-${Date.now()}`)
    await api(page, 'PUT', `/accounts/${account.id}/profile`, {
      positioning_tags: ['写作'], target_audience: '关注写作的读者', persona_tone: '克制清楚',
      banned_words: [], style_summary: '', default_theme: 'ink', wechat_defaults: {},
    })
    const provider = await api(page, 'POST', '/model-providers', {
      name: 'CX13 Web 主页自检模拟模型', base_url: mockModelBaseUrl(), api_key: 'local-cx13-profile-web-key', models: ['mock-writer'],
    })
    await api(page, 'PUT', '/model-routes', [{ task_type: 'cx_profile_simulate', provider_id: provider.id, model: 'mock-writer' }])
    await page.goto(`/a/${account.id}/profile?tab=profile-check`)
    const panel = page.getByTestId('profile-check-tab')
    await expect(panel).toBeVisible()
    await panel.getByRole('textbox', { name: '昵称', exact: true }).fill('写作助手')
    await panel.getByRole('textbox', { name: '简介', exact: true }).fill('分享写作经验，记录真实过程')
    await panel.getByLabel('头像引用').fill('本人平台主页头像')
    await panel.getByLabel('背景信息（人工补充）').fill('长期记录写作过程')
    await panel.getByLabel('置顶内容说明（人工补充）').fill('置顶一篇写作方法说明')
    for (const [label, note] of [
      ['简介层次', '能说明主题和经验来源'],
      ['头像可识别', '本人平台主页中的头像主体清晰'],
      ['背景补充信息', '补充了长期写作经历'],
      ['置顶内容', '展示了写作方法'],
    ] as const) {
      await panel.getByLabel(`${label}判断依据`).fill(note)
      await panel.getByLabel(`${label}状态`).selectOption('pass')
    }
    const generated = page.waitForResponse((response) => response.url().includes(`/accounts/${account.id}/profile-check`) && response.request().method() === 'POST')
    await panel.getByRole('button', { name: '保存并模拟文字第一印象' }).click()
    expect((await generated).ok()).toBeTruthy()
    const result = page.getByTestId('profile-check-result')
    await expect(result.getByText('已完成 6/7')).toBeVisible()
    await expect(result.getByText('AI 模拟推断，不代表真实读者测试、受众反馈或内容效果。')).toBeVisible()
    await expect(result.getByText('缺少已采用内容方案或所选本人作品，不能判断内容支柱覆盖')).toBeVisible()
    const saved = await api(page, 'GET', `/accounts/${account.id}/profile-check`)
    expect(saved.profile_check.inputs.nickname).toEqual({ source: 'manual', value: '写作助手' })
    expect(saved.profile_check.inputs.background_info.value).toBe('长期记录写作过程')
    expect(saved.profile_check.items.find((item: { key: string }) => item.key === 'pillar_coverage').status).toBe('unknown')
    expect(saved.profile_check.ai_is_simulated).toBe(true)
  })
})
