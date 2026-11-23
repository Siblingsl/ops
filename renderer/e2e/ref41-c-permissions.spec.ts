import { expect, test, type Browser, type Page } from '@playwright/test'
import { api, registerAccount } from './support'

// REF41 C 类补口（桌面形态）：viewer 可读复盘/评论/发布页，但 I3/I6/I7 写入口必须消失，
// A3 能力缺口台账不渲染；写请求仍由服务端 403 兜底。浏览器形态见 web/e2e/ref41-c-permissions.spec.ts。
async function joinViewer(browser: Browser, page: Page, name: string) {
  const invite = await api(page, 'POST', '/workspaces/current/invites', { role: 'viewer', max_uses: 1, days: 1 }) as { code: string }
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin })
  const registered = await context.request.post('/api/v1/auth/register', {
    data: { username: name, password: 'local-e2e-password-123', invite_code: invite.code },
  })
  expect(registered.ok(), await registered.text()).toBeTruthy()
  return { context, viewer: await context.newPage() }
}

test('REF41 C 桌面：viewer 只读门与 A3 台账隔离', async ({ page, browser }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', 'C 类 viewer 门使用本地邀请码与模拟数据')
  test.setTimeout(180_000)
  const account = await registerAccount(page, '图文笔记', 'xhs', `c-viewer-desktop-${Date.now()}`)
  await api(page, 'POST', `/accounts/${account.id}/followers`, { date: '2026-11-19', cumulate: 120 })

  for (const [content, alias] of [['C 类桌面 viewer 问题怎么处理', '桌面读者甲'], ['C 类桌面 viewer 问题怎么处理呢', '桌面读者乙']] as const) {
    const created = await api(page, 'POST', '/comments', { account_id: account.id, author_alias: alias, content }) as { id: string; revision: number }
    await api(page, 'PATCH', `/comment-inbox/${created.id}`, { base_revision: created.revision, category: 'question' })
  }
  const rebuilt = await page.request.post('http://127.0.0.1:8287/__e2e/comment-clusters/recompute', { data: { account_id: account.id } })
  expect(rebuilt.ok(), await rebuilt.text()).toBeTruthy()

  const wechat = await api(page, 'POST', '/accounts', { platform: 'wechat_mp', name: 'C 类桌面 viewer 公众号', content_format: 'long_article' }) as { id: string }
  const work = await api(page, 'POST', `/accounts/${wechat.id}/works`, { title: 'C 类桌面 viewer 转化作品' }) as { id: string }
  await api(page, 'POST', `/works/${work.id}/conversion-links`, { platform: 'wechat_mp', target_url: 'https://example.com/c-desktop-viewer' })

  const { context, viewer } = await joinViewer(browser, page, `c-viewer-desktop-${Date.now()}`)
  try {
    await viewer.goto(`/a/${account.id}/review`)
    // 桌面复盘默认折叠高级区，viewer 先点「粉丝记录」展开，再断言补录入口消失。
    const followersShortcut = viewer.getByRole('button', { name: '粉丝记录', exact: true })
    if (await followersShortcut.isVisible()) await followersShortcut.click()
    const followers = viewer.getByTestId('i6-followers-card')
    await expect(followers.getByTestId('i6-followers-readonly')).toBeVisible()
    await expect(followers.getByRole('button', { name: '补录一天', exact: true })).toHaveCount(0)
    await expect(followers.getByTestId('i6-follower-gap')).toHaveCount(0)

    await viewer.goto(`/a/${account.id}/profile?tab=comments`)
    const cluster = viewer.getByTestId('comment-cluster-item').first()
    await expect(cluster).toBeVisible()
    await expect(cluster.getByRole('button', { name: '生成选题', exact: true })).toHaveCount(0)
    await expect(cluster.getByRole('button', { name: '忽略', exact: true })).toHaveCount(0)
    await expect(cluster.getByRole('button', { name: '重新打开', exact: true })).toHaveCount(0)
    const me = await (await viewer.request.get('/api/v1/auth/me')).json() as { csrf_token: string }
    const clusters = await api(viewer, 'GET', `/accounts/${account.id}/comment-clusters`) as { items: { id: string }[] }
    const denied = await viewer.request.fetch('/api/v1/comment-clusters/' + clusters.items[0].id + '/convert', {
      method: 'POST', data: {}, headers: { 'X-CSRF-Token': me.csrf_token },
    })
    expect(denied.status()).toBe(403)

    await viewer.goto(`/works/${work.id}/push`)
    const conversion = viewer.getByTestId('i7-conversion-card')
    await expect(conversion.getByTestId('i7-conversion-readonly')).toBeVisible()
    await expect(conversion.getByTestId('i7-conversion-generate')).toHaveCount(0)
    await expect(conversion.getByTestId('i7-conversion-url')).toBeVisible()

    await viewer.goto('/settings/agent')
    await expect(viewer.getByTestId('capability-gaps')).toHaveCount(0)
    await viewer.screenshot({ path: '../.playwright-results/desktop-renderer/c-viewer-gates.png', fullPage: true })
  } finally {
    await context.close()
  }
})
