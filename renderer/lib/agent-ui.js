// AI 对话页的纯逻辑与状态词典（docs/38 §7～§9、§20.2）。
// 放在 .js + .d.ts 是为了让 node:test 直接导入同一份实现，避免测试另抄一套规则。

export const MODE_LABELS = {
  discuss: '讨论',
  plan: '计划',
  execute: '执行（逐卡确认）',
}

export const MODE_ACTIONS = {
  discuss: '提问',
  plan: '生成计划',
  execute: '发送',
}

// IX-06：模式菜单每项都必须说明“会不会写”，执行绝不能暗示自动批量写入。
export const MODE_OPTIONS = [
  { id: 'discuss', label: '讨论', desc: '只读分析，不产生卡片' },
  { id: 'plan', label: '计划', desc: '先给步骤，不执行' },
  { id: 'execute', label: '执行（逐卡确认）', desc: '可产生卡片，写入逐张确认，不批量执行' },
]

export const GOAL_STATUS_LABELS = {
  active: '进行中',
  paused: '已暂停',
  waiting_user: '待你处理',
  completed: '已完成',
  blocked: '已阻塞',
  budget_limited: '预算已用尽',
  cancelled: '已结束',
}

export const STATUS_TONES = {
  running: 'running',
  waiting: 'waiting',
  paused: 'paused',
  blocked: 'blocked',
  done: 'done',
  failed: 'failed',
  muted: 'muted',
  unread: 'unread',
}

export const COMMANDS = [
  { name: 'new', label: '/new', description: '新建对话，不继承旧上下文', shortcut: 'Ctrl+Shift+O' },
  { name: 'plan', label: '/plan', description: '切到计划模式，只给步骤不执行', shortcut: '' },
  { name: 'execute', label: '/execute', description: '切到执行模式，写入仍逐张卡片确认', shortcut: '' },
  { name: 'discuss', label: '/discuss', description: '切到讨论模式，不产生操作卡片', shortcut: '' },
  { name: 'model', label: '/model', description: '打开模型菜单，只改下一次运行', shortcut: '' },
  { name: 'context', label: '/context', description: '打开任务面板的上下文页', shortcut: '' },
  { name: 'skills', label: '/skills', description: '打开技能选择，不自动加载', shortcut: '' },
  { name: 'compact', label: '/compact', description: '打开压缩预览，不静默丢消息', shortcut: '' },
  { name: 'goal', label: '/goal', description: '打开任务目标面板，不自动设目标', shortcut: '' },
  { name: 'archive', label: '/archive', description: '归档当前对话，不删除数据', shortcut: '' },
]

const DOMAIN_LABELS = {
  works: '作品',
  accounts: '账号',
  topics: '选题',
  materials: '素材',
  metrics: '指标',
  review: '复盘',
  reviews: '复盘',
  checks: '检查',
  assets: '图片',
  images: '图片',
  memory: '记忆',
  skills: '技能',
  daily: '日常',
  comments: '评论',
  wechat: '公众号',
  xhs: '小红书',
  toutiao: '头条',
  workbench: '工作台',
}

const DOMAIN_READ_VERBS = {
  works: '读取作品',
  accounts: '读取账号',
  topics: '读取选题',
  materials: '读取素材',
  metrics: '查询指标',
  review: '查询复盘',
  reviews: '查询复盘',
  checks: '执行检查',
  assets: '读取图片',
  images: '读取图片',
  memory: '读取记忆',
  skills: '加载技能',
  daily: '读取日常',
  comments: '读取评论',
  wechat: '读取公众号草稿',
  xhs: '读取小红书数据',
  toutiao: '读取头条数据',
  workbench: '读取工作台',
}

export function formatTokens(value) {
  const n = Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0
  if (n < 1000) return String(n)
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1000000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}m`
}

export function formatDuration(ms) {
  const seconds = Math.max(0, Number(ms) || 0) / 1000
  if (seconds >= 60) return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`
  if (seconds > 0 && seconds < 0.1) return '<0.1 秒'
  return `${seconds.toFixed(1)} 秒`
}

