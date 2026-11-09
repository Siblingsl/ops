// DEV-QA26（26 台账 §3 量化基线）：桌面端导航与交互性能测量。
// 固定条件：E2E webServer（8287/5287）、Electron 真实窗口 1440×1000、隔离 userData、本地 mock 模型。
// 指标：①主导航页面 goto→关键内容可见（SPA 路由切换，performance.now 差值）；②工作台刷新冷加载。
// 每页 3 轮 × 8 页 = 24 个导航样本 + 4 次刷新样本。输出 p50/p95/失败数。
// 用法：cd renderer && node scripts/probe-perf-nav.mjs
import { _electron } from '@playwright/test'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ORIGIN = process.env.OPS_PROBE_BASE ?? 'http://127.0.0.1:5287'
const OUT = resolve(process.cwd(), '../.playwright-results/audit26-desktop-perf')
const ROUNDS = Number(process.env.OPS_PERF_ROUNDS ?? 3)

function log(step, msg) { console.log(`[${step}] ${msg}`) }

const PAGES = [
  { key: 'dashboard', path: id => `/a/${id}`, ready: 'main' },
  { key: 'topics', path: id => `/a/${id}/topics`, ready: 'main' },
  { key: 'works', path: id => `/a/${id}/works`, ready: 'main' },
  { key: 'materials', path: id => `/a/${id}/materials`, ready: 'main' },
  { key: 'review', path: id => `/a/${id}/review`, ready: 'main' },
  { key: 'profile', path: id => `/a/${id}/profile`, ready: 'main' },
  { key: 'ops', path: id => `/a/${id}/ops`, ready: 'main' },
  { key: 'agent', path: () => `/agent`, ready: 'main' },
]

function pctl(values, p) {
  const s = [...values].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)
  return s[Math.max(0, idx)]
}

async function api(page, method, path, data) {
  const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json())
  return page.evaluate(async ({ url, method, data, csrf }) => {
    const response = await fetch(url, {
      method, credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${body.slice(0, 200)}`)
    return body ? JSON.parse(body) : null
  }, { url: `${ORIGIN}/api/v1${path}`, method, data, csrf: me.csrf_token })
}

async function main() {
  const userData = await mkdtemp(join(tmpdir(), 'ops-qa26-perf-'))
  const app = await _electron.launch({
    executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
    args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../desktop/.build/main.js')],
    env: { ...process.env, OPS_DESKTOP_DEV_URL: ORIGIN },
    timeout: 60_000,
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 1000 })
  const navSamples = []
  const failed = []
  try {
    // 注册登录
    const t0 = Date.now()
    await page.goto(`${ORIGIN}/register`)
    await page.getByLabel('用户名', { exact: true }).fill(`qa26-perf-${Date.now()}`)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await page.waitForURL(/settings\/accounts|a\//, { timeout: 30_000 })
    log('auth', `注册+落页 ${Date.now() - t0}ms`)
    // 等首屏稳定
    await page.waitForTimeout(2500)

    const accounts = await api(page, 'GET', '/accounts')
    if (!accounts.length) {
      await api(page, 'POST', '/accounts', { platform: 'xhs', name: 'QA26 性能走查号', content_format: 'image_note' })
    }
    const accountId = (await api(page, 'GET', '/accounts'))[0].id

    for (let round = 1; round <= ROUNDS; round++) {
      for (const p of PAGES) {
        const url = `${ORIGIN}${p.path(accountId)}`
        // 起点在旧页面取（同页面时钟）；导航后新文档的 performance.now 会重置，
        // 因此用 Date.now() 墙钟跨文档计时（Electron 本机无 NTP 抖动，误差毫秒级）。
        const start = Date.now()
        await page.goto(url)
        await page.waitForSelector('main', { timeout: 20_000 })
        // "可操作"判定：main 渲染出实质内容（SPA 数据加载完成窗口）
        await page.waitForLoadState('domcontentloaded')
        await page.waitForFunction(() => {
          const main = document.querySelector('main')
          return !!main && main.textContent && main.textContent.trim().length > 40
        }, { timeout: 20_000 })
        await page.waitForTimeout(300)
        const elapsed = Date.now() - start
        navSamples.push({ page: p.key, round, ms: Math.round(elapsed) })
      }
      // 刷新冷加载样本（dashboard）
      const start = Date.now()
      await page.reload()
      await page.waitForFunction(() => {
        const main = document.querySelector('main')
        return !!main && main.textContent && main.textContent.trim().length > 40
      }, { timeout: 20_000 })
      await page.waitForTimeout(300)
      const elapsed = Date.now() - start
      navSamples.push({ page: 'reload-dashboard', round, ms: Math.round(elapsed) })
      log('round', `${round}/${ROUNDS} 完成`)
    }

    await mkdir(OUT, { recursive: true })
    await writeFile(join(OUT, 'nav-samples.json'), JSON.stringify(navSamples, null, 2))

    // 汇总
    const byPage = {}
    for (const s of navSamples) (byPage[s.page] ??= []).push(s.ms)
    const report = {}
    let totalFail = 0
    for (const [key, values] of Object.entries(byPage)) {
      report[key] = { n: values.length, p50: pctl(values, 50), p95: pctl(values, 95), min: Math.min(...values), max: Math.max(...values) }
    }
    log('report', JSON.stringify(report, null, 2))
    await writeFile(join(OUT, 'perf-report.json'), JSON.stringify({ condition: { origin: ORIGIN, viewport: '1440x1000', rounds: ROUNDS, electron: true }, report, failed }, null, 2))
    log('done', `样本 ${navSamples.length}，失败 ${totalFail}，报告 ${join(OUT, 'perf-report.json')}`)
    await app.evaluate(({ app }) => app.exit(0))
  } catch (e) {
    log('FATAL', e.stack ?? String(e))
    process.exitCode = 1
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  } finally {
    await app?.close().catch(() => {})
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
}

await main()
