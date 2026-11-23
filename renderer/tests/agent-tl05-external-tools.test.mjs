import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// TL-05（docs/38 §14）：能力中心外部工具只读投影与插件入口的源码守卫。
// 行为/数据由 Go 投影测试与真实 Electron E2E 覆盖；这里锁住 UI 不得回退成
// “未开放”、不得把命令/路径/入参字段放进页面、不得漏掉来源/权限/最近调用。
const read = (path) => readFileSync(resolve(process.cwd(), path), 'utf8')

test('TL-05：能力中心单列外部工具，展示来源/权限/最近调用且不渲染 path/params', () => {
  const capability = read('pages/agent/CapabilityList.tsx')
  assert.match(capability, /external_tools/)
  assert.match(capability, /agent-external-tools/)
  assert.match(capability, /外部工具/)
  assert.match(capability, /来源：/)
  assert.match(capability, /权限：/)
  assert.match(capability, /最近调用：/)
  assert.match(capability, /尚无调用记录/)
  assert.match(capability, /schema 校验的白名单工具/)
  // 能力中心仍然只读：不展示内部路径、方法或参数定义。
  assert.doesNotMatch(capability, /tool\.path|tool\.method|tool\.params/)
  assert.doesNotMatch(capability, /args_json|result_json|command|env_keys/)
})

test('TL-05：plugin_mcp 开启时添加菜单入口可用并进入插件管理，关闭时如实禁用', () => {
  const addMenu = read('pages/agent/AddMenu.tsx')
  assert.match(addMenu, /pluginsEnabled/)
  assert.match(addMenu, /id: 'plugins'/)
  assert.match(addMenu, /pluginsEnabled \? '外部 MCP 连接与工具' : '未开放'/)
  assert.match(addMenu, /disabled: !pluginsEnabled/)
  const agent = read('pages/Agent.tsx')
  assert.match(agent, /pluginsEnabled=\{bootstrapData\.features\.plugin_mcp === true\}/)
  assert.match(agent, /action === 'plugins'\) navigate\('\/settings\/plugins'\)/)
})