/** IX-10：输入台筹码的发送投影；移除后的状态必须直接反映到 payload，不再二次拼装。 */
export function contextRefsPayload(refs) {
  return refs.map(({ type, id, artifact_id, revision, reference_scope, anchor }) => ({ type, id, ...(artifact_id ? { artifact_id } : {}), revision, scope: reference_scope, ...(anchor ? { anchor } : {}) }))
}

export function skillRequestsPayload(requests) {
  return requests.map(({ skill_id, work_id }) => ({ skill_id, ...(work_id ? { work_id } : {}) }))
}

/** IX-03：技能筹码与“本轮技能状态”共用同一套状态文案；未实际调用不改写“已加载”。 */
export function skillStateLabel({ requested = false, loaded = false, unavailable = false } = {}) {
  if (unavailable) return '不可用，移除'
  if (loaded) return '已加载到模型上下文；实际使用未验证'
  if (requested) return '已请求，未加载'
  return '未装入'
}

export function modeLabel(mode) {
  return MODE_LABELS[mode] || MODE_LABELS.execute
}

export function modeActionLabel(mode) {
  return MODE_ACTIONS[mode] || MODE_ACTIONS.execute
}

export function goalStatusLabel(status) {
  return GOAL_STATUS_LABELS[status] || String(status || '')
}

// UI-01：会话头的状态优先级。空对话不显示“待开始”，观察者/无模型单独出 chip。
export function deriveHeaderState(input) {
  const {
    title, hasConversation, accountName, mode, activeRun, connection,
    pendingActions = 0, pendingQuestions = 0, goalStatus, lastRunStatus,
    usage, panelOpen, pendingCount = 0, readOnly, canUse, reason, modelName,
  } = input || {}
  const empty = !hasConversation
  const status = empty ? { tone: STATUS_TONES.muted, label: '' } : headerStatus({
    activeRun, connection, pendingActions, pendingQuestions, goalStatus, lastRunStatus,
  })
  const usageTokens = usage ? (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0) : null
  return {
    title: empty ? 'AI 对话' : (title || '新对话'),
    empty,
    accountLine: accountName || '未选择账号',
    modeLabel: modeLabel(mode),
    status,
    usage: usageTokens === null ? null : {
      tokens: usageTokens,
      label: formatTokens(usageTokens),
      prompt: Number(usage.prompt_tokens) || 0,
      completion: Number(usage.completion_tokens) || 0,
    },
    panel: { open: !!panelOpen, count: Math.max(0, Number(pendingCount) || 0), label: '任务面板' },
    observer: !!readOnly,
    modelMissing: !canUse && (reason === 'no_model' || reason === 'not_tested'),
    modelReason: canUse ? '' : (reason || ''),
    modelName: modelName || '',
  }
}

export function headerStatus({ activeRun, connection, pendingActions = 0, pendingQuestions = 0, goalStatus, lastRunStatus }) {
  const pending = Math.max(0, Number(pendingActions) || 0) + Math.max(0, Number(pendingQuestions) || 0)
  if (activeRun) {
    if (connection === 'reconnecting') return { tone: STATUS_TONES.paused, label: '连接中断，任务仍在运行' }
    if (activeRun.status === 'queued') return { tone: STATUS_TONES.waiting, label: '排队中' }
    if (activeRun.stage === 'stopping') return { tone: STATUS_TONES.paused, label: '正在停止' }
    return { tone: STATUS_TONES.running, label: '运行中' }
  }
  if (pending > 0) return { tone: STATUS_TONES.waiting, label: `待你处理 ${pending}`, count: pending }
  if (goalStatus === 'paused') return { tone: STATUS_TONES.paused, label: '已暂停' }
  if (goalStatus === 'blocked') return { tone: STATUS_TONES.blocked, label: '已阻塞' }
  if (goalStatus === 'budget_limited') return { tone: STATUS_TONES.waiting, label: '预算已用尽' }
  if (goalStatus === 'waiting_user') return { tone: STATUS_TONES.waiting, label: '待你处理' }
  if (lastRunStatus === 'failed') return { tone: STATUS_TONES.failed, label: '失败' }
  if (lastRunStatus === 'completed') return { tone: STATUS_TONES.done, label: '已完成' }
  return { tone: STATUS_TONES.muted, label: '已就绪' }
}

