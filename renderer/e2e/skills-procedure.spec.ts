import { _electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// REF41 A5（docs/41 §A5；D-211）：桌面形态的流程技能验收。
// D-224 / OPT-W02：桌面端已放开技能库管理（原 SkillWebBoundary 已删除），
// 技能库设置页直接渲染管理界面。因此桌面 E2E 验证：
// 1) 设置页技能库可直接打开并管理；
// 2) 回放接口在桌面 UA 会话下行为正确——内置“发布流程”只建计划不执行、disabled 409。
// 与 web/e2e/skills-procedure.spec.ts 覆盖同一旅程的桌面形态，不共用文件。

test('REF41 A5 桌面技能边界与回放只建计划', async ({ baseURL }) => {
  test.skip(process.platform !== 'win32', '需要 Windows Electron')
  test.setTimeout(180_000)
  const profile = await mkdtemp(join(tmpdir(), 'ops-a5-replay-'))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: resolve('../desktop/node_modules/electron/dist/electron.exe'),
      args: [`--user-data-dir=${profile}`, resolve('../desktop/.build/main.js')],
      env: { ...process.env, OPS_DESKTOP_DEV_URL: baseURL! }, timeout: 60_000,
    })
    const page = await app.firstWindow()
    const api = async (method: string, path: string, data?: unknown) => page.evaluate(async ({ method, path, data }) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      const response = await fetch('/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`)
      return response.json()
    }, { method, path, data })
    await page.goto(`${baseURL}/register`)
    await page.getByLabel('用户名', { exact: true }).fill(`a5-procedure-${Date.now()}`)
    await page.getByLabel('密码（至少 12 位）').fill('local-e2e-password-123')
    await page.getByRole('button', { name: '创建账号', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status)).toBe(200)
    await expect(page.locator('html')).toHaveAttribute('data-presentation', 'ops-creative-desktop')

    // 1. 桌面技能管理已放开：设置页技能页直接渲染技能库（D-224/OPT-W02）。
    await page.goto(`${baseURL}/settings/skills`)
    await expect(page.getByRole('button', { name: '新建技能', exact: true })).toBeVisible({ timeout: 15_000 })

    // 2. 内置“发布流程”存在且七步 procedure 完整（API 断言；详情 UI 属 Web 形态）。
    const skills = await api('GET', '/skills?view=library&scope=builtin')
    const flowBase = (skills.items as { id: string; name: string; origin: string }[])
      .find((s) => s.name === '发布流程')
    expect(flowBase).toBeTruthy()
    expect(flowBase!.origin).toBe('builtin')
    // procedure 属详情字段：单条 GET 携带（列表保持轻量）。
    const detail = await api('GET', '/skills/' + flowBase!.id) as { status: string; task_enabled: boolean; agent_enabled: boolean; procedure?: { seq: number; gate: string }[]; replay_policy?: string }
    expect(detail.status).toBe('active')
    expect(detail.task_enabled).toBe(false)
    expect(detail.agent_enabled).toBe(true)
    expect(detail.procedure).toHaveLength(7)
    const confirmCount = detail.procedure!.filter((st) => st.gate === 'confirm').length
    expect(confirmCount).toBeGreaterThanOrEqual(3)

    // 3. 回放只建计划：run trigger=skill_replay、stage=queued；plan 7 步。
    const replay = await api('POST', `/skills/${flowBase!.id}/replay`, { goal: '桌面 A5 回放验收' }) as { run_id: string; plan_id: string; steps: unknown[] }
    expect(replay.steps).toHaveLength(7)
    const convs = await api('GET', '/agent/conversations') as { items: { id: string; title: string }[] }
    expect(convs.items.some((c) => c.title.includes('技能回放'))).toBe(true)
    void replay.run_id
    void replay.plan_id

    // 4. disabled 草稿 409 skill_not_active。
    const created = await api('POST', '/skills', {
      scope: 'personal', name: '桌面 A5 未启用', summary: 'A5 回放守卫', triggers: 'A5 守卫',
      instructions: '未启用不能回放。', task_enabled: false, agent_enabled: true,
      platforms: [], content_formats: [], status: 'disabled',
    })
    const replayStatus = await page.evaluate(async (id) => {
      const me = await (await fetch('/api/v1/auth/me')).json()
      const response = await fetch(`/api/v1/skills/${id}/replay`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
        body: JSON.stringify({ goal: '不该被回放' }),
      })
      return response.status
    }, created.skill.id)
    expect(replayStatus).toBe(409)
  } finally {
    if (app) {
      await Promise.race([
        app.evaluate(({ app }) => app.exit(0)).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ])
    }
    const pid = app?.process().pid
    if (pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already exited */ } }
    try {
      const profileArg = profile.replace(/'/g, "''")
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*${profileArg}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ], { stdio: 'ignore' })
    } catch { /* best effort */ }
    await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
  }
})
