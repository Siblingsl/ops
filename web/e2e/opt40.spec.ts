import { expect, test } from '@playwright/test'
import { registerAccount } from './support'

test('OPT40 一千条素材分批显示并滚动保持至少 50fps', async ({ page }) => {
  const account = await registerAccount(page)
  const materials = Array.from({ length: 1000 }, (_, i) => ({
    id: `opt40-${String(i).padStart(4, '0')}`,
    kind: 'experience',
    content: `OPT40 素材 ${String(i).padStart(4, '0')}`,
    tags: [],
    valid_until: null,
    usage_count: 0,
    last_used_at: null,
    expired: false,
    created_at: '2026-10-01T00:00:00Z',
  }))
  await page.route(url => url.pathname === '/api/v1/materials' && url.searchParams.has('account_id'), route => route.fulfill({ json: materials }))
  await page.route(url => url.pathname === '/api/v1/materials/duplicates', route => route.fulfill({ json: [] }))

  await page.goto(`/a/${account.id}/materials`)
  await expect(page.getByText('OPT40 素材 0049', { exact: true })).toBeVisible()
  await expect(page.getByText('OPT40 素材 0050', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '加载更多素材' })).toBeVisible()

  for (let batch = 2; batch <= 20; batch++) {
    await page.getByRole('button', { name: '加载更多素材' }).click()
    await expect(page.getByText(`OPT40 素材 ${String(batch * 50 - 1).padStart(4, '0')}`, { exact: true })).toBeVisible()
  }
  await expect(page.getByText('OPT40 素材 0999', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '加载更多素材' })).toHaveCount(0)

  const fps = await page.evaluate(async () => {
    const frames: number[] = []
    const started = performance.now()
    let previous = 0
    let direction = 1
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        if (previous) frames.push(now - previous)
        previous = now
        const scroller = document.scrollingElement!
        const max = Math.max(0, scroller.scrollHeight - window.innerHeight)
        const next = scroller.scrollTop + direction * 600
        if (next >= max) {
          direction = -1
          scroller.scrollTop = max
        } else if (next <= 0) {
          direction = 1
          scroller.scrollTop = 0
        } else {
          scroller.scrollTop = next
        }
        if (now - started < 3000) requestAnimationFrame(tick)
        else resolve()
      }
      requestAnimationFrame(tick)
    })
    return frames.length ? 1000 / (frames.reduce((sum, frame) => sum + frame, 0) / frames.length) : 0
  })
  console.log(`OPT40 滚动平均帧率: ${fps.toFixed(2)} fps`)
  expect(fps).toBeGreaterThanOrEqual(50)
})