// UI-07 / FN-01：会话行状态。未读点与待处理分开，元信息优先状态词。
export function conversationRowState(item) {
  const data = item || {}
  const actions = Math.max(0, Number(data.pending_actions) || 0)
  const questions = Math.max(0, Number(data.pending_questions) || 0)
  if (data.has_active_run) return { tone: STATUS_TONES.running, label: '运行中', count: 0, dot: false }
  if (actions > 0) return { tone: STATUS_TONES.waiting, label: `待你处理 ${actions + questions}`, count: actions + questions, dot: false }
  if (questions > 0) return { tone: STATUS_TONES.waiting, label: `待回答 ${questions}`, count: questions, dot: false }
  const goal = data.goal
  if (goal && goal.status === 'paused') return { tone: STATUS_TONES.paused, label: '已暂停', count: 0, dot: false }
  if (goal && goal.status === 'blocked') return { tone: STATUS_TONES.blocked, label: '已阻塞', count: 0, dot: false }
  if (goal && goal.status === 'budget_limited') return { tone: STATUS_TONES.waiting, label: '预算已用尽', count: 0, dot: false }
  if (goal && goal.status === 'waiting_user') return { tone: STATUS_TONES.waiting, label: '待你处理', count: 0, dot: false }
  if (data.archived_at) return { tone: STATUS_TONES.muted, label: '已归档', count: 0, dot: false }
  if (data.has_unread) return { tone: STATUS_TONES.unread, label: '就绪', count: 0, dot: true }
  return { tone: STATUS_TONES.muted, label: '就绪', count: 0, dot: false }
}

// UI-02：恢复偏好与“空对话不自动打开”的判定。savedOpen 只影响有内容的对话。
export function shouldAutoOpenPanel({ savedOpen, conversationId, pendingActions = 0, pendingQuestions = 0, artifacts = 0, browserOp = false }) {
  if (!conversationId) return false
  if (pendingActions > 0 || pendingQuestions > 0 || artifacts > 0 || browserOp) return true
  return savedOpen === true
}

// UI-03：页签计数只在 > 0 时显示。
export function tabCountLabel(value) {
  const n = Math.max(0, Number(value) || 0)
  if (n <= 0) return ''
  if (n > 99) return '99+'
  return String(n)
}

// BR-06：标签名标题优先；空标题/URL 标题回退 host + path，截断 24 字；tooltip 用完整 URL。
export function tabLabel(tab) {
  const url = String((tab && tab.url) || '')
  const rawTitle = String((tab && tab.title) || '').trim()
  let label = rawTitle
  const titleLooksLikeURL = /^(https?:\/\/|www\.)/i.test(rawTitle) || rawTitle.includes('://')
    || /^(?:localhost|[\w-]+(?:\.[\w-]+)+)(?::\d+)?\//i.test(rawTitle)
  if (!label || titleLooksLikeURL) {
    try {
      const parsed = new URL(url)
      const path = parsed.pathname === '/' ? '' : parsed.pathname
      label = `${parsed.hostname}${path}`
    } catch {
      label = url
    }
  }
  if (!label) label = '新标签'
  const clipped = Array.from(label).length > 24 ? `${Array.from(label).slice(0, 23).join('')}…` : label
  return { label: clipped, full: url, title: rawTitle }
}

// IX-01/02/03：内联入口只在光标前的当前词命中时打开；组字中不打开。
export function detectComposerTrigger(value, caret, composing) {
  if (composing) return null
  const text = String(value || '')
  const end = Math.max(0, Math.min(Number(caret) || 0, text.length))
  const before = text.slice(0, end)
  const at = before.match(/(?:^|\s)@([^\s@]{0,32})$/)
  if (at) return { kind: 'at', query: at[1], start: end - at[1].length - 1, end }
  const slash = before.match(/(?:^|\s)\/([a-z-]{0,20})$/)
  if (slash) return { kind: 'slash', query: slash[1], start: end - slash[1].length - 1, end }
  const dollar = before.match(/(?:^|\s)\$([^\s$]{0,24})$/)
  if (dollar) return { kind: 'skill', query: dollar[1], start: end - dollar[1].length - 1, end }
  return null
}

