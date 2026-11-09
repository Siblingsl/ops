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
    try {
      const headers = { Accept: 'application/json' }
      let payload
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json'
        const me = await fetch('/api/v1/auth/me', { credentials: 'include' }).then((r) => r.ok ? r.json() : null).catch(() => null)
        if (me?.csrf_token) headers['X-CSRF-Token'] = me.csrf_token
        payload = JSON.stringify(body)
      }
      const res = await fetch(`/api/v1${path}`, {
        method,
        credentials: 'include',
        headers,
        body: payload,
      })
      const text = await res.text()
      let json
      try { json = JSON.parse(text) } catch { json = text.slice(0, 200) }
      return {
        path,
        method,
        status: res.status,
        ms: Math.round(performance.now() - started),
        ok: res.ok,
        body: json,
      }
    } catch (err) {
      return {
        path,
        method,
        status: 0,
        ms: Math.round(performance.now() - started),
        ok: false,
        error: String(err?.message || err),
      }
    }
  }, { method, path, body })
}

const browser = await chromium.connectOverCDP(CDP)
const context = browser.contexts()[0] || await browser.newContext()
const pages = context.pages()
let page = pages.find((p) => /localhost:5174|127\.0\.0\.1:5174/.test(p.url())) || pages[0]
if (!page) page = await context.newPage()

console.log('[probe] page url:', page.url())
await page.waitForLoadState('domcontentloaded')

// Wait for login or app shell
const deadline = Date.now() + 30000
while (Date.now() < deadline) {
  const url = page.url()
  const hasLogin = await page.getByRole('heading', { name: '登录' }).count()
  const hasApp = await page.locator('body').count()
  if (hasLogin || hasApp) break
  await page.waitForTimeout(250)
  if (!url.includes('5174')) {
    await page.goto('http://localhost:5174/login').catch(() => undefined)
  }
}

if (!(await page.getByRole('heading', { name: '登录' }).count()) && !/\/login/.test(page.url())) {
  // maybe already logged in — check /auth/me
  const me = await apiProbe(page, 'GET', '/auth/me')
  if (!me.ok) {
    await page.goto('http://localhost:5174/login')
    await page.getByRole('heading', { name: '登录' }).waitFor({ timeout: 15000 })
  }
}

if (await page.getByRole('heading', { name: '登录' }).count()) {
  console.log('[probe] logging in as', USER)
  const userInput = page.getByLabel('用户名', { exact: true })
  const passInput = page.getByLabel('密码', { exact: true })
  await userInput.waitFor({ timeout: 15000 })
  await setNativeValue(userInput, USER)
  await setNativeValue(passInput, PASS)
  const loginResp = page.waitForResponse(
    (r) => r.url().includes('/api/v1/auth/login') && r.request().method() === 'POST',
    { timeout: 45000 },
  )
  await page.getByRole('button', { name: '登录', exact: true }).click()
  const resp = await loginResp
  console.log('[probe] login status:', resp.status(), 'ms roughly via network')
  if (!resp.ok()) {
    const text = await resp.text()
    console.error('[probe] login failed body:', text.slice(0, 500))
    process.exitCode = 1
    await browser.close().catch(() => undefined)
    process.exit(1)
  }
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 })
  console.log('[probe] after login url:', page.url())
} else {
  console.log('[probe] already past login, url:', page.url())
}

const me = await apiProbe(page, 'GET', '/auth/me')
console.log('[probe] me:', JSON.stringify({
  ok: me.ok, status: me.status, ms: me.ms,
  user: me.body?.username, role: me.body?.role, workspace: me.body?.workspace?.name,
}))

const accounts = await apiProbe(page, 'GET', '/accounts')
const accountList = Array.isArray(accounts.body) ? accounts.body : []
const firstAccount = accountList[0]
console.log('[probe] accounts:', JSON.stringify({
  ok: accounts.ok, status: accounts.status, ms: accounts.ms, count: accountList.length,
  sample: accountList.slice(0, 3).map((a) => ({ id: a.id, name: a.name, platform: a.platform })),
}))

const paths = [
  ['GET', '/auth/status'],
  ['GET', '/system/info'],
  ['GET', '/me/preferences'],
  ['GET', '/agent/bootstrap'],
]
if (firstAccount?.id) {
  const id = firstAccount.id
  paths.push(
    ['GET', `/accounts/${id}/dashboard`],
    ['GET', `/accounts/${id}/next-actions?limit=8`],
    ['GET', `/accounts/${id}/health`],
    ['GET', `/accounts/${id}/rhythm`],
    ['GET', `/accounts/${id}/brief`],
    ['GET', `/accounts/${id}/daily?prepare=false`],
    ['GET', `/works?account_id=${id}&limit=20`],
  )
}

const results = []
for (const [method, path] of paths) {
  const r = await apiProbe(page, method, path)
  results.push(r)
  const summary = r.ok
    ? `OK ${r.status} ${r.ms}ms`
    : `FAIL ${r.status || 'ERR'} ${r.ms}ms ${r.error || JSON.stringify(r.body)?.slice(0, 120)}`
  console.log(`[probe] ${method} ${path} -> ${summary}`)
}

const failed = [me, accounts, ...results].filter((r) => !r.ok)
console.log('\n=== SUMMARY ===')
console.log(`probed: ${2 + results.length}, failed: ${failed.length}`)
if (failed.length) {
  for (const f of failed) {
    console.log(`- ${f.method || 'GET'} ${f.path}: status=${f.status} error=${f.error || ''} body=${typeof f.body === 'string' ? f.body : JSON.stringify(f.body)?.slice(0, 200)}`)
  }
  process.exitCode = 1
} else {
  console.log('all probed endpoints OK')
}

// Keep Electron alive — only disconnect Playwright CDP client.
await browser.close().catch(() => undefined)
