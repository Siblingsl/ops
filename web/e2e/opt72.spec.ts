import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

test('OPT72 通知和收件箱通过游标逐页加载，收件箱显示总数', async ({ page }) => {
  const account = await registerAccount(page)
  const notificationCursors: string[] = []
  const inboxCursors: string[] = []
  await page.route('**/api/v1/notifications**', async route => {
    const url = new URL(route.request().url())
    if (route.request().method() !== 'GET' || url.pathname !== '/api/v1/notifications') return route.continue()
    const cursor = url.searchParams.get('cursor')
    if (cursor) notificationCursors.push(cursor)
    await route.fulfill({ json: {
      items: [{ id: cursor ? 'notification-older' : 'notification-newer', kind: 'test', title: cursor ? 'OPT72 较早通知' : 'OPT72 较新通知', body: '', link: '', read_at: null, created_at: '2026-10-13T08:00:00Z' }],
      unread: 1, active_jobs: 0, next_cursor: cursor ? null : 'notification-cursor',
    } })
  })
  await page.route('**/api/v1/inbox**', async route => {
    const url = new URL(route.request().url())
    if (route.request().method() !== 'GET' || url.pathname !== '/api/v1/inbox') return route.continue()
    const cursor = url.searchParams.get('cursor')
    if (cursor) inboxCursors.push(cursor)
    const older = !!cursor
    await route.fulfill({ json: {
      items: [{ id: older ? 'inbox-older' : 'inbox-newer', account_id: account.id, content: older ? 'OPT72 较早灵感' : 'OPT72 较新灵感', source: 'quick', suggestion: null, status: 'new', created_at: '2026-10-13T08:00:00Z' }],
      total: 300, next_cursor: older ? null : 'inbox-cursor',
    } })
  })
  await page.reload()
  await page.locator('button[title="通知与 AI 任务"]').click()
  await expect(page.getByRole('button', { name: 'OPT72 较新通知' })).toBeVisible()
  await page.getByRole('button', { name: '加载更多', exact: true }).click()
  await expect(page.getByRole('button', { name: 'OPT72 较早通知' })).toBeVisible()
  expect(notificationCursors).toContain('notification-cursor')

  await page.goto(`/a/${account.id}/topics?tab=inbox`)
  await expect(page.getByText('当前收件箱共 300 条灵感')).toBeVisible()
  await expect(page.getByText('OPT72 较新灵感', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '加载更多', exact: true }).click()
  await expect(page.getByText('OPT72 较早灵感', { exact: true })).toBeVisible()
  expect(inboxCursors).toContain('inbox-cursor')
})

test('OPT72 提及链接自动分页找到旧批注，之后仍可手动加载更多', async ({ page }) => {
  const account = await registerAccount(page)
  const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: 'OPT72 批注分页验收' })
  const cursors: string[] = []
  await page.route(`**/api/v1/works/${work.id}/comments**`, async route => {
    const url = new URL(route.request().url())
    if (route.request().method() !== 'GET') return route.continue()
    const cursor = url.searchParams.get('cursor')
    if (cursor) cursors.push(cursor)
    const body = cursor === 'comment-page-3'
      ? 'OPT72 第三页批注'
      : cursor === 'comment-page-2' ? 'OPT72 提及目标旧批注' : 'OPT72 最新批注'
    await route.fulfill({ json: {
      items: [{ id: body.includes('目标') ? 'opt72-comment-target' : body, work_id: work.id, section_id: null, anchor_text: '', body, author_id: 'opt72-author', author_name: '验收作者', mentions: [], resolved_at: null, created_at: '2026-10-13T08:00:00Z' }],
      open_count: 3,
      next_cursor: cursor === 'comment-page-3' ? null : cursor === 'comment-page-2' ? 'comment-page-3' : 'comment-page-2',
    } })
  })
  await page.goto(`/works/${work.id}?comment=opt72-comment-target`)
  await expect(page.getByText('OPT72 提及目标旧批注', { exact: true })).toBeVisible()
  expect(cursors).toContain('comment-page-2')
  await page.getByRole('button', { name: '加载更多', exact: true }).click()
  await expect(page.getByText('OPT72 第三页批注', { exact: true })).toBeVisible()
  expect(cursors).toContain('comment-page-3')
})