// 选中候选后删除触发词（保留前后空白，不写入消息正文）。
export function removeComposerTrigger(value, trigger) {
  const text = String(value || '')
  if (!trigger) return { text, caret: Number(text.length) }
  const start = Math.max(0, Number(trigger.start) || 0)
  const end = Math.max(start, Number(trigger.end) || start)
  const next = `${text.slice(0, start)}${text.slice(end)}`
  const caret = Math.max(0, Math.min(start, next.length))
  return { text: next, caret }
}

export function matchCommands(query, list) {
  const q = String(query || '').trim().toLowerCase()
  const commands = list || COMMANDS
  if (!q) return commands
  return commands.filter((command) => command.name.startsWith(q)
    || command.label.slice(1).startsWith(q)
    || command.description.toLowerCase().includes(q))
}

// IX-01/03：上限与去重。返回原因给 toast，不静默丢弃。
export function addToLimitedList(list, item, limit, keyOf) {
  const current = Array.isArray(list) ? list : []
  const key = keyOf(item)
  if (current.some((existing) => keyOf(existing) === key)) return { list: current, ok: false, reason: 'duplicate' }
  if (current.length >= limit) return { list: current, ok: false, reason: 'limit' }
  return { list: [...current, item], ok: true, reason: '' }
}

// FN-03 / TL-02：把工具活动聚合为业务步骤，成功折叠、失败展开，不展示参数。
// 元工具只负责装载/上下文，不属于业务步骤，不能把它们算成“已读取 N 项”。
const TIMELINE_META_TOOLS = new Set(['get_context', 'load_tool_domain', 'make_link', 'load_skill'])

export function shouldPromptDraftSwitch(currentReviewID, targetID, hasDraft) {
  return !!currentReviewID && currentReviewID !== targetID && !!hasDraft
}

export function buildRunTimeline({ plan, toolCalls, actions } = {}) {
  const calls = Array.isArray(toolCalls) ? toolCalls.filter((call) => !TIMELINE_META_TOOLS.has(call.name)) : []
  const steps = Array.isArray(plan && plan.steps) ? plan.steps : []
  const states = Array.isArray(plan && plan.step_states) ? plan.step_states : []
  const cards = Array.isArray(actions) ? actions : []
  if (!calls.length && !steps.length && !cards.length) return null
  const rows = steps.length ? rowsFromPlan(steps, states, calls) : rowsFromDomains(calls)
  const pendingCards = cards.filter((action) => ['pending', 'needs_input'].includes(action.status))
  if (pendingCards.length) {
    rows.push({
      id: 'cards',
      title: `提出 ${pendingCards.length} 张修改卡片`,
      count: pendingCards.length,
      status: 'waiting',
      durationMs: 0,
      objects: [],
    })
  }
  for (const row of rows) {
    if (row.status === 'running' || row.status === 'failed' || row.status === 'waiting') row.defaultOpen = true
  }
  const durations = rows.reduce((total, row) => total + (row.durationMs || 0), 0)
  const objects = rows.reduce((total, row) => total + (row.count || 0), 0)
  const failed = rows.some((row) => row.status === 'failed')
  const waiting = rows.some((row) => row.status === 'waiting')
  const running = rows.some((row) => row.status === 'running')
  const status = failed ? 'failed' : running ? 'running' : waiting ? 'waiting' : 'done'
  const allRead = rows.every((row) => row.read !== false)
  const title = failed ? '有步骤失败，已展开失败项'
    : waiting ? `已处理 ${objects} 项，${rows.some((row) => row.status === 'waiting') ? '有 1 项待你处理' : ''}`
      : running ? `正在处理 ${objects} 项`
        : `${allRead ? '已读取' : '已处理'} ${objects} 项${allRead ? '资料' : ''}${durations ? `，用时 ${formatDuration(durations)}` : ''}`
  return { title, status, durationMs: durations, objects, rows }
}

