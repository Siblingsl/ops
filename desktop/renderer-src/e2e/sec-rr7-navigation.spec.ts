import { test, expect, type Page } from '@playwright/test'
import { createOutline, registerAccount } from './support'

/**
 * react-router 6 → 7 升级验收（桌面渲染进程侧，对应 web/e2e/sec-rr7-navigation.spec.ts）。
 *
 * 两端各自实现、各自守卫：桌面 App.tsx 同样是 `<Route path="*" element={<Authed />} />`
 * 内再嵌套一层 `<Routes>`，v7 默认开启的 `v7_relativeSplatPath` 改的正是这层解析基准。
 * 既有桌面用例普遍用 `page.goto()` 直连，覆盖不到「点链接 / 前进后退」这条路径。
 */

// 嵌套 Routes 解析失败时不会报错，只会静默渲染空白，所以按「有无可见内容」判断。
async function expectRendered(page: Page, where: string) {
  await expect
    .poll(async () => (await page.evaluate(() => document.body.innerText.trim())).length, {
      message: `${where}：页面疑似白屏（v7 嵌套 Routes 解析失败时的典型表现）`,
      timeout: 20_000,
    })
    .toBeGreaterThan(80)
}

function re(path: string) {
  return new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')
}

test('SEC-RR7 桌面侧边栏内部导航与前进后退保持 URL、视图同步', async ({ page }) => {
  const account = await registerAccount(page)
  const base = `/a/${account.id}`

  await expect(page).toHaveURL(re(base))
  await expectRendered(page, '工作台')

  const nav = page.locator('aside#main-navigation')
  await expect(nav, '桌面侧栏未渲染，视口或布局可能已变更').toBeVisible()

  const steps = [
    { label: '选题池', path: 'topics' },
    { label: '内容日历', path: 'calendar' },
    { label: '作品', path: 'works' },
    { label: '素材库', path: 'materials' },
    { label: '复盘', path: 'review' },
  ]
  for (const step of steps) {
    await nav.getByRole('link', { name: step.label, exact: true }).first().click()
    await expect(page, `点击「${step.label}」后 URL 未更新`).toHaveURL(re(`${base}/${step.path}`))
    await expectRendered(page, step.label)
  }

  // 栈顺序：工作台 → topics → calendar → works → materials → review。
  // v7 把导航更新包进 startTransition，history 与视图必须仍同步。
  await page.goBack()
  await expect(page, '后退一次应回到素材库').toHaveURL(re(`${base}/materials`))
  await expectRendered(page, '后退·素材库')

  await page.goForward()
  await expect(page, '前进应回到复盘').toHaveURL(re(`${base}/review`))
  await expectRendered(page, '前进·复盘')
})

test('SEC-RR7 桌面作品内嵌子路由、设置相对跳转与未知路径兜底', async ({ page }) => {
  const account = await registerAccount(page)
  const base = `/a/${account.id}`
  const workId = await createOutline(page)
  await expect(page).toHaveURL(re(`/works/${workId}`))

  // workId 是带参数的父路由 + 多个嵌套子路由，v7 相对解析最敏感处。
  const tabs = page.locator('nav[aria-label="发布进度"]').getByRole('link')
  const count = await tabs.count()
  expect(count, '发布进度导航项缺失，选择器可能已过期').toBeGreaterThan(1)
  for (let i = 1; i < count; i++) {
    const tab = tabs.nth(i)
    const href = await tab.getAttribute('href')
    expect(href, `发布进度第 ${i + 1} 项缺少 href`).toBeTruthy()
    await tab.click()
    await expect(page, `发布进度第 ${i + 1} 项未导航到 ${href}`).toHaveURL(re(href!))
    await expectRendered(page, `作品子路由 ${href}`)
  }

  // `/settings` 的 index 是相对跳转 `<Navigate to="accounts" replace />`。
  await page.goto('/settings')
  await expect(page, '设置首页的相对跳转应落到 accounts').toHaveURL(/\/settings\/accounts(\?|$)/)
  await expectRendered(page, '设置首页相对跳转')

  // 兜底路由必须仍生效。
  await page.goto('/no-such-page-sec-rr7')
  await expect(page, '未知路径应兜底回工作台').toHaveURL(re(base))
  await expectRendered(page, '未知路径兜底')
})
