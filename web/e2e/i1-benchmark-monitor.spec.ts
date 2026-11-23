import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

// REF41 I1：竞对订阅、观测与趋势（Web）。开启监控 → 真实 DB 夹具落两条成功观测和
// 一条失败观测 → 趋势图两点连线、覆盖提示消失、失败点显示“不计入 0”且不连线。
// 夹具只补观测数据；读取仍走真实服务端 API，调度/seq/失败边界由 Go TestI1 覆盖。

const apiBase = process.env.OPS_E2E_API ?? 'http://127.0.0.1:8180'

test('REF41 I1 双端（Web）竞对监控：趋势两点、覆盖不足提示、failed 不计入 0', async ({ page }) => {
  test.skip(process.env.OPS_E2E_PROD === '1', '该场景使用本地 E2E DB 夹具')
  test.setTimeout(300_000)
  const account = await registerAccount(page, '图文笔记', 'xhs', `i1-web-${Date.now()}`)
  await page.goto(`/a/${account.id}/profile?tab=benchmarks`)
  const panel = page.getByTestId('benchmark-tab')
  await expect(panel).toBeVisible()

  // 登记 + 开启监控（间隔 24h 合法）。
  await panel.getByLabel('名称（1..100 码点）').fill('I1 监控对标')
  await panel.getByLabel('主页 URL（可选）').fill('https://www.xiaohongshu.com/user/i1-monitor')
  await panel.getByRole('button', { name: '添加对标', exact: true }).click()
  const targets = await api(page, 'GET', `/accounts/${account.id}/benchmarks`) as { items: Array<{ id: string; name: string }> }
  const target = targets.items.find((i) => i.name === 'I1 监控对标')
  expect(target).toBeTruthy()

  const item = panel.getByTestId('benchmark-target-item').filter({ hasText: 'I1 监控对标' })
  await item.getByTestId(`benchmark-monitor-enable-${target!.id}`).click()
  await expect(item.getByTestId(`benchmark-monitor-${target!.id}`)).toContainText('开启')
  await expect(item.getByTestId(`benchmark-monitor-interval-${target!.id}`)).toHaveValue('24')

  const seed = async (points: unknown[]) => {
    const response = await page.request.post(`${apiBase}/__e2e/benchmark/seed`, {
      data: { target_id: target!.id, points },
    })
    expect(response.status(), await response.text()).toBe(200)
  }

  // 第一次观测：无 published_at → 日龄未知；覆盖不足提示必须出现。
  await seed([{ seq: 1, quality_state: 'ok', values: { likes: 10 } }])
  await page.reload()
  await expect(panel).toBeVisible()
  const reloaded = panel.getByTestId('benchmark-target-item').filter({ hasText: 'I1 监控对标' })
  await expect(reloaded.getByTestId(`benchmark-coverage-hint-${target!.id}`)).toContainText('覆盖不足：仅 1 次观测')
  await expect(reloaded.getByText('日龄未知')).toBeVisible()

  // 第二次成功 + 第三次失败 + 第四次 partial：覆盖提示消失，趋势两点连线；
  // failed/partial 都只做空心点、不落 0、不参与连线。
  await seed([
    { seq: 2, quality_state: 'ok', values: { likes: 14 }, published_at: new Date(Date.now() - 2 * 86_400_000).toISOString() },
    { seq: 3, quality_state: 'failed', values: { likes: 0 } },
    { seq: 4, quality_state: 'partial', values: { likes: 12 } },
  ])
  await page.reload()
  await expect(panel).toBeVisible()
  const finalItem = panel.getByTestId('benchmark-target-item').filter({ hasText: 'I1 监控对标' })
  await expect(finalItem.getByTestId(`benchmark-coverage-hint-${target!.id}`)).toHaveCount(0)
  await expect(finalItem.getByTestId(`benchmark-trend-${target!.id}`)).toContainText('第 1 次观测')
  await expect(finalItem.getByTestId(`benchmark-trend-${target!.id}`)).toContainText('第 2 次观测')
  await expect(finalItem.getByTestId(`benchmark-trend-${target!.id}`)).toContainText('第 3 次观测')
  await expect(finalItem.getByTestId(`benchmark-trend-${target!.id}`)).toContainText('第 4 次观测')
  await expect(finalItem.getByTestId(`benchmark-trend-${target!.id}`)).toContainText('采集失败（不计入 0）')
  await expect(finalItem.getByTestId(`benchmark-trend-${target!.id}`)).toContainText('部分字段缺失')
  await expect(finalItem.getByTestId(`benchmark-trend-chart-${target!.id}`)).toBeVisible()
  await expect(finalItem.getByTestId(`benchmark-trend-chart-${target!.id}`).locator('polyline')).toHaveCount(1)
  await expect(finalItem.getByTestId(`benchmark-trend-chart-${target!.id}`).locator('circle')).toHaveCount(4)
  await finalItem.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '../.playwright-results/web/i1-web-benchmark-monitor.png' })

  // 500 异常门：趋势接口失败必须显式报错并可重试，不能伪装成“尚无观测数据”。
  await page.route('**/api/v1/benchmark/targets/*/trend', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"code":"internal","message":"模拟趋势失败"}}' }))
  await page.reload()
  await expect(panel).toBeVisible()
  const errorItem = panel.getByTestId('benchmark-target-item').filter({ hasText: 'I1 监控对标' })
  await expect(errorItem.getByTestId(`benchmark-trend-error-${target!.id}`)).toContainText('趋势加载失败')
  await expect(errorItem.getByTestId(`benchmark-trend-error-${target!.id}`).getByRole('button', { name: '重试' })).toBeVisible()
  await page.unroute('**/api/v1/benchmark/targets/*/trend')
  await errorItem.getByRole('button', { name: '重试' }).click()
  await expect(errorItem.getByTestId(`benchmark-trend-chart-${target!.id}`)).toBeVisible()
})
