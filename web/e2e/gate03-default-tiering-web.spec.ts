import { expect, test } from '@playwright/test'
import { execFileSync, spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// CF-GATE-03（90 D-187 P6）：「默认部署可达性」断言——不设 OPS_AGENT_WORKBENCH_FEATURES
// 时，A 档 11 项默认开、B 档 5 项与 C 档 3 项默认关。主 E2E 服务的 env 是 config 里
// 显式写死的长清单（既有 154 例依赖它，不动），所以这里由用例自拉一个空 env 的 ops-e2e
// 实例（独立端口 8183/8193），直接对它注册账号并读 /agent/bootstrap。
// 断言名单与 server/internal/app/agent_workbench.go 的 agentFeatureDefaultOn 同步维护。

const tierAOn = [
  'workbench_ui', 'conversation_organize', 'context_refs', 'skill_requests', 'artifacts',
  'run_control', 'event_resume', 'plans', 'goals', 'routines', 'document_parse',
]
const tierOff = [
  'chrome_connect', 'browser_workspace', 'personal_memories', 'plugin_mcp', 'subagents',
  'voice_dictation', 'voice_realtime', 'computer_use',
]

const defaultAPI = 'http://127.0.0.1:8183'
const binary = join(tmpdir(), `ops-e2e-gate03-${process.platform}.exe`)

test('CF-GATE-03 P6：空 env 时工作台特性按 D-187 档位默认可达（A11 开 / B·C 8 关）', async ({ browser }) => {
  // go run 在 Windows 下是双进程树（go.exe + 编译产物），kill 不净；预编译成单二进制再 spawn。
  test.setTimeout(300_000)
  execFileSync('go', ['build', '-o', binary, './cmd/ops-e2e'], { cwd: resolve('../server'), stdio: 'pipe' })
  const proc = spawn(binary, [], {
    env: {
      ...(process.env.NO_PROXY ? { NO_PROXY: process.env.NO_PROXY } : {}),
      ...(process.env.no_proxy ? { no_proxy: process.env.no_proxy } : {}),
      OPS_E2E_LISTEN: '127.0.0.1:8183',
      OPS_E2E_MOCK_LISTEN: '127.0.0.1:8193',
      // 故意不设 OPS_AGENT_WORKBENCH_FEATURES：本用例验证的就是默认档位。
    },
    stdio: 'ignore',
  })
  try {
    expect(proc.pid, '空 env ops-e2e 进程应已启动').toBeTruthy()
    const context = await browser.newContext()
    try {
      let healthy = false
      for (let i = 0; i < 150 && !healthy; i++) {
        if (proc.exitCode !== null) break
        await new Promise((done) => setTimeout(done, 1000))
        try {
          const res = await context.request.get(`${defaultAPI}/healthz`, { timeout: 2000 })
          healthy = res.ok()
        } catch { /* 迁移/启动中，继续等 */ }
      }
      expect(healthy, '空 env ops-e2e 实例应在预算内通过 /healthz').toBeTruthy()

      const registered = await context.request.post(`${defaultAPI}/api/v1/auth/register`, {
        data: { username: `gate03-${Date.now()}`, password: 'local-e2e-password-123' },
      })
      expect(registered.ok(), await registered.text()).toBeTruthy()

      const me = await (await context.request.get(`${defaultAPI}/api/v1/auth/me`)).json()
      const bootstrap = await (await context.request.fetch(`${defaultAPI}/api/v1/agent/bootstrap`, {
        headers: { 'X-CSRF-Token': me.csrf_token },
      })).json()

      for (const name of tierAOn) {
        expect(bootstrap.features[name], `A 档 ${name} 应默认开`).toBe(true)
      }
      for (const name of tierOff) {
        expect(bootstrap.features[name], `非 A 档 ${name} 应默认关`).toBe(false)
      }
      expect(Object.keys(bootstrap.features).length).toBe(19)
    } finally {
      await context.close()
    }
  } finally {
    proc.kill('SIGTERM')
    try { rmSync(binary, { force: true }) } catch { /* 清理失败不影响结论 */ }
  }
})
