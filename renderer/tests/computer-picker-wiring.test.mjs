// DEV-CU P5-2（用户选定方案①）：选窗器接线的源码级守卫。
// 仓库没有 jsdom / testing-library，组件渲染无法在单测里跑；这里守住四件事不被回退：
// 1) 授权成功后必须调本机 observe（传 pid，不是拿 handle 去猜）；
// 2) 观察结果必须落状态机并展示 snapshot_id / revision / ref_count（有独立 testid）；
// 3) 失败/消费后必须有「重新观察」入口；
// 4) 上送服务端的只有选中窗口一条摘要，没有任何窗口全集。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../pages/agent/ComputerWindowPicker.tsx', import.meta.url)), 'utf8')

test('P5-2 选窗器：窗口项带 pid，授权后按 pid 调本机 observe', () => {
  assert.match(src, /type WindowItem = \{ pid: number;/, '窗口项类型必须含 pid')
  assert.match(src, /import \{[\s\S]*computerApi[\s\S]*\} from '@\/lib\/computer-api'/)
  assert.match(src, /computerApi\.local\.observe\(\{/, '必须走已封装的固定意图，不直连 IPC')
  assert.match(src, /pid: item\.pid/, 'observe 必传 pid')
  assert.match(src, /grant_id: granted\.grantId/, 'observe 必带 grant_id')
  assert.match(src, /generation: granted\.generation/, 'observe 必带 generation')
  assert.match(src, /target_summary: windowSummary\(item\)/)
  // handle 只用于授权，不得当成 pid 用
  assert.equal(/pid:\s*(?:item\.)?handle/.test(src), false, 'handle 不可逆，不能充当 pid')
})

test('P5-2 选窗器：观察结果落状态机并展示快照三元组', () => {
  assert.match(src, /applyComputerObserve/, '观察回包必须经状态机')
  assert.match(src, /beginComputerObserve/, '进入观察中必须经状态机')
  assert.match(src, /beginComputerAuthorize/)
  assert.match(src, /COMPUTER_WINDOW_OBSERVE_TESTID = 'computer-window-observe'/)
  assert.match(src, /snapshotId/, '必须展示 snapshot_id')
  assert.match(src, /observe\.revision/, '必须展示 revision')
  assert.match(src, /observe\.refCount/, '必须展示 ref_count')
  assert.match(src, /identityUnproven/, 'identity_unproven 必须可见')
  assert.match(src, /observe\.items\.map/, '可交互摘要必须渲染')
  // C09：不展示窗口标题全集/进程路径；摘要项只有 role/name/value/ref
  assert.equal(/process_path|hwnd|class_name/.test(src), false, '不得展示进程路径/句柄/类名')
})

test('P5-2 选窗器：失败与快照消费都有「重新观察」入口', () => {
  assert.match(src, /COMPUTER_WINDOW_REOBSERVE_TESTID/)
  assert.match(src, /observe\.phase === 'failed'/)
  assert.match(src, /observe\.phase === 'consumed'/)
  assert.match(src, /observe\.hint/, '失败必须展示中文提示')
  assert.match(src, /observe\.code/, '失败必须展示错误码')
  assert.match(src, /const reobserve = async/, '必须有重新观察动作')
  // 消费态与失效态都要给出下一步
  assert.match(src, /computerObserveCanAct/, '动作前是否可用必须由状态机判定')
})

test('P5-2 选窗器：上送服务端的只有单窗摘要', () => {
  assert.match(src, /target_handle: target\.handle/)
  assert.match(src, /target_summary: windowSummary\(target\)/)
  assert.match(src, /scope,\s*\n?/ )
  // 授权请求体不得包含窗口数组 / 标题全集
  const grantCall = src.slice(src.indexOf('/computer-grants'), src.indexOf('/computer-grants') + 400)
  assert.equal(/windows|all_windows|items\b/.test(grantCall), false, '授权请求只发单窗摘要')
  assert.match(src, /text\.length > 160/, '摘要必须有长度上限')
})
