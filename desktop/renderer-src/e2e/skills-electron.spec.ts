import { _electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('TestSkillRealElectronGenerationUsesBoundSkillAndPrivateReceipt', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '真实 Windows Electron 验收')
  test.setTimeout(120_000)
  const prefix = join(tmpdir(), 'ops-skill-electron-')
  const profile = await mkdtemp(prefix)
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL }, timeout: 60_000,
    })
    const page = await app.firstWindow()
    // Electron renderer 会话与 Playwright 的 page.request cookie jar 独立。
    const api = async (_page: typeof page, method: string, path: string, data?: unknown) => page.evaluate(async ({ method, path, data }) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      const response = await fetch('/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`)
      return response.json()
    }, { method, path, data })
    await page.goto(`${baseURL}/register`)
    await page.getByLabel('用户名', { exact: true }).fill(`skill-electron-${Date.now()}`)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    const account = await api(page, 'POST', '/accounts', { platform: 'wechat_mp', name: '桌面技能验收号', content_format: 'long_article' })
    const skill = (await api(page, 'POST', '/skills', {
      scope: 'personal', name: '桌面本人写法', summary: '验证桌面同一注入', triggers: '标题时', instructions: '标题保持平实，不编造输入以外的事实。',
      task_enabled: true, agent_enabled: true, task_types: ['title'], platforms: [], content_formats: [], status: 'active',
    })).skill
    const bindings = await api(page, 'GET', `/accounts/${account.id}/skill-bindings`)
    await api(page, 'PUT', `/accounts/${account.id}/skill-bindings/personal/${skill.id}`, { enabled: true, base_revision: bindings.mine.base_revision })
    const work = await api(page, 'POST', `/accounts/${account.id}/works`, { title: '真实桌面技能生成验收' })
    await page.goto(`${baseURL}/works/${work.id}`)
    await expect(page.locator('html')).toHaveAttribute('data-presentation', 'ops-creative-desktop')
    await expect(page.locator('#step-title')).toBeVisible()
    const generated = page.waitForResponse(r => r.url().endsWith(`/works/${work.id}/titles`) && r.request().method() === 'POST')
    await page.locator('.desktop-work-more').getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('menuitem', { name: '生成标题候选', exact: true }).click()
    const response = await generated
    expect(response.status()).toBe(200)
    const result = await response.json()
    expect(result.refs.skills.personal_used_count).toBe(1)
    expect(JSON.stringify(result.refs)).not.toContain(skill.id)
    expect(JSON.stringify(result.refs)).not.toContain(skill.name)
    const receipt = await api(page, 'GET', `/ai-calls/${result.ai_call_id}/skill-context`)
    expect(receipt.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: skill.id, scope: 'personal', used: true })]))
    expect(receipt.assembled_chars).toBeGreaterThan(0)
    await page.goto(`${baseURL}/settings/skills`)
    await expect(page.getByRole('link', { name: '在浏览器中管理技能', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '新建技能', exact: true })).toHaveCount(0)
  } finally {
    if (app) {
      try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 只结束本测试进程。 */ }
      await Promise.race([app.close().catch(() => undefined), new Promise(done => setTimeout(done, 2000))])
    }
    expect(resolve(profile).startsWith(resolve(prefix))).toBe(true)
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
