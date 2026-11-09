import { chromium } from '@playwright/test'

// 账号口令只从环境变量取，仓库里不存任何默认凭据。
const USER = process.env.OPS_PROBE_USER
const PASS = process.env.OPS_PROBE_PASS
if (!USER || !PASS) throw new Error('请设置 OPS_PROBE_USER / OPS_PROBE_PASS 后再运行探针')
const CDP = process.env.OPS_CDP_URL || 'http://127.0.0.1:9222'

function setNativeValue(locator, value) {
  return locator.evaluate((el, v) => {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (!setter) throw new Error('no native value setter')
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
}

async function apiProbe(page, method, path, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const started = performance.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120_000)
    try {
      const headers = { Accept: 'application/json' }
      let payload
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json'
        const me = await fetch('/api/v1/auth/me', { credentials: 'include', signal: controller.signal })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
        if (me?.csrf_token) headers['X-CSRF-Token'] = me.csrf_token
        payload = JSON.stringify(body)
      }
      const res = await fetch(`/api/v1${path}`, {
        method,
        credentials: 'include',
        headers,
        body: payload,
        signal: controller.signal,
      })
      const text = await res.text()
      let json
      try {
        json = JSON.parse(text)
      } catch {
        json = text.slice(0, 240)
      }
      return { path, method, status: res.status, ms: Math.round(performance.now() - started), ok: res.ok, body: json }
    } catch (err) {
      return {
        path,
        method,
        status: 0,
        ms: Math.round(performance.now() - started),
        ok: false,
        error: String(err?.message || err),
      }
    } finally {
      clearTimeout(timer)
    }
  }, { method, path, body })
}

const browser = await chromium.connectOverCDP(CDP)
const context = browser.contexts()[0] || await browser.newContext()
let page = context.pages().find((p) => /localhost:5174|127\.0\.0\.1:5174/.test(p.url())) || context.pages()[0]
if (!page) page = await context.newPage()

console.log('[full] page url:', page.url())
await page.waitForLoadState('domcontentloaded')

// Fresh login cycle
console.log('[full] logout (best-effort)')
await apiProbe(page, 'POST', '/auth/logout', {})
await page.goto('http://localhost:5174/login', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.getByRole('heading', { name: '登录' }).waitFor({ timeout: 30000 })

console.log('[full] login as', USER)
await setNativeValue(page.getByLabel('用户名', { exact: true }), USER)
await setNativeValue(page.getByLabel('密码', { exact: true }), PASS)
const loginResp = page.waitForResponse(
  (r) => r.url().includes('/api/v1/auth/login') && r.request().method() === 'POST',
  { timeout: 120000 },
)
await page.getByRole('button', { name: '登录', exact: true }).click()
const resp = await loginResp
const loginBody = await resp.text()
console.log('[full] login:', resp.status(), loginBody.slice(0, 160))
if (!resp.ok()) {
  process.exitCode = 1
  await browser.close().catch(() => undefined)
  process.exit(1)
}
await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 60000 })
console.log('[full] after login:', page.url())

const results = []
const push = async (method, path, body) => {
  const r = await apiProbe(page, method, path, body)
  results.push(r)
  const detail = r.ok
    ? `OK ${r.status} ${r.ms}ms`
    : `FAIL ${r.status || 'ERR'} ${r.ms}ms ${r.error || JSON.stringify(r.body)?.slice(0, 120)}`
  console.log(`[full] ${method} ${path} -> ${detail}`)
  return r
}

const me = await push('GET', '/auth/me')
await push('GET', '/auth/status')
await push('GET', '/system/info')
await push('GET', '/me/preferences')
await push('GET', '/agent/bootstrap')
const accounts = await push('GET', '/accounts')
const list = Array.isArray(accounts.body) ? accounts.body : []
if (list[0]?.id) {
  const id = list[0].id
  await push('GET', `/accounts/${id}/dashboard`)
  await push('GET', `/accounts/${id}/next-actions?limit=8`)
  await push('GET', `/accounts/${id}/health`)
  await push('GET', `/works?account_id=${id}&limit=10`)
}

const pages = ['/', '/settings/accounts', '/settings/models', '/settings/members', '/agent']
for (const path of pages) {
  const t0 = Date.now()
  try {
    await page.goto(`http://localhost:5174${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(1500)
    const title = await page.title().catch(() => '')
    const bodyText = await page.locator('body').innerText().catch(() => '')
    const bad = /525:|SSL handshake|数据库不可用|服务器内部错误|无法连接/.test(bodyText)
    console.log(`[full] page ${path} -> ${bad ? 'FAIL' : 'OK'} ${Date.now() - t0}ms title=${JSON.stringify(title).slice(0, 60)}`)
    results.push({ path: `PAGE ${path}`, method: 'GET', status: bad ? 500 : 200, ms: Date.now() - t0, ok: !bad })
  } catch (err) {
    console.log(`[full] page ${path} -> FAIL ${Date.now() - t0}ms ${err.message}`)
    results.push({ path: `PAGE ${path}`, method: 'GET', status: 0, ms: Date.now() - t0, ok: false, error: err.message })
  }
}

const failed = results.filter((r) => !r.ok)
console.log('\n=== FULL SUMMARY ===')
console.log(`user=${me.body?.username} role=${me.body?.role} workspace=${me.body?.workspace?.name}`)
console.log(`accounts=${list.length}`)
console.log(`probed=${results.length} failed=${failed.length}`)
if (failed.length) {
  for (const f of failed) console.log(`- ${f.method} ${f.path}: ${f.status} ${f.error || ''}`)
  process.exitCode = 1
} else {
  console.log('all checks OK')
}

await browser.close().catch(() => undefined)
