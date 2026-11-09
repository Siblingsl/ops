// DEV-AI27 验收守卫：桌面端超管「智能体工作台特性」开关必须与服务端登记的全量名单一致。
// 与 web/tests/admin-feature-labels.test.mjs 各自独立校验本端，符合双端独立实现原则。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

function serverFeatureNames() {
  const src = read('../../../server/internal/app/agent_workbench.go')
  const block = src.match(/var agentWorkbenchFeatureNames = \[\]string\{([\s\S]*?)\n\}/)
  assert.ok(block, '未找到 agentWorkbenchFeatureNames 声明（服务端名单格式变化，请同步本守卫）')
  return [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1])
}

function typeFeatureNames() {
  const src = read('../lib/types.ts')
  const start = src.indexOf('export type AgentWorkbenchFeatureName =')
  assert.ok(start >= 0, '未找到 AgentWorkbenchFeatureName 类型')
  const block = src.slice(start).split(/\n\nexport |\n\ntype |\n\ninterface /)[0]
  return [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
}

function adminLabelNames() {
  const src = read('../pages/settings/Admin.tsx')
  const start = src.indexOf('const AGENT_FEATURE_LABELS')
  assert.ok(start >= 0, '未找到 AGENT_FEATURE_LABELS')
  const block = src.slice(start).split(/\n\]/)[0]
  return [...block.matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1])
}

test('AI27: 桌面端类型覆盖服务端登记的全部工作台特性', () => {
  const server = serverFeatureNames()
  const types = typeFeatureNames()
  assert.ok(server.length >= 19, `服务端特性名单异常：${server.length}`)
  const missing = server.filter((n) => !types.includes(n))
  assert.deepEqual(missing, [], `前端类型缺少特性：${missing.join(', ')}`)
})

test('AI27: 桌面超管页面逐项列出全部工作台特性，无重复无越权名', () => {
  const server = serverFeatureNames()
  const labels = adminLabelNames()
  assert.equal(new Set(labels).size, labels.length, 'AGENT_FEATURE_LABELS 存在重复项')
  const missing = server.filter((n) => !labels.includes(n))
  assert.deepEqual(missing, [], `超管页面缺少开关：${missing.join(', ')}`)
  const unknown = labels.filter((n) => !server.includes(n))
  assert.deepEqual(unknown, [], `超管页面存在服务端不认识的开关：${unknown.join(', ')}`)
})

test('AI27: 特性开关保持逐项开启，不提供一键全开', () => {
  const src = read('../pages/settings/Admin.tsx')
  // 逐项提交的调用点在文件后段（渲染区），需对整份源码检查。
  assert.ok(!/enableAll|enable_all|toggleAll|setAllFeatures|bulkEnable/.test(src), '不得新增批量开启入口（D-117）')
  assert.match(src, /saveAgentFeature\(item\.name, v\)/, '每项开关应逐项提交 name/enabled')
})
