import { test, expect, type Page } from '@playwright/test'
import { createOutline, registerAccount } from './support'

/**
 * react-router 6 → 7 升级验收（Dependabot #12/#13/#5/#6）。
 *
 * 为什么单独写这一份：仓里现有的 E2E 绝大多数用 `page.goto()` 直连 URL，
 * 走的是「整页加载 + 首次匹配」，绕过了 SPA 内部导航。而 v7 默认开启的
 * `v7_relativeSplatPath` 与 `v7_startTransition` 改的恰好是：
 *   1. splat 路由（`<Route path="*">`）内再嵌套 `<Routes>` 的路径解析基准；
 *   2. `navigate()` 推入 history 与视图更新之间的时序。
 * 这两件事只有「点链接 / 前进后退」才能覆盖，goto 覆盖不到。
 */

// v7 若把 splat 内的嵌套 Routes 解析错，页面不会报错，而是静默渲染成空白。
// 因此这里不看具体文案（易随设计变动），只看「有没有渲染出可见内容」。
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

test('SEC-RR7 侧边栏内部导航与前进后退保持 URL、视图同步', async ({ page }) => {
  const account = await registerAccount(page)
  const base = `/a/${account.id}`

  await expect(page).toHaveURL(re(base))
  await expectRendered(page, '工作台')

  // 每一项都是 Shell 内同一层路由之间的跳转，全部发生在 splat 路由的嵌套 Routes 里。
  const steps = [
    { label: '选题池', path: 'topics' },
    { label: '内容日历', path: 'calendar' },
    { label: '作品', path: 'works' },
    { label: '素材库', path: 'materials' },
    { label: '复盘', path: 'review' },
  ]
  for (const step of steps) {
    await page.getByRole('link', { name: step.label, exact: true }).first().click()
    await expect(page, `点击「${step.label}」后 URL 未更新`).toHaveURL(re(`${base}/${step.path}`))
    await expectRendered(page, step.label)
  }

  // v7 把导航状态更新包进 React.startTransition，history 与视图必须仍然同步。
  // 栈顺序：工作台 → topics → calendar → works → materials → review。
  await page.goBack()
  await expect(page, '后退一次应回到素材库').toHaveURL(re(`${base}/materials`))
  await expectRendered(page, '后退·素材库')

  await page.goBack()
  await expect(page, '再后退应回到作品').toHaveURL(re(`${base}/works`))
  await expectRendered(page, '后退·作品')

  await page.goForward()
  await expect(page, '前进应回到素材库').toHaveURL(re(`${base}/materials`))
  await expectRendered(page, '前进·素材库')
})

test('SEC-RR7 作品内嵌子路由、设置相对跳转与未知路径兜底', async ({ page }) => {
  const account = await registerAccount(page)
  const base = `/a/${account.id}`
  const workId = await createOutline(page)
  await expect(page).toHaveURL(re(`/works/${workId}`))

  // `works/:workId` 是带参数父路由 + 多个嵌套子路由，v7 相对解析最敏感的一处。
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

  // `/settings` 的 index 是 `<Navigate to="accounts" replace />`，属相对路径跳转。
  await page.goto('/settings')
  await expect(page, '设置首页的相对跳转应落到 accounts').toHaveURL(/\/settings\/accounts(\?|$)/)
  await expectRendered(page, '设置首页相对跳转')

  // 兜底路由 `<Route path="*" element={<Navigate to="/" replace />} />` 必须仍生效。
  await page.goto('/no-such-page-sec-rr7')
  await expect(page, '未知路径应兜底回工作台').toHaveURL(re(base))
  await expectRendered(page, '未知路径兜底')
})
