// DEV-CU P5-2（docs/36 §P5-2 / §4.5 / §4.2）：选窗器的观察状态机（纯函数，可单测）。
//
// 三条硬约束落在这里而不是散在 JSX 里：
// 1. C03「每次动作前重新观察」：快照被任一动作消费后必须回到 consumed，旧 ref 一律判失效；
// 2. 只展示白名单字段：摘要节点只有 ref/role/name/value，窗口标题全集、进程路径、hwnd 不进来；
// 3. 失败不吞码：中文提示优先，表外码回落位图结果自带的 message。
import type { DesktopComputerUiaObserveNode, DesktopComputerUiaObserveResult } from './desktop-presentation'
import { computerHintForCode } from './computer-api'

export type ComputerObservePhase = 'idle' | 'authorizing' | 'observing' | 'ready' | 'consumed' | 'failed'

/** 观察摘要项：只有四个白名单字段（不含窗口标题 / 进程 / 句柄）。 */
export type ComputerObserveItem = { ref: string; role: string; name: string; value: string }

export type ComputerObserveState = {
  phase: ComputerObservePhase
  grantId: string
  generation: number
  snapshotId: string
  revision: number
  refCount: number
  complete: boolean
  identityUnproven: boolean
  items: ComputerObserveItem[]
  code: string
  hint: string
}

export const initialComputerObserveState: ComputerObserveState = {
  phase: 'idle',
  grantId: '',
  generation: 0,
  snapshotId: '',
  revision: 0,
  refCount: 0,
  complete: false,
  identityUnproven: false,
  items: [],
  code: '',
  hint: '',
}

/** 开始授权：清掉上一轮快照与摘要，避免旧观察结果被当成新授权的。 */
export function beginComputerAuthorize(): ComputerObserveState {
  return { ...initialComputerObserveState, phase: 'authorizing' }
}

/** 授权成功（拿到 grant_id + generation）→ 进入观察中。 */
export function beginComputerObserve(grant: { grantId: string; generation: number }): ComputerObserveState {
  return {
    ...initialComputerObserveState,
    phase: 'observing',
    grantId: grant.grantId,
    generation: grant.generation,
  }
}

/**
 * 观察回包落状态。
 * 成功：ready，记住 snapshot_id / revision / ref_count / complete / identity_unproven，摘要截取前 8 项；
 * 失败：failed，code 原样保留，提示优先用 16 码中文表，表外码用回包 message。
 */
export function applyComputerObserve(
  state: ComputerObserveState,
  result: DesktopComputerUiaObserveResult,
): ComputerObserveState {
  if (!result.ok) {
    return {
      ...state,
      phase: 'failed',
      snapshotId: '',
      revision: 0,
      refCount: 0,
      complete: false,
      identityUnproven: false,
      items: [],
      code: result.code,
      hint: computerHintForCode(result.code) || result.message,
    }
  }
  return {
    ...state,
    phase: 'ready',
    snapshotId: result.snapshot_id,
    revision: result.revision,
    refCount: result.ref_count,
    complete: result.complete,
    identityUnproven: result.identity_unproven === true,
    items: summarizeObserveTree(result.tree, 8),
    code: '',
    hint: '',
  }
}

/** 任一动作执行后消费快照（C03）：旧 ref 全部失效，必须重新观察才能再动作。 */
export function consumeComputerSnapshot(state: ComputerObserveState): ComputerObserveState {
  if (state.phase !== 'ready') return state
  return { ...state, phase: 'consumed', items: [] }
}

/** 只有 ready 状态允许发起动作——consumed / failed / observing 都不行。 */
export function computerObserveCanAct(state: ComputerObserveState): boolean {
  return state.phase === 'ready' && state.snapshotId !== '' && state.revision > 0
}

/** ref 是否属于当前快照：跨快照的旧 ref 一律判失效（服务端仍会二次拒绝）。 */
export function isCurrentComputerRef(state: ComputerObserveState, ref: string): boolean {
  if (state.phase !== 'ready' || !state.snapshotId) return false
  return ref.startsWith(`@${state.snapshotId}:`)
}

/**
 * 摘要树：只取有 ref 的可交互节点，四个白名单字段；name/value 截断到展示长度。
 * children 递归但受 limit 限制，绝不把整棵树带进渲染层状态。
 */
export function summarizeObserveTree(tree: DesktopComputerUiaObserveNode, limit = 8): ComputerObserveItem[] {
  const items: ComputerObserveItem[] = []
  const walk = (node: DesktopComputerUiaObserveNode): void => {
    if (items.length >= limit) return
    if (node.ref_id) {
      items.push({
        ref: node.ref_id,
        role: node.role,
        name: node.name.length > 80 ? `${node.name.slice(0, 79)}…` : node.name,
        value: node.value.length > 60 ? `${node.value.slice(0, 59)}…` : node.value,
      })
    }
    for (const child of node.children) {
      if (items.length >= limit) return
      walk(child)
    }
  }
  walk(tree)
  return items
}
