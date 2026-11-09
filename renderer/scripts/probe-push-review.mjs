// DEV-QA26（26 台账 G5-06/G6/G2-03）：真实 Electron 交互走查——
// 公众号凭证 → 检查逐项确认 → 写入草稿箱（mock 微信）→ 复盘看板与手动录入。
// 用法：cd renderer && node scripts/probe-push-review.mjs
// 前置：E2E webServer 已起（5287/8287/8297）时直接 OPS_PROBE_BASE 指向；否则脚本自起一套（跳过，默认要求外部 webServer）。
import { _electron } from '@playwright/test'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ORIGIN = process.env.OPS_PROBE_BASE ?? 'http://127.0.0.1:5287'
const OUT = resolve(process.cwd(), '../.playwright-results/audit26-desktop-push')
const USER = `qa26-push-${Date.now()}`

function log(step, msg) {
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${step}: ${msg}`)
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
    if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${body.slice(0, 300)}`)
    return body ? JSON.parse(body) : null
  }, { url: `${ORIGIN}/api/v1${path}`, method, data, csrf: me.csrf_token })
}

async function shot(page, name) {
  await mkdir(OUT, { recursive: true })
  const p = join(OUT, `${name}.png`)
  await page.screenshot({ path: p })
  log('shot', p)
}

const paragraphs = ['散步的价值不在锻炼，而在给大脑留出空白。', '我用语音备忘录记录，回家整理成段。', '三天实测产出了两条选题和这篇初稿。']

async function seedWechatWork(page) {
  const account = await api(page, 'POST', '/accounts', {
    platform: 'wechat_mp', name: 'QA26 推送走查号', content_format: 'long_article',
  })
  await api(page, 'PUT', `/accounts/${account.id}/wechat-credential`, {
    app_id: 'wx1234567890abcdef', app_secret: 'mock-secret-qa26-0123456789abcdef',
  })
  let w = await api(page, 'POST', `/accounts/${account.id}/works`, { content_format: 'long_article' })
  w = await api(page, 'PATCH', `/works/${w.id}`, {
    title: 'qa26 推送走查：散步是最好的输入', viewpoint: '散步是最便宜也最被低估的创作输入方式。', base_revision: w.revision,
  })
  w = await api(page, 'PUT', `/works/${w.id}/outline`, {
    confirm: true, base_revision: w.revision,
    items: paragraphs.map((_, i) => ({ heading: `第${i + 1}节`, key_point: `要点${i + 1}`, material_ids: [] })),
  })
  for (const [i, s] of w.sections.entries()) {
    await api(page, 'PATCH', `/sections/${s.id}`, { content_md: paragraphs[i], base_revision: s.revision })
  }
  // FR-M7-07：公众号封面强制（检查格式项"封面与裁剪区域"）。上传 96×96 PNG 并以归一化居中裁剪设为封面。
  const asset = await page.evaluate(async ({ workId }) => {
    const canvas = document.createElement('canvas')
    canvas.width = 960
    canvas.height = 480
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#2f6fed'
    ctx.fillRect(0, 0, 960, 480)
    const blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
    const me = await (await fetch('/api/v1/auth/me')).json()
    const form = new FormData()
    form.append('file', blob, 'cover.png')
    const r = await fetch(`/api/v1/works/${workId}/assets`, {
      method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': me.csrf_token }, body: form,
    })
    if (!r.ok) throw new Error(`asset upload: ${r.status} ${await r.text()}`)
    return r.json()
  }, { workId: w.id })
  log('seed', `cover asset=${asset.id}`)
  // 上传资产会 touchContent 使修订号变化，重取最新 revision 再设封面。
  w = await api(page, 'GET', `/works/${w.id}`)
  w = await api(page, 'PATCH', `/works/${w.id}`, {
    cover_asset_id: asset.id,
    // 960×480（imgAspect=2 < 2.35）：2.35:1 垂直居中 ch=2/2.35；1:1 水平居中 cw=480/960。
    cover_crops: {
      '2.35_1': { x1: 0, y1: (1 - 2 / 2.35) / 2, x2: 1, y2: 1 - (1 - 2 / 2.35) / 2 },
      '1_1': { x1: (1 - 0.5) / 2, y1: 0, x2: (1 + 0.5) / 2, y2: 1 },
    },
    base_revision: w.revision,
  })
  log('seed', `work=${w.id} 封面已设`)
  log('seed', `account=${account.id} work=${w.id}`)
  return { accountId: account.id, workId: w.id }
}

