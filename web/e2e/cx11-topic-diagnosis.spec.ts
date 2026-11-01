import { expect, test } from '@playwright/test'
import { api, mockModelBaseUrl, registerAccount } from './support'

test.describe('DEV-CX11 Web 选题体检', () => {
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地模拟模型')

  test('显示分层评分与来源；备选角度经编辑后手动保存，定位缺失时保留部分结果', async ({ page }) => {
    const account = await registerAccount(page, '图文笔记', 'xhs', `cx11-topic-web-${Date.now()}`)
    await api(page, 'PUT', `/accounts/${account.id}/profile`, {
      positioning_tags: ['写作', '内容'], target_audience: '刚开始写作的读者', persona_tone: '清楚克制',
      banned_words: [], style_summary: '', default_theme: 'ink', wechat_defaults: {},
    })
    const created = await api(page, 'POST', `/accounts/${account.id}/topics`, {
      title: '新手写作如何搭建稳定计划', angle: '从具体执行步骤说明',
    })
    const provider = await api(page, 'POST', '/model-providers', {
      name: 'CX11 Web 选题体检模拟模型', base_url: mockModelBaseUrl(), api_key: 'local-cx11-topic-web-key', models: ['mock-writer'],
    })
    await api(page, 'PUT', '/model-routes', [{ task_type: 'cx_topic_diagnose', provider_id: provider.id, model: 'mock-writer' }])

    await page.goto(`/a/${account.id}/topics`)
    const diagnosis = page.getByTestId('topic-diagnosis')
    await diagnosis.getByRole('button', { name: '查看体检', exact: true }).click()
    const requested = page.waitForResponse((response) => response.url().includes(`/topics/${created.topic.id}/diagnose`) && response.request().method() === 'POST')
    await diagnosis.getByRole('button', { name: '体检选题', exact: true }).click()
    expect((await requested).ok()).toBeTruthy()

    const report = page.getByTestId('topic-diagnosis-report')
    await expect(report).toBeVisible()
    await expect(report).toContainText('规则 55/55')
    await expect(report).toContainText('AI 35/45')
    await expect(report).toContainText('综合 90/100')
    await expect(report).toContainText('账号定位')
    await expect(report).toContainText('模拟读者反应')
    const questionAngle = '从读者最常遇到的问题切入'
    await report.getByRole('button', { name: `放入切入角度：${questionAngle}` }).click()
    const edit = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '编辑选题卡', exact: true }) })
    const angleEditor = edit.getByRole('textbox', { name: '切入角度', exact: true })
    await expect(angleEditor).toHaveValue(questionAngle)
    expect((await api(page, 'GET', `/accounts/${account.id}/topics`)).find((topic: { id: string }) => topic.id === created.topic.id).angle).toBe(created.topic.angle)
    await angleEditor.fill(`${questionAngle}，先列出常见卡点`)
    await edit.getByRole('button', { name: '保存', exact: true }).click()
    await expect(report).toContainText('依据已变化 · 本报告已过期')
    const saved = (await api(page, 'GET', `/accounts/${account.id}/topics`)).find((topic: { id: string }) => topic.id === created.topic.id)
    expect(saved.title).toBe(created.topic.title)
    expect(saved.angle).toBe(`${questionAngle}，先列出常见卡点`)
    expect(saved.status).toBe(created.topic.status)
    expect(saved.score_fit).toBe(created.topic.score_fit)

    await api(page, 'PUT', `/accounts/${account.id}/profile`, {
      positioning_tags: [], target_audience: '刚开始写作的读者', persona_tone: '清楚克制',
      banned_words: [], style_summary: '', default_theme: 'ink', wechat_defaults: {},
    })
    const partialRequest = page.waitForResponse((response) => response.url().includes(`/topics/${created.topic.id}/diagnose`) && response.request().method() === 'POST')
    await diagnosis.getByRole('button', { name: '体检选题', exact: true }).click()
    expect((await partialRequest).ok()).toBeTruthy()
    await expect(report).toContainText('规则 35/55')
    await expect(report).toContainText('部分覆盖，可用上限 35')
    await expect(report).toContainText('AI 未完成')
    await expect(report).toContainText('综合分不可用')
    await expect(report).toContainText('账号定位标签未配置')
    const history = await api(page, 'GET', `/topics/${created.topic.id}/diagnoses`)
    expect(history.items).toHaveLength(2)
    expect(history.items.filter((item: { stale: boolean }) => item.stale)).toHaveLength(1)
  })
})