function rowsFromDomains(calls) {
  const groups = new Map()
  for (const call of calls) {
    const domain = String(call.domain || '').trim() || 'generic'
    if (!groups.has(domain)) groups.set(domain, [])
    groups.get(domain).push(call)
  }
  const rows = []
  let index = 0
  for (const [domain, list] of groups) {
    index += 1
    const status = list.some((call) => call.status === 'error' || call.status === 'failed') ? 'failed'
      : list.some((call) => call.status === 'running') ? 'running'
        : list.some((call) => call.status === 'interrupted') ? 'failed'
          : list.some((call) => call.status === 'cancelled') ? 'failed' : 'done'
    const durationMs = list.reduce((total, call) => total + (Number(call.duration_ms) || 0), 0)
    const verb = DOMAIN_READ_VERBS[domain] || '处理'
    const noun = DOMAIN_LABELS[domain] || ''
    rows.push({
      id: `domain-${domain}-${index}`,
      title: `${verb} ${list.length} 项${noun ? ` · ${noun}` : ''}`,
      count: list.length,
      status,
      durationMs,
      read: domain !== 'actions' && domain !== 'workbench',
      objects: list.flatMap((call) => Array.isArray(call.object_refs) ? call.object_refs : []).slice(0, 3),
    })
  }
  return rows
}

function rowsFromPlan(steps, states, calls) {
  return steps.map((step, index) => {
    const state = states.find((item) => item.step_id === step.id)
    const status = state && ['pending', 'in_progress', 'waiting_user', 'completed', 'failed', 'skipped'].includes(state.status)
      ? (state.status === 'in_progress' ? 'running' : state.status === 'waiting_user' ? 'waiting' : state.status)
      : 'pending'
    const matches = calls.filter((call) => call.step_id === step.id)
    return {
      id: step.id || `step-${index + 1}`,
      title: step.title || `步骤 ${index + 1}`,
      count: matches.length || (state && state.evidence_refs ? state.evidence_refs.length : 0) || (status === 'completed' ? 1 : 0),
      status,
      durationMs: matches.reduce((total, call) => total + (Number(call.duration_ms) || 0), 0),
      read: false,
      objects: matches.flatMap((call) => Array.isArray(call.object_refs) ? call.object_refs : []).slice(0, 3),
    }
  })
}

