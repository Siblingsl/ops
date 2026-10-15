import { expect, test, type Page } from '@playwright/test'
import { api, createOutline, registerAccount } from './support'

async function watchStreams(page: Page) {
  await page.addInitScript(() => {
    const Native = window.EventSource
    const sources: EventSource[] = []
    Object.assign(window, { opt22Sources: sources })
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options)
        sources.push(this)
      }
    }
  })
}

async function visibility(page: Page, hidden: boolean) {
  await page.evaluate(value => {
    Object.defineProperty(document, 'hidden', { configurable: true, value })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: value ? 'hidden' : 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
}

async function streams(page: Page) {
  return page.evaluate(() => (window as unknown as { opt22Sources: EventSource[] }).opt22Sources.map(s => s.readyState))
}

test('OPT22 隐藏五分钟在线批注通知零请求，关闭推送，切回一秒内更新', async ({ page }) => {
  await registerAccount(page)
  const work = await createOutline(page)
  await watchStreams(page)
  await page.clock.install()
  const counts = { presence: 0, comments: 0, notifications: 0 }
  const completed: Record<string, number> = {}
  const paths: Record<string, keyof typeof counts> = {
    [`/api/v1/works/${work}/presence`]: 'presence',
    [`/api/v1/works/${work}/comments`]: 'comments',
    '/api/v1/notifications': 'notifications',
  }
  page.on('request', r => {
    const key = paths[new URL(r.url()).pathname]
    if (key) counts[key]++
  })
  page.on('response', async r => {
    const key = paths[new URL(r.url()).pathname]
    if (key && r.status() === 200) {
      await r.finished()
      completed[key] = Date.now()
    }
  })
  await page.evaluate(() => localStorage.setItem('ops.editor.sidebar', '1'))
  await page.goto(`/works/${work}?comment=opt22`)
  await expect(page.getByRole('button', { name: '发表批注', exact: true })).toBeVisible()
  await expect.poll(() => Object.keys(completed).length).toBe(3)
  await expect.poll(() => streams(page)).toContain(1)
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  await visibility(page, true)
  await expect.poll(async () => (await streams(page)).every(s => s === 2)).toBe(true)
  const before = { ...counts }
  const sourceCount = (await streams(page)).length
  await page.clock.runFor(300_000)
  expect(counts).toEqual(before)
  expect(await streams(page)).toHaveLength(sourceCount)
  expect((await streams(page)).every(s => s === 2)).toBe(true)
  await api(page, 'POST', `/works/${work}/comments`, { body: 'OPT22 切回后立即可见的新批注' })
  for (const key of Object.keys(completed)) delete completed[key]
  await page.clock.resume()
  const resumedAt = Date.now()
  await visibility(page, false)
  await expect.poll(() => Object.keys(completed).length, { timeout: 1000, intervals: [10, 20, 50] }).toBe(3)
  for (const ms of Object.values(completed)) expect(ms - resumedAt).toBeLessThan(1000)
  await expect(page.getByText('OPT22 切回后立即可见的新批注', { exact: true })).toBeVisible()
  await expect.poll(() => streams(page)).toContain(1)
  console.log('OPT22 hidden=300000ms presence/comments/notifications=0; visible response ms=', Object.fromEntries(Object.entries(completed).map(([k, v]) => [k, v - resumedAt])))
})

test('OPT22 通知连接失败后隐藏取消重连，切回恢复连接', async ({ page }) => {
  await watchStreams(page)
  await page.route('**/api/v1/notifications/stream', route => route.fulfill({ status: 503, body: 'local unavailable' }))
  const account = await registerAccount(page)
  await page.clock.install()
  await page.goto(`/a/${account.id}`)
  await expect.poll(async () => (await streams(page)).length).toBeGreaterThan(0)
  await expect.poll(async () => (await streams(page)).every(s => s === 2)).toBe(true)
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  await visibility(page, true)
  const before = (await streams(page)).length
  await page.clock.runFor(300_000)
  expect(await streams(page)).toHaveLength(before)
  await page.unroute('**/api/v1/notifications/stream')
  await visibility(page, false)
  await expect.poll(() => streams(page)).toContain(1)
  expect((await streams(page)).length).toBe(before + 1)
})
