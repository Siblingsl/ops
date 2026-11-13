// DEV-CU P4-11 收口：本机授权登记表（main 与 IPC 共用）。
// 渲染器在授权后第一次 observe/act 会带 grant_id + generation + pid；main 的
// ComputerCommandExecutor 用同一份登记表校验领取到的命令是否仍对应本机当前授权。
// 只存内存，不落盘、不写日志；不包含窗口标题以外的任何界面数据。
export interface ComputerAuthorization {
  grantId: string
  generation: number
  pid: number
  targetSummary: string
  updatedAt: number
}

const authorizations = new Map<string, ComputerAuthorization>()

/** 记录/刷新授权；同 grant 取更大的 generation（旧命令不得回退授权版本）。 */
export function recordComputerAuthorization(input: {
  grantId: string
  generation: number
  pid: number
  targetSummary: string
}): void {
  if (!input.grantId || !Number.isInteger(input.pid) || input.pid <= 0) return
  const existing = authorizations.get(input.grantId)
  if (existing && Number.isInteger(existing.generation) && existing.generation > input.generation) return
  authorizations.set(input.grantId, {
    grantId: input.grantId,
    generation: Number.isInteger(input.generation) ? input.generation : 0,
    pid: input.pid,
    targetSummary: input.targetSummary,
    updatedAt: Date.now(),
  })
}

export function computerAuthorizationOf(grantId: string): ComputerAuthorization | undefined {
  return authorizations.get(grantId)
}

/** executor 的 localGenerationOf：没登记过（未授权/已接管/已撤销）返回 null。 */
export function computerAuthorizationGeneration(grantId: string): number | null {
  const entry = authorizations.get(grantId)
  return entry ? entry.generation : null
}

export function forgetComputerAuthorization(grantId: string): void {
  authorizations.delete(grantId)
}

export function clearComputerAuthorizations(): string[] {
  const ids = Array.from(authorizations.keys())
  authorizations.clear()
  return ids
}
