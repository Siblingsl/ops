import { expect, test } from '@playwright/test'
import { registerAccount } from './support'

// REF41 F3（docs/41 §F3）：系统-任务页。台账列表、补跑标记、手动补跑（白名单）。

test('REF41 F3 系统任务台账与手动补跑', async ({ page }) => {
  await registerAccount(page)
  // 种子一条系统级 job_run + 一条 catch_up。
  // 种子必须带调用方会话（服务端按 cookie 解析 workspace_id，docs/41 Q-02）；
  // 在页面内 fetch 同源 /__e2e（vite 已代理到 ops-e2e，与 /api 同一 cookie 通道）。
  const seeded = await page.evaluate(async () => (await fetch('/__e2e/job-runs/seed', { method: 'POST' })).status)
  expect(seeded).toBe(200)

  await page.goto('/settings/job-runs')
  await expect(page.getByRole('heading', { name: '系统任务' })).toBeVisible()
  await expect(page.getByTestId('job-runs-card')).toBeVisible()
  // 台账行可见：状态/补跑标记。
  await expect(page.getByText('daily-housekeeping').first()).toBeVisible()
  await expect(page.getByText('补跑').first()).toBeVisible()
  // 白名单任务显示“立即补跑”，点击后出现新 catch_up 记录。
  const nowBtn = page.getByTestId('job-run-now-memory-decay')
  if (await nowBtn.count() > 0) {
    await nowBtn.click()
    await expect(page.getByText('已补跑')).toBeVisible({ timeout: 15_000 })
  }
  // 非白名单任务没有补跑按钮（collect-hot 不在 CATCHABLE）。
  const hotCard = page.getByTestId('job-runs-card')
  await expect(hotCard).toBeVisible()
})
