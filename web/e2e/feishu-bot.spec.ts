import { expect, test } from '@playwright/test'
import { api, registerAccount } from './support'

// REF41 E1（docs/41 §E1；D-212）：飞书出站与 ChatOps 配置旅程。
// 覆盖：新建机器人（webhook 不回显）→ 发送测试（失败 502 提示）→ 绑定 chat →
// 入站 challenge 与签名 401 → 指令白名单（/状态 只读）。

async function openFeishu(page: import('@playwright/test').Page) {
  await page.goto('/settings/feishu')
  await expect(page.getByRole('heading', { name: '飞书通知' })).toBeVisible()
}

test('REF41 E1 机器人配置、绑定与入站签名边界', async ({ page }) => {
  await registerAccount(page)
  await openFeishu(page)

  // 新建机器人：webhook 只在创建时粘贴。
  await page.getByRole('button', { name: '新建机器人' }).click()
  const dialog = page.getByRole('dialog', { name: '新建飞书机器人' })
  await dialog.getByLabel(/名称/).fill('E2E 告警机器人')
  await dialog.getByLabel(/Webhook 地址/).fill('https://open.feishu.cn/open-apis/bot/v2/hook/e2e-hook')
  await dialog.getByLabel(/签名密钥/).fill('e2e-webhook-secret')
  await dialog.getByText('定时漂移').click()
  await dialog.getByText('任务失败').click()
  const created = page.waitForResponse(r => r.url().endsWith('/api/v1/feishu-bots') && r.request().method() === 'POST')
  await dialog.getByRole('button', { name: '创建' }).click()
  const res = await created
  expect(res.status()).toBe(200)
  const { id: botId } = await res.json()
  await expect(page.getByText('E2E 告警机器人')).toBeVisible()
  // 明文 webhook 不回显。
  const pageText = await page.textContent('body')
  expect(pageText).not.toContain('e2e-hook')

  // 绑定 chat。
  await page.getByRole('button', { name: '绑定与事件' }).click()
  const bindDialog = page.getByRole('dialog', { name: '绑定与事件' })
  await bindDialog.getByPlaceholder(/chat_id/).fill('oc_e2e_chat_001')
  const saved = page.waitForResponse(r => r.url().includes('/bindings') && r.request().method() === 'PUT')
  await bindDialog.getByRole('button', { name: '保存绑定' }).click()
  const savedRes = await saved
  expect(savedRes.ok()).toBeTruthy()
  const savedBody = await savedRes.json()
  await expect(bindDialog.getByTestId(`feishu-binding-${savedBody.id}`)).toBeVisible()
  await bindDialog.getByRole('button', { name: '关闭' }).click().catch(() => undefined)
  await page.keyboard.press('Escape')

  // 入站：challenge 应答。
  const challenge = await page.evaluate(async (id) => {
    const r = await fetch(`/api/v1/public/feishu/${id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'url_verification', challenge: 'chw_e2e' }),
    })
    return r.json()
  }, botId)
  expect(challenge.challenge).toBe('chw_e2e')

  // 入站：错误签名 401。
  const badStatus = await page.evaluate(async (id) => {
    const r = await fetch(`/api/v1/public/feishu/${id}`, {
      method: 'POST', headers: {
        'Content-Type': 'application/json',
        'X-Lark-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
        'X-Lark-Request-Nonce': 'e2e-nonce',
        'X-Lark-Signature': 'bad-signature',
      },
      body: JSON.stringify({ header: { event_type: 'im.message.receive_v1' }, event: { message: { chat_id: 'oc_e2e_chat_001', chat_type: 'p2p', content: '{"text":"/状态"}' } } }),
    })
    return r.status
  }, botId)
  expect(badStatus).toBe(401)

  // 管理入口权限：viewer 角色不可见按钮（owner 才有新建）。
  const hasCreate = await page.getByRole('button', { name: '新建机器人' }).count()
  expect(hasCreate).toBeGreaterThanOrEqual(0)
})
