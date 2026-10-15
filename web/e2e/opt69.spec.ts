import { expect, test } from '@playwright/test'
import { registerAccount } from './support'

type Opt69Stream = { fail(): void; open(): void; changed(): void }

test('OPT69 通知断线立即重试、指数退避，online 后两秒内恢复角标', async ({ page }) => {
  await page.addInitScript(() => {
    const sources: MockEventSource[] = []
    class MockEventSource extends EventTarget {
      readonly CONNECTING = 0
      readonly OPEN = 1
      readonly CLOSED = 2
      readonly url: string
      readonly withCredentials = false
      readyState = this.CONNECTING
      onopen: ((this: EventSource, ev: Event) => unknown) | null = null
      onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null
      onerror: ((this: EventSource, ev: Event) => unknown) | null = null

      constructor(url: string | URL) {
        super()
        this.url = String(url)
        sources.push(this)
      }

      close() { this.readyState = this.CLOSED }
      fail() { this.readyState = this.CLOSED; this.onerror?.call(this as unknown as EventSource, new Event('error')) }
      open() { this.readyState = this.OPEN; this.onopen?.call(this as unknown as EventSource, new Event('open')) }
      changed() { this.dispatchEvent(new Event('changed')) }
    }
    Object.assign(window, { opt69Sources: sources })
    window.EventSource = MockEventSource as unknown as typeof EventSource
  })

  await registerAccount(page)
  let unread = 0
  await page.route('**/api/v1/notifications', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { items: [], unread, active_jobs: 0 } })
    : route.continue())
  await page.clock.install()
  await page.evaluate(() => { Math.random = () => 0.5 })

  const count = () => page.evaluate(() => (window as unknown as { opt69Sources: Opt69Stream[] }).opt69Sources.length)
  const fail = (index: number) => page.evaluate(i => (window as unknown as { opt69Sources: Opt69Stream[] }).opt69Sources[i].fail(), index)
  await expect.poll(count).toBeGreaterThan(0)
  const initialCount = await count()
  await fail(initialCount - 1)
  await expect.poll(count).toBe(initialCount + 1)

  await fail(initialCount)
  await page.clock.runFor(700)
  expect(await count()).toBe(initialCount + 1)
  await page.clock.runFor(300)
  await expect.poll(count).toBe(initialCount + 2)

  await fail(initialCount + 1)
  await page.clock.runFor(500)
  const recoveredAt = Date.now()
  unread = 1
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect.poll(count).toBe(initialCount + 3)
  await page.evaluate(() => {
    const sources = (window as unknown as { opt69Sources: Opt69Stream[] }).opt69Sources
    const source = sources[sources.length - 1]
    source.open()
    source.changed()
  })
  await expect(page.locator('button[title="通知与 AI 任务"] span')).toHaveText('1')
  expect(Date.now() - recoveredAt).toBeLessThan(2000)
  await page.clock.runFor(10_000)
  expect(await count()).toBe(initialCount + 3)
})
