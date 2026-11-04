import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

function percentile(values: number[], percentile: number) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)] ?? 0
}

test('DEV-QA26 G8 375px 移动导航触控样本与页面控件尺寸诊断', async ({ browser, baseURL }) => {
  test.setTimeout(240_000)
  const context = await browser.newContext({
    baseURL: new URL(baseURL!).origin,
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  })
  try {
    const page = await context.newPage()
    const account = await registerAccount(page)
    const work = await api(page, 'POST', `/accounts/${account.id}/works`, {
      title: 'DEV-QA26 移动端控件尺寸诊断作品', content_format: 'image_note',
    }) as { id: string }
    const targets: { label: string; path: string; optional?: boolean }[] = [
      { label: '选题池', path: `/a/${account.id}/topics` },
      { label: '内容日历', path: `/a/${account.id}/calendar` },
      { label: '素材库', path: `/a/${account.id}/materials` },
      { label: '复盘', path: `/a/${account.id}/review` },
      { label: '运营', path: `/a/${account.id}/ops` },
      { label: '账号档案', path: `/a/${account.id}/profile` },
      { label: '图片库', path: '/images' },
      { label: 'AI 对话', path: '/agent', optional: true },
      { label: '偏好设置', path: '/settings/preferences' },
      { label: '选题池', path: `/a/${account.id}/topics` },
      { label: '复盘', path: `/a/${account.id}/review` },
    ]
    const clickSamples: number[] = []
    const diagnostics: Array<{ route: string; controls: number; under24: number; unnamed: number; overflow: number; candidates: Array<{ role: string; name: string; width: number; height: number }> }> = []

    async function scan(route: string) {
      const result = await page.evaluate(() => {
        const visible = (element: Element) => {
          const style = getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
        }
        const name = (element: Element) => {
          const aria = element.getAttribute('aria-label')?.trim()
          if (aria) return aria
          const labelledBy = element.getAttribute('aria-labelledby')
          if (labelledBy) {
            const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? '').filter(Boolean).join(' ')
            if (text) return text
          }
          const title = element.getAttribute('title')?.trim()
          if (title) return title
          const labels = 'labels' in element ? Array.from((element as HTMLInputElement).labels ?? []).map((label) => label.textContent?.trim() ?? '').filter(Boolean).join(' ') : ''
          if (labels) return labels
          const text = (element as HTMLElement).innerText?.trim() || element.textContent?.trim()
          if (text) return text
          return element.querySelector('img[alt]')?.getAttribute('alt')?.trim() ?? ''
        }
        const selector = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="link"]'
        const elements = [...new Set(Array.from(document.querySelectorAll(selector)))].filter(visible)
        const targets = elements.map((element) => {
          const rect = element.getBoundingClientRect()
          return {
            role: element.getAttribute('role') ?? element.tagName.toLowerCase(),
            name: name(element).slice(0, 64),
            width: Math.round(rect.width * 100) / 100,
            height: Math.round(rect.height * 100) / 100,
          }
        })
        return {
          controls: targets.length,
          under24: targets.filter((target) => target.width < 24 || target.height < 24).length,
          unnamed: targets.filter((target) => !target.name).length,
          overflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
          candidates: targets.filter((target) => target.width < 24 || target.height < 24).slice(0, 8),
        }
      })
      diagnostics.push({ route, ...result })
    }

    for (const target of targets) {
      await page.goto(`/a/${account.id}`)
      const openStarted = performance.now()
      await page.getByRole('button', { name: '更多导航' }).tap()
      const drawer = page.getByRole('dialog', { name: '更多导航' })
      await expect(drawer).toBeVisible()
      clickSamples.push(performance.now() - openStarted)
      const link = drawer.getByRole('link', { name: target.label, exact: true })
      if (target.optional && await link.count() === 0) {
        await page.keyboard.press('Escape')
        continue
      }
      await expect(link).toBeVisible()
      const navigateStarted = performance.now()
      await link.tap()
      await expect.poll(() => new URL(page.url()).pathname).toBe(target.path)
      clickSamples.push(performance.now() - navigateStarted)
      await scan(target.path)
    }

    for (const route of [
      `/works/${work.id}`,
      `/works/${work.id}/check`,
      `/works/${work.id}/pack`,
      `/works/${work.id}/preview`,
      '/settings/models',
      '/settings/skills',
      '/settings/accounts',
      '/settings/members',
      '/settings/export',
    ]) {
      await page.goto(route)
      await expect(page.locator('body')).toBeVisible()
      await scan(route)
    }

    expect(clickSamples.length).toBeGreaterThanOrEqual(20)
    expect(diagnostics.every((item) => item.overflow <= 1)).toBeTruthy()
    console.log('QA26_G8_MOBILE_375PX', JSON.stringify({
      clicks: clickSamples.length,
      clickP50Ms: Math.round(percentile(clickSamples, 0.5) * 100) / 100,
      clickP95Ms: Math.round(percentile(clickSamples, 0.95) * 100) / 100,
      failures: 0,
      routes: diagnostics.length,
      controls: diagnostics.reduce((sum, item) => sum + item.controls, 0),
      under24RawTargets: diagnostics.reduce((sum, item) => sum + item.under24, 0),
      unnamedCandidates: diagnostics.reduce((sum, item) => sum + item.unnamed, 0),
      maxOverflow: Math.max(...diagnostics.map((item) => item.overflow)),
      sample: diagnostics.filter((item) => item.under24 > 0).slice(0, 8),
    }))
    await page.goto('/a/' + account.id)
    const moreTrigger = page.getByRole('button', { name: '更多导航' })
    await moreTrigger.tap()
    const drawer = page.getByRole('dialog', { name: '更多导航' })
    await expect(drawer).toBeVisible()
    const closeButton = drawer.getByRole('button', { name: '关闭', exact: true })
    await expect(closeButton).toBeFocused()
    const focusables = drawer.locator('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')
    const lastFocusable = focusables.last()
    await page.keyboard.press('Shift+Tab')
    await expect(lastFocusable).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(closeButton).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await expect(moreTrigger).toBeFocused()
  } finally {
    await context.close()
  }
})
