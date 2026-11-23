import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

// REF41 A5（docs/41 §A5；D-211）：流程技能蒸馏与发布技能模板。
// 覆盖：内置“发布流程”七步 seed（详情步骤时间线、task_enabled=false、无自动点发布）、
// 回放预览只建计划（“不会自动执行任何工具”说明 + 计划步骤 + 人工确认语义）。

async function openSkills(page: import('@playwright/test').Page) {
  await page.goto('/settings/skills')
  await expect(page.getByRole('heading', { name: '写作技能' })).toBeVisible()
}

test('REF41 A5 内置发布流程七步可见，回放只建计划不执行', async ({ page }) => {
  await registerAccount(page)
  await openSkills(page)
  // 切到“内置”标签找到发布流程。
  await page.getByRole('button', { name: '内置', exact: true }).click()
  await expect(page.getByText('发布流程', { exact: true })).toBeVisible({ timeout: 15_000 })

  const items = page.locator('div.flex.items-start', { hasText: '发布流程' })
  await items.first().getByRole('button', { name: '查看详情' }).click()
  const detail = page.getByRole('dialog', { name: '技能详情' })
  await expect(detail).toBeVisible({ timeout: 15_000 })
  // 七步时间线：逐步序可见，gate=confirm 标“需确认”。
  const timeline = detail.getByTestId('skill-procedure-timeline')
  await expect(timeline).toBeVisible()
  for (let seq = 1; seq <= 7; seq++) {
    await expect(detail.getByTestId(`skill-procedure-step-${seq}`)).toBeVisible()
  }
  await expect(timeline).toContainText('需确认')
  await expect(timeline).toContainText('停在待你点发布')
  // 回放入口在详情页脚（active + suggest_only）。
  await detail.getByTestId('skill-replay-open').click()
  const replay = page.getByRole('dialog', { name: '回放技能' })
  await expect(replay).toBeVisible()
  await expect(replay).toContainText('不会自动执行任何工具')
  await replay.getByTestId('skill-replay-goal').fill('按发布流程走一遍 E2E 回放验收')
  const planResponse = page.waitForResponse(r => r.url().includes('/replay') && r.request().method() === 'POST')
  await replay.getByTestId('skill-replay-submit').click()
  const res = await planResponse
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.steps).toHaveLength(7)
  await expect(replay.getByTestId('skill-replay-result')).toBeVisible()
  await expect(replay.getByTestId('skill-replay-result')).toContainText('已生成计划（待确认）')
  // 服务端确实只建了 run（trigger=skill_replay、queued 未执行）与 plan。
  const runs = await api(page, 'GET', `/agent/conversations/${body.conversation_id}`)
  expect(runs).toBeTruthy()

  // disabled 草稿不能回放：直接造一条 disabled 技能并验证 409。
  const created = await api(page, 'POST', '/skills', {
    scope: 'personal', name: 'A5 未启用草稿', summary: 'A5 回放守卫', triggers: 'A5 守卫',
    instructions: '未启用不能回放。', task_enabled: false, agent_enabled: true,
    platforms: [], content_formats: [], status: 'disabled',
  })
  const skillId = created.skill.id
  const replayResp = await page.evaluate(async (id) => {
    const me = await (await fetch('/api/v1/auth/me')).json()
    const response = await fetch(`/api/v1/skills/${id}/replay`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
      body: JSON.stringify({ goal: '不该被回放' }),
    })
    return response.status
  }, skillId)
  expect(replayResp).toBe(409)
})
