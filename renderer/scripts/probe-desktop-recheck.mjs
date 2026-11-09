import { chromium } from '@playwright/test'

const CDP = process.env.OPS_CDP_URL || 'http://127.0.0.1:9222'
const browser = await chromium.connectOverCDP(CDP)
const context = browser.contexts()[0]
const page = context.pages().find((p) => /5174/.test(p.url())) || context.pages()[0]
console.log('url', page.url())

async function probe(path) {
  return page.evaluate(async (path) => {
    const t0 = performance.now()
    try {
      const res = await fetch(`/api/v1${path}`, { credentials: 'include' })
      const text = await res.text()
      return { path, status: res.status, ms: Math.round(performance.now() - t0), body: text.slice(0, 180) }
    } catch (e) {
      return { path, status: 0, ms: Math.round(performance.now() - t0), body: String(e?.message || e) }
    }
  }, path)
}

for (const path of ['/auth/me', '/auth/status', '/accounts', '/system/info', '/me/preferences', '/agent/bootstrap']) {
  console.log(JSON.stringify(await probe(path)))
}
await browser.close().catch(() => undefined)
