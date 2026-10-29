import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { _electron, expect, test, type Page } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'

type IntentResult = {
  kind: 'platform-account-sync' | 'platform-metrics-refresh' | 'platform-sync-resume'
  requestId: string
  accountId: string
  status: 'queued' | 'existing' | 'no_targets' | 'failed'
  operationId?: string
  message?: string
}

type PlatformOperation = {
  id: string
  kind: string
  status: string
  revision: number
  frozen_scope?: { target_scope?: string; target_count?: number }
}

type Fixture = {
  accountId: string
  deviceId: string
  connectionId: string
  connectionRevision: number
  externalAccountKey: string
  mirrorId: string
}

const origin = process.env.OPS_E2E_PLATFORM_URL ?? 'http://127.0.0.1:5178'
const apiOrigin = process.env.OPS_E2E_PLATFORM_API ?? 'http://127.0.0.1:8182'
const explicitlyConfigured = Boolean(process.env.OPS_E2E_PLATFORM_URL && process.env.OPS_E2E_PLATFORM_API)
test.use({ baseURL: origin })

test.describe('Platform intents through isolated real Electron', () => {
  test.skip(!explicitlyConfigured, 'requires isolated platform E2E server and Vite; see OPS_E2E_PLATFORM_URL/API')

  test('sync, account metrics, single-work metrics, and resume reach the local operation API', async ({ request }) => {
    test.setTimeout(180_000)
    const profileRoot = resolve(tmpdir())
    const userDataDir = await mkdtemp(join(profileRoot, 'ops-platform-intent-e2e-'))
    expect(resolve(userDataDir).startsWith(join(profileRoot, 'ops-platform-intent-e2e-'))).toBe(true)

    let electron: ElectronApplication | undefined
    try {
      const repoRoot = resolve(process.cwd(), '../..')
      const electronExecutable = resolve(repoRoot, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe')
      const mainEntry = resolve(repoRoot, 'desktop', '.build', 'main.js')
      const electronEnv = {
        ...process.env,
        OPS_DESKTOP_DEV_URL: origin,
        OPS_API_TARGET: apiOrigin,
        OPS_E2E_PLATFORM_ENABLED: '1',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      }
      delete electronEnv.ELECTRON_RUN_AS_NODE
      electron = await _electron.launch({
        executablePath: electronExecutable,
        args: [`--user-data-dir=${userDataDir}`, mainEntry],
        env: electronEnv,
      })
      const page = await electron.firstWindow()
      page.setDefaultTimeout(10_000)
      page.on('dialog', async (dialog) => {
        if (dialog.type() === 'beforeunload') await dialog.accept()
        else await dialog.dismiss()
      })
      page.on('console', (message) => console.log(`[electron console:${message.type()}] ${message.text()}`))
      page.on('pageerror', (error) => console.log(`[electron pageerror] ${error.message}`))
      console.log(`[real-electron] first window: ${page.url()}`)
      const registerResponse = await page.goto(`${origin}/register`, { waitUntil: 'domcontentloaded', timeout: 15_000 })
      console.log(`[real-electron] register navigation: ${registerResponse?.status()} ${page.url()}`)
      await expect(page.getByRole('heading', { name: '注册' })).toBeVisible({ timeout: 10_000 })

      const username = `platform-e2e-${Date.now()}-${randomUUID().slice(0, 8)}`
      const usernameInput = page.getByLabel('用户名', { exact: true })
      await usernameInput.fill(username, { timeout: 10_000 })
      await expect(usernameInput).toHaveValue(username, { timeout: 5_000 })
      const passwordInput = page.getByLabel('密码（至少 12 位）', { exact: true })
      await passwordInput.fill('local-e2e-password-123', { timeout: 10_000 })
      await expect(passwordInput).toHaveValue('local-e2e-password-123', { timeout: 5_000 })
      const createAccountButton = page.getByRole('button', { name: '创建账号', exact: true })
      await expect(createAccountButton).toBeEnabled({ timeout: 5_000 })
      console.log(`[real-electron] submitting account ${username}`)
      await createAccountButton.click({ timeout: 10_000 })

      await expect.poll(() => page.evaluate(async () => (await fetch('/api/v1/auth/me')).status), { timeout: 20_000 }).toBe(200)
      console.log('[real-electron] account registration completed')
      const account = await page.evaluate(async () => {
        const me = await (await fetch('/api/v1/auth/me')).json() as { csrf_token: string }
        const response = await fetch('/api/v1/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
          body: JSON.stringify({ platform: 'xhs', name: '隔离 Electron 验收号', content_format: 'image_note', type_note: '' }),
        })
        if (!response.ok) throw new Error(`创建隔离验收账号失败：${response.status}`)
        return response.json() as Promise<{ id: string }>
      })
      await page.goto(`${origin}/a/${account.id}`)
      await expect(page.getByTestId('desktop-dashboard')).toBeVisible()

      const authState = await page.evaluate(async (password) => {
        const meResponse = await fetch('/api/v1/auth/me', { credentials: 'include' })
        const me = await meResponse.json() as { csrf_token: string; user_id?: string; username: string; workspace: { id: string } }
        const reauth = await fetch('/api/v1/auth/reauth', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
          body: JSON.stringify({ password }),
        })
        return { ok: reauth.ok, body: await reauth.json(), me }
      }, 'local-e2e-password-123')
      expect(authState.ok, JSON.stringify(authState.body)).toBe(true)
      const preferenceKey = `ops.currentAccount.v2:${authState.me.user_id ?? authState.me.username}:${authState.me.workspace.id}`
      await page.evaluate(({ key, accountId }) => localStorage.setItem(key, accountId), { key: preferenceKey, accountId: account.id })

      const bridgeReady = await expect.poll(() => page.evaluate(() => typeof (window as unknown as { opsDesktopUI?: { onPlatformIntentResult?: unknown } }).opsDesktopUI?.onPlatformIntentResult === 'function'), { timeout: 10_000 }).toBe(true)
      void bridgeReady

      let fixtureResponse: Awaited<ReturnType<typeof request.post>> | null = null
      const initialSeed = await request.post(`${apiOrigin}/__e2e/platform/seed`, { data: { accountId: account.id } })
      if (initialSeed.status() === 201) {
        fixtureResponse = initialSeed
      } else {
        const initialBody = await initialSeed.json().catch(() => ({})) as { error?: string }
        expect(initialSeed.status(), JSON.stringify(initialBody)).toBe(409)
        expect(initialBody.error).toBe('real Electron device has not been registered')

        const bootstrapRequestId = randomUUID()
        const bootstrapResult = await page.evaluate(({ accountId, requestId }) => new Promise<IntentResult>((resolve, reject) => {
          const bridge = (window as unknown as { opsDesktopUI?: { onPlatformIntentResult: (listener: (result: IntentResult) => void) => () => void } }).opsDesktopUI
          if (!bridge) return reject(new Error('business preload result bridge is unavailable'))
          let unsubscribe: (() => void) | undefined
          const timeout = window.setTimeout(() => {
            unsubscribe?.()
            reject(new Error('device bootstrap intent timed out'))
          }, 25_000)
          unsubscribe = bridge.onPlatformIntentResult((result) => {
            if (result.kind !== 'platform-account-sync' || result.accountId !== accountId || result.requestId !== requestId) return
            window.clearTimeout(timeout)
            unsubscribe?.()
            resolve(result)
          })
          window.open(`ops-desktop://ui/platform-account-sync/${accountId}/incremental/1/${requestId}`, '_blank', 'noopener,noreferrer')
        }), { accountId: account.id, requestId: bootstrapRequestId })
        expect(bootstrapResult.status).toBe('failed')
        expect(bootstrapResult.requestId).toBe(bootstrapRequestId)
      }
      if (!fixtureResponse) {
        await expect.poll(async () => {
          const response = await request.post(`${apiOrigin}/__e2e/platform/seed`, { data: { accountId: account.id } })
          if (response.status() === 201) {
            fixtureResponse = response
            return 201
          }
          const body = await response.json().catch(() => ({})) as { error?: string }
          if (response.status() === 409 && body.error === 'real Electron device has not been registered') return 409
          throw new Error(`fixture seed failed (${response.status()}): ${JSON.stringify(body)}`)
        }, { timeout: 45_000, intervals: [500, 1_000, 2_000] }).toBe(201)
      }
      const fixture = await fixtureResponse!.json() as Fixture
      expect(fixture.accountId).toBe(account.id)
      expect(fixture.mirrorId).toMatch(/^[0-9a-f-]{36}$/i)

      await page.goto(`${origin}/settings/accounts?id=${account.id}`)
      await expect(page.getByRole('button', { name: '同步平台账号', exact: true })).toBeEnabled({ timeout: 20_000 })
      await expect(page.getByRole('button', { name: '刷新作品指标', exact: true })).toBeEnabled()

      await page.getByRole('button', { name: '同步平台账号', exact: true }).click()
      await expect(page.getByText('已建立平台账号同步操作', { exact: true })).toBeVisible({ timeout: 20_000 })
      const syncOperation = await waitForOperation(page, account.id, (operation) => operation.kind === 'account_sync')
      expect(['queued', 'running', 'waiting_login', 'waiting_device', 'waiting_budget']).toContain(syncOperation.status)

      await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeEnabled({ timeout: 10_000 })
      await page.getByRole('button', { name: '暂停', exact: true }).click()
      await expect(page.getByText('同步已暂停', { exact: true })).toBeVisible({ timeout: 10_000 })
      await expect.poll(async () => (await findOperation(page, account.id, syncOperation.id))?.status).toBe('paused')
      const pausedRevision = (await findOperation(page, account.id, syncOperation.id))!.revision

      await expect(page.getByRole('button', { name: '继续同步', exact: true }).first()).toBeEnabled({ timeout: 10_000 })
      await page.getByRole('button', { name: '继续同步', exact: true }).first().click()
      await expect(page.getByText('同步已继续', { exact: true })).toBeVisible({ timeout: 20_000 })
      await expect.poll(async () => {
        const operation = await findOperation(page, account.id, syncOperation.id)
        return operation && operation.status === 'queued' && operation.revision > pausedRevision
      }).toBe(true)

      await expect(page.getByRole('button', { name: '取消', exact: true })).toBeEnabled({ timeout: 10_000 })
      await page.getByRole('button', { name: '取消', exact: true }).click()
      await expect(page.getByText('同步已取消', { exact: true })).toBeVisible({ timeout: 10_000 })
      await expect.poll(async () => (await findOperation(page, account.id, syncOperation.id))?.status).toBe('canceled')

      await page.getByRole('button', { name: '刷新作品指标', exact: true }).click()
      await expect(page.getByText('已建立作品指标刷新操作', { exact: true })).toBeVisible({ timeout: 20_000 })
      const accountMetrics = await waitForOperation(page, account.id, (operation) => operation.kind === 'metrics_refresh' && operation.frozen_scope?.target_scope === 'due_and_recent')
      expect(accountMetrics.frozen_scope?.target_count).toBeGreaterThan(0)
      await page.getByRole('button', { name: '取消', exact: true }).click()
      await expect.poll(async () => (await findOperation(page, account.id, accountMetrics.id))?.status).toBe('canceled')

      await page.goto(`${origin}/a/${account.id}/works`)
      await page.getByRole('tab', { name: '平台作品', exact: true }).click()
      await page.getByRole('button', { name: /本地 E2E 作品/ }).click()
      await page.getByRole('button', { name: '刷新此篇指标', exact: true }).click()
      await expect(page.getByText('已建立这篇作品的指标刷新操作', { exact: true })).toBeVisible({ timeout: 20_000 })
      const singleMetrics = await waitForOperation(page, account.id, (operation) => operation.kind === 'metrics_refresh' && operation.frozen_scope?.target_scope === 'explicit')
      expect(singleMetrics.frozen_scope?.target_count).toBe(1)

      await page.goto(`${origin}/settings/accounts?id=${account.id}`)
      await expect(page.getByRole('button', { name: '取消', exact: true })).toBeEnabled({ timeout: 10_000 })
      await page.getByRole('button', { name: '取消', exact: true }).click()
      await expect.poll(async () => (await findOperation(page, account.id, singleMetrics.id))?.status).toBe('canceled')
    } finally {
      // 此用例只验平台操作；隔离应用的退出确认由专门的 quit E2E 覆盖。
      await electron?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
      await electron?.close()
      if (basename(userDataDir).startsWith('ops-platform-intent-e2e-')) {
        await rm(userDataDir, { recursive: true, force: true })
      }
    }
  })
})

async function listOperations(page: Page, accountId: string): Promise<PlatformOperation[]> {
  return await page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/accounts/${id}/platform-sync-operations?limit=20`, { credentials: 'include' })
    const raw = await response.json() as { data?: { items?: PlatformOperation[]; operations?: PlatformOperation[] }; items?: PlatformOperation[]; operations?: PlatformOperation[] }
    if (!response.ok) throw new Error(`operations list failed (${response.status})`)
    return raw.data?.items ?? raw.items ?? raw.data?.operations ?? raw.operations ?? []
  }, accountId)
}

async function findOperation(page: Page, accountId: string, operationId: string): Promise<PlatformOperation | undefined> {
  return (await listOperations(page, accountId)).find((operation) => operation.id === operationId)
}

async function waitForOperation(page: Page, accountId: string, predicate: (operation: PlatformOperation) => boolean): Promise<PlatformOperation> {
  let found: PlatformOperation | undefined
  await expect.poll(async () => {
    found = (await listOperations(page, accountId)).find(predicate)
    return Boolean(found)
  }, { timeout: 20_000 }).toBe(true)
  return found!
}
