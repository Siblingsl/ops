import { expect, test, type Page } from '@playwright/test'
import { publishDigest } from '../lib/skill-canon'
import { api, registerAccount } from './support'

/**
 * OPT-W05：技能引用回执的桌面形态迁移。
 * 覆盖：绑定个人/公共技能后生成标题，本人可见个人名称；协作者只看到匿名个人数量；
 * 记录被清理时回执只显示清理状态，不用当前绑定重建旧回执。
 * 桌面端标题入口在作品工具栏「更多」菜单内（卡内「候选」按钮被桌面样式隐藏），
 * 回执通过「本次参考」面板内的 aria-label 区域读取。
 */

async function enableDesktopPresentation(page: Page) {
  await page.addInitScript(() => {
    const userAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => `${userAgent} Electron/44.8.0` })
  })
}

/**
 * 桌面呈现把标题生成入口收进作品工具栏「更多」菜单（旧的卡内「候选」按钮被
 * desktop-creative.css 隐藏）。这里按用户真实路径点菜单，不直接派发内部事件。
 */
async function generateTitleCandidates(page: Page) {
  await page.locator('.desktop-work-more').getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('menuitem', { name: '生成标题候选', exact: true }).click()
}

test('TestSkillBoundGenerationOwnerAndCollaboratorHistoryReceipts', async ({ page, browser }) => {
  const account = await registerAccount(page, '长图文', 'wechat_mp')
  const fields = { name: '私有写法名称', summary: '仅本人可见', triggers: '标题时使用', instructions: '保持简洁，不引入输入外的事实。', platforms: [], content_formats: [], task_types: ['title'], task_enabled: true, agent_enabled: true, status: 'active' }
  const personal = (await api(page, 'POST', '/skills', { scope: 'personal', ...fields })).skill
  const publicFields = { ...fields, name: '公共写法名称', summary: '工作区可见' }
  const digest = await publishDigest({ operation: 'create', skillId: null, scope: 'workspace', accountId: null }, publicFields)
  const shared = (await api(page, 'POST', '/skills', { scope: 'workspace', ...publicFields, publish_confirmation: { confirmed: true, digest } })).skill
  await enableDesktopPresentation(page)
  await page.goto(`/a/${account.id}/profile?tab=skills`)
  await page.getByLabel('选择个人技能', { exact: true }).selectOption(personal.id)
  await page.getByRole('button', { name: '启用所选个人技能', exact: true }).click()
  await expect(page.getByTestId(`skill-binding-${personal.id}`)).toBeVisible()
  await page.getByLabel('选择公共技能', { exact: true }).selectOption(shared.id)
  await page.getByRole('button', { name: '启用所选公共技能', exact: true }).click()
  await expect(page.getByTestId(`skill-binding-${shared.id}`)).toBeVisible()
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '技能引用验收' })
  await page.goto(`/works/${work.id}`)
  const title = page.locator('#step-title')
  const generated = page.waitForResponse((response) => response.url().endsWith(`/works/${work.id}/titles`) && response.request().method() === 'POST')
  await generateTitleCandidates(page)
  const response = await generated
  expect(response.status()).toBe(200)
  const result = await response.json()
  expect(JSON.stringify(result.refs)).not.toContain(personal.id)
  expect(JSON.stringify(result.refs)).not.toContain(personal.name)
  await title.getByRole('button', { name: /本次参考/ }).click()
  const ownReceipt = title.getByLabel('技能使用回执', { exact: true })
  await expect(ownReceipt).toContainText(personal.name)
  await expect(ownReceipt).toContainText(shared.name)
  const invite = await api(page, 'POST', '/workspaces/current/invites', { role: 'editor', max_uses: 1, days: 1 })
  // 协作者同样使用桌面呈现，才能从标题卡读取同一条历史回执。
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin, userAgent: 'OPS Electron/44.8.0' })
  try {
    const registered = await context.request.post('/api/v1/auth/register', { data: { username: `skill-history-${Date.now()}`, password: 'local-e2e-password-123', invite_code: invite.code } })
    expect(registered.ok()).toBeTruthy()
    const collaborator = await context.newPage()
    // 复用同一条已生成、可协作查看的结果，使引用控件读取原调用的历史回执。
    await collaborator.route(`**/works/${work.id}/titles`, (route) => route.fulfill({ json: result }))
    await collaborator.goto(`/works/${work.id}`)
    const otherTitle = collaborator.locator('#step-title')
    await generateTitleCandidates(collaborator)
    await otherTitle.getByRole('button', { name: /本次参考/ }).click()
    const otherReceipt = otherTitle.getByLabel('技能使用回执', { exact: true })
    await expect(otherReceipt).toContainText(shared.name)
    await expect(otherReceipt).toContainText('个人技能 1 条')
    await expect(otherReceipt).not.toContainText(personal.name)
    const raw = await (await collaborator.request.get(`/api/v1/ai-calls/${result.ai_call_id}/skill-context`)).text()
    expect(raw).not.toContain(personal.id)
    expect(raw).not.toContain(personal.name)
  } finally { await context.close() }
  // 同一个调用的记录已清理时只显示清理状态，不用当前绑定重建旧回执。
  await page.route(`**/works/${work.id}/titles`, (route) => route.fulfill({ json: result }))
  await page.route(`**/ai-calls/${result.ai_call_id}/skill-context`, (route) => route.fulfill({ status: 404, json: { error: { code: 'not_found', message: '记录已清理' } } }))
  await page.reload()
  await generateTitleCandidates(page)
  await title.getByRole('button', { name: /本次参考/ }).click()
  await expect(title.getByText('使用记录已清理', { exact: true })).toBeVisible()
})
