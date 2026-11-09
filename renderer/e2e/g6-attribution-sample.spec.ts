import { _electron, expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { api, registerAccount } from './support'

const day = 24 * 60 * 60_000
const password = 'local-e2e-password-123'
const chineseOrdinals = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸']

function localDateInput(value: Date) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

async function addLocalModel(page: Page) {
  const provider = await api(page, 'POST', '/model-providers', {
    name: `DEV-QA26 G6 归因本地模型 ${Date.now()}`,
    base_url: process.env.OPS_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:8297/v1',
    api_key: 'local-qa26-attribution-key', models: ['mock-writer'],
  }) as { id: string }
  await api(page, 'PUT', '/model-routes', ['fact_flag', 'review_attribution', 'work_breakdown'].map((task_type) => ({
    task_type, provider_id: provider.id, model: 'mock-writer',
  })))
}

async function finishChecks(native: Page, page: Page, workID: string, origin: string) {
  await native.goto(`${origin}/works/${workID}/check`)
  const initial = await api(page, 'GET', `/works/${workID}/checks/latest`)
  if (!initial.run) await native.getByRole('button', { name: '开始检查', exact: true }).click()
  await expect.poll(async () => {
    const { run } = await api(page, 'GET', `/works/${workID}/checks/latest`)
    return !!run && run.fact_status !== 'pending'
  }, { timeout: 30_000 }).toBeTruthy()
  const { run } = await api(page, 'GET', `/works/${workID}/checks/latest`)
  for (const item of run.items) {
    if (item.category === 'format') expect(item.passed, `${item.message}: ${item.detail}`).toBeTruthy()
    else if (!item.resolution) {
      if (item.category === 'ai_disclosure') {
        const checkbox = native.getByRole('checkbox', { name: '已知悉，发布时会声明' })
        if (!(await checkbox.isChecked())) await checkbox.click()
      } else await native.locator(`input[name="${item.id}"]`).first().check()
    }
  }
  await native.getByRole('button', { name: '确认完成检查', exact: true }).click()
  await expect.poll(async () => (await api(page, 'GET', `/works/${workID}`)).status).toBe('ready')
}

async function seedSample(native: Page, page: Page, accountID: string, origin: string, index: number) {
  const title = index % 2 === 0
    ? `含数字 ${index + 1} 的实际记录`
    : `实际记录${chineseOrdinals[index]}的复盘过程`
  let work = await api(page, 'POST', `/accounts/${accountID}/works`, { title, content_format: 'micro_post' }) as {
    id: string; revision: number; sections: Array<{ id: string; revision: number }>
  }
  work = await api(page, 'PATCH', `/works/${work.id}`, {
    viewpoint: '这篇样本只描述可核对的实际做法和结果。', base_revision: work.revision,
  })
  work = await api(page, 'PUT', `/works/${work.id}/outline`, {
    items: [
      { heading: '当时的情况', key_point: '说明一个具体起因', material_ids: [] },
      { heading: '实际处理', key_point: '记录采用的步骤', material_ids: [] },
      { heading: '得到的观察', key_point: '说明可验证的结果', material_ids: [] },
    ], confirm: true, base_revision: work.revision,
  })
  for (const [sectionIndex, section] of work.sections.entries()) {
    await api(page, 'PATCH', `/sections/${section.id}`, {
      content_md: `第 ${sectionIndex + 1} 段记录真实步骤和可以再次核对的依据。`, base_revision: section.revision,
    })
  }
  work = await api(page, 'GET', `/works/${work.id}`)
  work = await api(page, 'PATCH', `/works/${work.id}`, {
    topics: index % 2 === 0 ? ['实际记录', '复盘'] : ['过程记录'], base_revision: work.revision,
  })

  await finishChecks(native, page, work.id, origin)
  await native.goto(`${origin}/works/${work.id}/pack`)
  await native.getByRole('button', { name: '生成当前修订发布包', exact: true }).click()
  await expect(native.getByRole('textbox', { name: '发布正文文本', exact: true })).toBeVisible()
  await expect.poll(async () => (await api(page, 'GET', `/works/${work.id}`)).status).toBe('packed')

  const publishedAt = new Date(Date.now() - 8 * day + index * 2 * 60 * 60_000)
  const backfill = native.locator('#backfill')
  await backfill.getByLabel('作品链接（可选）').fill(`https://example.invalid/qa26-attribution-${index + 1}`)
  await backfill.getByLabel('发布时间', { exact: true }).fill(localDateInput(publishedAt))
  const marked = native.waitForResponse((response) => response.url().endsWith(`/api/v1/works/${work.id}/published`) && response.request().method() === 'POST')
  await backfill.getByRole('button', { name: '标记为已发布', exact: true }).click()
  expect((await marked).ok()).toBeTruthy()

  const capturedAt = new Date(publishedAt.getTime() + 7 * day)
  const metric = await api(page, 'POST', `/works/${work.id}/metrics`, {
    captured_at: capturedAt.toISOString(),
    reads: index % 2 === 0 ? 1_000 + index * 100 : 3_000 + index * 100,
    likes: 20 + index, comments: 2 + index, shares: 4 + index,
  })
  expect(metric).toMatchObject({ source: 'manual', day_offset: 7 })
  const saved = await api(page, 'GET', `/works/${work.id}/metrics`)
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({ source: 'manual', day_offset: 7 })
  return { id: work.id, title }
}

test('DEV-QA26 G6 真实 Electron 足量样本归因与高表现作品', async ({ page, baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.skip(process.env.OPS_E2E_PROD === '1', '本场景使用本地模拟 API 与模型')
  test.setTimeout(480_000)
  const username = `qa26-g6-attribution-${Date.now()}`
  const account = await registerAccount(page, '微头条', 'toutiao', username)
  await addLocalModel(page)
  const profilePrefix = join(tmpdir(), 'ops-qa26-g6-attribution-')
  const profile = await mkdtemp(profilePrefix)
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000,
    })
    const native = await app.firstWindow()
    await native.goto(`${baseURL}/login`)
    await native.getByLabel('用户名', { exact: true }).fill(username)
    await native.getByLabel('密码', { exact: true }).fill(password)
    await native.getByRole('button', { name: '登录', exact: true }).click()
    await expect.poll(() => native.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await native.evaluate(async (accountID) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      localStorage.setItem(`ops.currentAccount.v2:${me.user_id ?? me.username}:${me.workspace.id}`, accountID)
    }, account.id)

    const seeded = []
    for (let index = 0; index < 10; index++) seeded.push(await seedSample(native, page, account.id, baseURL!, index))
    expect(new Set(seeded.map((sample: { id: string }) => sample.id)).size).toBe(10)

    await native.getByRole('link', { name: '复盘', exact: true }).click()
    await expect(native.getByRole('heading', { name: '数据复盘', exact: true })).toBeVisible()
    await native.getByLabel('复盘内容形态').selectOption('micro_post')
    await native.getByRole('button', { name: '查看趋势', exact: true }).click()
    await expect(native.getByRole('heading', { name: '什么在起作用', exact: true })).toBeVisible()
    const attributionPost = native.waitForResponse((response) => response.url().endsWith(`/api/v1/accounts/${account.id}/reviews/attribution`) && response.request().method() === 'POST')
    await native.getByRole('button', { name: '开始分析', exact: true }).click()
    const attribution = await (await attributionPost).json()
    expect(attribution).toMatchObject({ enough: true, samples: 10, content_format: 'micro_post' })
    expect(attribution.ai_call_id).toBeTruthy()
    expect(attribution.features.some((feature: { feature: string }) => feature.feature === 'title_digit')).toBeTruthy()
    await expect(native.getByText('结论（基于 10 篇）', { exact: true })).toBeVisible()
    await expect(native.getByText('含数字', { exact: true })).toBeVisible()
    await expect(native.getByText('不含数字', { exact: true })).toBeVisible()

    const preferences = await api(page, 'GET', `/accounts/${account.id}/data-preferences?content_format=micro_post`)
    expect(preferences.some((item: { applicability: string; basis_sample_count: number }) => item.applicability === 'current' && item.basis_sample_count === 10)).toBeTruthy()
    const topWorks = await api(page, 'GET', `/accounts/${account.id}/top-works?content_format=micro_post`)
    expect(topWorks).toHaveLength(1)
    await native.getByRole('heading', { name: '表现最好的作品', exact: true }).scrollIntoViewIfNeeded()
    await native.getByRole('button', { name: '拆解这篇', exact: true }).click()
    const breakdown = native.getByRole('dialog')
    await expect(breakdown.getByText('结构', { exact: true })).toBeVisible()
    await expect(breakdown.getByText('开头方式', { exact: true })).toBeVisible()
    await expect(breakdown.getByText('可复用的写作规则', { exact: true })).toBeVisible()
    await breakdown.getByRole('button', { name: '完成', exact: true }).click()
  } finally {
    if (app) {
      try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 只结束本测试创建的 Electron。 */ }
      await Promise.race([app.close().catch(() => undefined), new Promise((done) => setTimeout(done, 2_000))])
    }
    if (!resolve(profile).startsWith(resolve(tmpdir()) + '\\') || !profile.includes('ops-qa26-g6-attribution-')) {
      throw new Error('拒绝清理测试目录之外路径')
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