// IX-08：同一 run 的错误按 code/message/request_id 去重合并，顺序保留。
export function mergeAgentErrors(errors) {
  const seen = new Set()
  const merged = []
  for (const error of errors || []) {
    if (!error) continue
    const key = typeof error === 'string' ? error : `${error.code || ''}|${error.message || ''}|${error.request_id || error.requestId || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(error)
  }
  return merged
}

// IX-08：错误码 → 原因 + 恢复动作，错误卡不整块红底。
export function mapAgentError(error) {
  const data = typeof error === 'string' ? { message: error } : (error || {})
  const code = String(data.code || '')
  const requestId = String(data.request_id || data.requestId || '')
  const raw = String(data.message || '')
  const actions = []
  let title = '请求失败'
  let reason = raw || '请稍后重试。'
  if (code === 'model_not_supported') {
    title = '模型不支持工具调用'
    reason = '换一个支持工具调用的模型，或先完成模型能力自检。'
    actions.push({ id: 'change-model', label: '换模型' }, { id: 'open-models', label: '去设置' })
  } else if (code === 'context_unavailable') {
    title = '引用的资料已变化'
    reason = '重新选择引用后再发送；原文已变化时旧选段不能继续使用。'
    actions.push({ id: 'reselect-context', label: '重新选择' })
  } else if (code === 'permission_denied') {
    title = '没有权限执行这个动作'
    reason = '当前角色只读，或该对象不在你的工作区范围。'
    actions.push({ id: 'open-permissions', label: '查看权限' })
  } else if (code === 'rate_limited') {
    title = '请求过于频繁'
    reason = '稍等片刻再试；排队中的消息不会重复计费。'
    actions.push({ id: 'retry', label: '稍后重试' })
  } else if (code === 'network' || code === 'network_error') {
    title = '连接中断'
    reason = '任务可能仍在运行，恢复连接后可继续查看。'
    actions.push({ id: 'retry', label: '重试' })
  } else if (code === 'internal' || code === 'server_error') {
    title = '服务暂时不可用'
    reason = raw || '请求没有完成，请稍后重试；对话内容仍保留在本地。'
    actions.push({ id: 'retry', label: '重试' })
  } else if (code === 'result_unknown') {
    title = '执行结果未确认'
    reason = '命令可能已生效，请先核对目标对象，不要重复执行。'
    actions.push({ id: 'verify', label: '核对结果' })
  } else {
    actions.push({ id: 'retry', label: '重试' })
  }
  if (requestId) actions.push({ id: 'copy-request-id', label: '复制请求 ID' })
  return { title, reason, requestId, actions, code }
}

// FN-02：待处理列表的一条一行，空时不渲染。
export function pendingItems({ actions, questions } = {}) {
  const items = []
  for (const action of actions || []) {
    if (!['pending', 'needs_input'].includes(action.status)) continue
    items.push({
      id: `action:${action.id}`,
      kind: 'action',
      label: action.title || action.tool_name,
      target: action.target && action.target.name ? action.target.name : '',
      status: action.status === 'needs_input' ? '待选择' : '待你处理',
      actionId: action.id,
    })
  }
  for (const question of questions || []) {
    if (question.status !== 'pending') continue
    items.push({
      id: `question:${question.id}`,
      kind: 'question',
      label: (question.items || []).map((item) => item.title).join(' / ') || '待回答的问题',
      target: '',
      status: '待回答',
      questionId: question.id,
    })
  }
  return items
}

// IX-11：首次使用提示只显示一条，按优先级只读 > 无模型 > 未自检 > 无账号。
export function onboardingHint({ readOnly, canUse, reason, hasAccount }) {
  if (readOnly) return { id: 'readonly', text: '观察者只能查询，不能修改工作区数据。', action: '查看权限' }
  if (!canUse && reason === 'no_model') return { id: 'no-model', text: '先配置一个支持工具调用的模型，才能开始对话。', action: '去模型配置' }
  if (!canUse && reason === 'not_tested') return { id: 'not-tested', text: '先完成模型能力自检，才能使用工具。', action: '去自检' }
  if (!hasAccount) return { id: 'no-account', text: '先选择运营账号，智能体才能读取对应数据。', action: '选择账号' }
  return null
}

// BR-01：两条浏览器路径不共用一个语义；应用内是用户自己研究，Chrome 才由 Agent 操作。
export function browserModeSummary(mode, { paired = 0, authorizing = false } = {}) {
  if (mode === 'chrome') {
    if (authorizing) return { label: '操作中', tone: STATUS_TONES.running, note: '任务发送时选择标签并授权；Agent 只操作已授权标签。' }
    if (paired > 0) return { label: `已连接 ${paired}`, tone: STATUS_TONES.done, note: '任务发送时选择标签并授权；Agent 只操作已授权标签。' }
    return { label: '未连接', tone: STATUS_TONES.muted, note: '连接 Chrome 后才能让 Agent 操作；连接引导见下方。' }
  }
  return { label: '仅本机', tone: STATUS_TONES.muted, note: '你自己浏览，Agent 不会操作这里' }
}

// BR-01：Agent 正在操作 Chrome 时，工作台自动切到 Chrome 分段并给出行内提示。
// 只认真实运行中的 browser_* 工具（tab 选择请求不算“正在操作”）。
export function latestBrowserActivity(messages) {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const calls = messages[index]?.tool_calls ?? []
    for (let callIndex = calls.length - 1; callIndex >= 0; callIndex -= 1) {
      const call = calls[callIndex]
      if (!call || call.status !== 'running') continue
      if (typeof call.name !== 'string' || !call.name.startsWith('browser_')) continue
      if (call.name === 'browser_request_tab') continue
      return { id: call.id, name: call.name, label: call.summary || call.name }
    }
  }
  return null
}

// IX-05：模型行副文案必须给出供应商、工具/看图能力与自检状态，不暴露推理强度。
export function modelRowMeta(model) {
  const data = model || {}
  const parts = [String(data.provider_name || '未知供应商')]
  if (data.tools !== false) parts.push('工具')
  if (data.vision) parts.push('看图')
  parts.push(data.self_test === 'passed' ? '已自检' : data.self_test === 'failed' ? '自检失败' : '未自检')
  if (data.available === false && data.reason) parts.push(data.reason)
  return parts.join(' · ')
}


// IX-09：命令面板驱动 AI 对话页执行同一组命令（与输入台 / 命令同源 COMMANDS）。
// agent 页监听 ops:agent-cmd，按 name 分发到与 / 命令相同的控件动作。
export function agentCmd(name) {
  window.dispatchEvent(new CustomEvent('ops:agent-cmd', { detail: { name } }))
}