async function main() {
  const userData = await mkdtemp(join(tmpdir(), 'ops-qa26-push-'))
  const app = await _electron.launch({
    executablePath: resolve(process.cwd(), '../desktop/node_modules/electron/dist/electron.exe'),
    args: [`--user-data-dir=${userData}`, resolve(process.cwd(), '../desktop/.build/main.js')],
    env: { ...process.env, OPS_DESKTOP_DEV_URL: ORIGIN },
    timeout: 60_000,
  })
  const page = await app.firstWindow()
  try {
    // 注册（绝对 URL；Electron page 无 context baseURL）
    await page.goto(`${ORIGIN}/register`)
    await page.getByLabel('用户名', { exact: true }).fill(USER)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await page.waitForURL(/settings\/accounts|a\//, { timeout: 20_000 }).catch(() => {})
    const meStatus = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)
    if (meStatus !== 200) throw new Error('注册后未登录')
    log('auth', 'registered & logged in')

    const { workId } = await seedWechatWork(page)

    // ---- 检查页：开始检查 → 等完成 → 逐项确认 → 确认完成检查 ----
    await page.goto(`${ORIGIN}/works/${workId}/check`)
    await page.getByRole('button', { name: '开始检查', exact: true }).click().catch(() => log('check', '无开始检查按钮（可能已自动开始）'))
    await page.waitForTimeout(1500)
    await page.getByRole('button', { name: '在原文中修改' }).first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
    await shot(page, '01-check-initial')
    // AI 事实核查可能仍在进行：等 fact 不再 pending（通过按钮可用性判定）
    for (let round = 0; round < 40; round++) {
      const items = await page.evaluate(() => {
        const found = []
        for (const el of document.querySelectorAll('input[name]')) {
          if ((el.type === 'radio' || el.type === 'checkbox') && el.name) found.push(el.name)
        }
        return [...new Set(found)]
      })
      if (items.length > 0) {
        let acted = 0
        for (const name of items) {
          const input = page.locator(`input[name="${name}"]`).first()
          if (await input.isChecked().catch(() => true)) continue
          if (!(await input.isEnabled().catch(() => false))) { log('confirm-skip', `${name}: disabled`); continue }
          await input.scrollIntoViewIfNeeded().catch(() => {})
          await input.check({ force: true }).then(() => { acted++ }).catch(e => log('confirm-skip', `${name}: ${e.message.slice(0, 60)}`))
        }
        log('confirm', `acted ${acted}`)
        // 可能出现新的确认项（敏感词逐条）——再查一轮
        const remain = await page.evaluate(() => [...new Set([...document.querySelectorAll('input[name]')].filter(el => (el.type === 'radio' || el.type === 'checkbox') && el.name && !el.checked && !el.disabled).map(el => el.name))])
        if (remain.length === 0) break
        log('confirm', `剩余 ${remain.length} 项，继续`)
      } else {
        await page.waitForTimeout(1500)
      }
    }
    await shot(page, '02-check-confirmed')
    // 诊断：打印所有"必须修改"的格式条目（勾选解决不了的）
    const blocking = await page.evaluate(() => {
      const out = []
      for (el of document.querySelectorAll('main div')) {
        const t = el.textContent ?? ''
        if (t.includes('必须修改') && t.length < 400 && !out.some(x => t.includes(x))) out.push(t.replace(/\s+/g, ' ').trim())
      }
      return out.slice(0, 3)
    })
    log('check', '必须修改条目: ' + JSON.stringify(blocking))
    const completeBtn = page.getByRole('button', { name: '确认完成检查', exact: true })
    await completeBtn.waitFor({ state: 'visible', timeout: 15_000 })
    const disabledReason = await completeBtn.evaluate(el => el.disabled ? el.closest('div')?.parentElement?.textContent?.slice(0, 120) ?? 'disabled' : 'enabled')
    log('check', '确认按钮状态: ' + disabledReason)
    await completeBtn.click({ timeout: 5000 }).catch(async e => {
      log('check', '点击失败，重试一次: ' + e.message.slice(0, 60))
      await page.waitForTimeout(2000)
      await completeBtn.click({ timeout: 5000 })
    })
    await page.waitForTimeout(2000)
    const status = await api(page, 'GET', `/works/${workId}`)
    log('check', `作品状态: ${status.status}（期望 ready）`)
    await shot(page, '03-check-done')

    // ---- 推送页：填作者 → 写入草稿箱 ----
    await page.goto(`${ORIGIN}/works/${workId}/push`)
    await page.getByRole('textbox', { name: /作者/ }).first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
    await page.waitForTimeout(1500)
    await shot(page, '04-push-form')
    const author = page.getByRole('textbox', { name: /作者/ }).first()
    if (await author.isVisible().catch(() => false)) {
      await author.fill('qa26 走查')
      log('push', '作者已填')
    } else {
      log('push', '未找到作者输入框（页面状态见截图）')
    }
    const pushBtn = page.getByRole('button', { name: /写入草稿箱|写入草稿/ }).first()
    if (await pushBtn.isVisible().catch(() => false)) {
      const resp = page.waitForResponse(r => r.url().includes('/wechat/push') && r.request().method() === 'POST', { timeout: 60_000 }).catch(() => null)
      await pushBtn.click({ timeout: 5000 })
      const r = await resp
      if (r) {
        log('push', `POST /wechat/push → ${r.status()}`)
        const body = await r.text()
        log('push', '响应: ' + body.slice(0, 300))
      } else {
        log('push', '未捕获 /wechat/push 请求（可能按钮未触发或有前置步骤）')
      }
    } else {
      log('push', '写入草稿按钮不可见（闸门或页面状态，见截图）')
    }
    await page.waitForTimeout(2500)
    await shot(page, '05-push-result')
    const workAfter = await api(page, 'GET', `/works/${workId}`)
    log('push', `推送后状态: ${workAfter.status}；草稿链接: ${JSON.stringify(workAfter.publish_history?.slice(-1) ?? workAfter.draft_url ?? null).slice(0, 200)}`)

    // ---- 复盘页：看板 + 手动录入 ----
    const accounts = await api(page, 'GET', '/accounts')
    const acc = accounts[0]
    await page.goto(`${ORIGIN}/a/${acc.id}/review`)
    await page.waitForTimeout(2500)
    await shot(page, '06-review-board')
    const backfill = page.getByRole('link', { name: '去回填链接' }).first()
    if (await backfill.isVisible().catch(() => false)) {
      // 回填入口落点在 push 页；滚到底部"回填已发布"区截图
      await page.goto(`${ORIGIN}/works/${workId}/push`)
      await page.waitForTimeout(1500)
      const backfillArea = page.getByText('回填已发布').first()
      await backfillArea.scrollIntoViewIfNeeded().catch(() => {})
      await page.waitForTimeout(500)
      await shot(page, '07-review-backfill-form')
      const formText = await page.evaluate(() => {
        const els = [...document.querySelectorAll('main *')]
        const area = els.find(el => el.textContent?.includes('回填已发布') && el.children.length < 30 && el.textContent.length < 900)
        return (area?.textContent ?? document.querySelector('main')?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 400)
      })
      log('review', '回填区: ' + formText)
    } else {
      // 兜底：右上"录入数据"主入口
      const manual = page.getByRole('button', { name: '录入数据' }).first()
      if (await manual.isVisible().catch(() => false)) {
        await manual.click({ timeout: 5000 })
        await page.waitForTimeout(1500)
        await shot(page, '07-review-backfill-form')
        const formText = await page.evaluate(() => document.querySelector('main')?.textContent?.replace(/\s+/g, ' ')?.slice(0, 500) ?? '')
        log('review', '录入数据表单: ' + formText.slice(0, 300))
      } else {
        log('review', '回填与录入入口均不可见（见截图）')
      }
    }
    await app.evaluate(({ app }) => app.exit(0))
  } catch (e) {
    log('FATAL', e.stack ?? String(e))
    await shot(page, '99-fatal').catch(() => {})
    process.exitCode = 1
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await app?.close().catch(() => {})
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
}

await main()
