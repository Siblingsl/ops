/**
 * 平台侧内部错误码 → 用户能看懂的中文（PB-10 / PB-13）。
 *
 * 服务端 `server/internal/app/platform_sync.go` 里的 code 是给日志和排障用的，
 * 直接渲染到界面上用户无法判断该做什么。这里统一给「一句话解释 + 建议动作」，
 * 并且只在没有映射时退化成「未知状态（码）」，不再把裸码单独甩给用户。
 */

export interface PlatformErrorCopy {
  /** 一句话说明发生了什么，用用户能理解的说法。 */
  title: string
  /** 建议动作，说明下一步该点什么。 */
  hint: string
}

const copies: Record<string, PlatformErrorCopy> = {
  platform_login_required: {
    title: '平台登录已失效',
    hint: '请重新登录并核对这个平台账号，然后点击「继续同步」。',
  },
  platform_challenge_required: {
    title: '平台要求额外验证',
    hint: '请在平台完成验证并核对登录，然后点击「继续同步」。',
  },
  platform_schema_changed: {
    title: '平台页面结构变了',
    hint: '客户端暂时读不到数据，通常需要等适配器更新；可以先用「手动粘贴」补录。',
  },
  platform_identity_mismatch: {
    title: '登录的账号不是这个账号',
    hint: '刚才扫码登录的是另一个平台账号，请确认后重新登录这个账号。',
  },
  platform_rate_limited: {
    title: '平台限制访问频率',
    hint: '读取已停止，请按平台提示核对限制；冷却后由本人确认恢复。',
  },
  platform_network_error: {
    title: '网络不通',
    hint: '检查网络后重试，失败不会丢数据，下次同步会接着来。',
  },
  platform_session_expired: {
    title: '登录状态已过期',
    hint: '重新登录这个平台账号即可继续。',
  },
  platform_cursor_stalled: {
    title: '同步卡在同一页',
    hint: '已保留已读到的数据；可以继续同步从断点接着读，或先手动补录。',
  },
  platform_permission_denied: {
    title: '账号没有这个页面的权限',
    hint: '确认用的是有权限的平台账号；没有权限的部分不会计入覆盖率。',
  },
  platform_unsupported: {
    title: '这个平台暂不支持自动读取',
    hint: '这篇内容需要在平台上手动复制，或用「手动粘贴」补录。',
  },
  operation_timeout: {
    title: '这一步超时了',
    hint: '可以继续同步从断点接着读，已经读到的数据不会丢。',
  },
  operation_cancelled: {
    title: '同步已被取消',
    hint: '需要的话重新发起一次同步即可。',
  },
}

/** 没有命中映射时也给出可读标题，而不是只显示裸码。 */
export function platformErrorCopy(code: string | null | undefined): PlatformErrorCopy | null {
  if (!code) return null
  const known = copies[code]
  if (known) return known
  return { title: '同步遇到未预期的问题', hint: `可以重试一次；仍然失败请联系管理员，附上错误码 ${code}。` }
}

/**
 * 覆盖状态的中文映射（PB-13）。服务端 `field_coverage` 的值是 `present`/`missing`/`partial` 之类的串，
 * `content_state` 是 `complete/partial/denied/unsupported`。
 */
const fieldStates: Record<string, string> = {
  present: '已读到',
  complete: '已读到',
  missing: '平台没提供',
  partial: '只读到一部分',
  truncated: '只读到一部分',
  denied: '没有权限',
  unsupported: '平台不支持',
  unknown: '未知',
}

export function fieldStateLabel(state: string | null | undefined): string {
  if (!state) return '未知'
  return fieldStates[state] ?? `未知（${state}）`
}

const contentStates: Record<string, string> = {
  complete: '正文完整',
  partial: '只读到部分正文',
  denied: '没有权限读取正文',
  unsupported: '平台不支持读取正文',
  unknown: '正文状态未知',
}

export function contentStateLabel(state: string | null | undefined): string {
  if (!state) return '正文状态未知'
  return contentStates[state] ?? `正文状态未知（${state}）`
}

/** 字段名本身也是英文列名，顺手翻译，避免 `title：missing` 这种半中半英。 */
const fieldNames: Record<string, string> = {
  title: '标题',
  body: '正文',
  cover: '封面',
  images: '图片',
  published_at: '发布时间',
  metrics: '数据指标',
  tags: '话题',
  author: '作者',
  url: '链接',
}

export function fieldNameLabel(field: string): string {
  return fieldNames[field] ?? field
}
