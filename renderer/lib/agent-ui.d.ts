export type AgentModeKey = 'discuss' | 'plan' | 'execute'
export type StatusTone = 'running' | 'waiting' | 'paused' | 'blocked' | 'done' | 'failed' | 'muted' | 'unread'

export type AgentCommand = { name: string; label: string; description: string; shortcut: string }

export type ComposerTrigger = { kind: 'at' | 'slash' | 'skill'; query: string; start: number; end: number }

export type TimelineRow = {
  id: string
  title: string
  count: number
  status: string
  durationMs: number
  read: boolean
  objects: { id: string; label: string; domain?: string }[]
  defaultOpen?: boolean
}

export type RunTimeline = {
  title: string
  status: string
  durationMs: number
  objects: number
  rows: TimelineRow[]
}

export type AgentErrorInput = { code?: string; message?: string; request_id?: string; requestId?: string } | string | null
export type MappedAgentError = {
  title: string
  reason: string
  requestId: string
  actions: { id: string; label: string }[]
  code: string
}

export type PendingItem = {
  id: string
  kind: 'action' | 'question'
  label: string
  target: string
  status: string
  actionId?: string
  questionId?: string
}

export const MODE_LABELS: Record<AgentModeKey, string>
export const MODE_ACTIONS: Record<AgentModeKey, string>
export const MODE_OPTIONS: { id: AgentModeKey; label: string; desc: string }[]
export const GOAL_STATUS_LABELS: Record<string, string>
export const STATUS_TONES: Record<string, StatusTone>
export const COMMANDS: AgentCommand[]

export function formatTokens(value: number | string | null | undefined): string
export function formatDuration(ms: number | null | undefined): string
export function contextRefsPayload(refs: Array<Record<string, any>>): Array<Record<string, unknown>>
export function skillRequestsPayload(requests: Array<Record<string, any>>): Array<Record<string, unknown>>
export function skillStateLabel(state?: { requested?: boolean; loaded?: boolean; unavailable?: boolean }): string
export function modeLabel(mode: string | null | undefined): string
export function modeActionLabel(mode: string | null | undefined): string
export function goalStatusLabel(status: string | null | undefined): string

export function deriveHeaderState(input: {
  title?: string
  hasConversation?: boolean
  accountName?: string
  mode?: string | null
  activeRun?: { status?: string; stage?: string } | null
  connection?: string
  pendingActions?: number
  pendingQuestions?: number
  goalStatus?: string | null
  lastRunStatus?: string | null
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
  panelOpen?: boolean
  pendingCount?: number
  readOnly?: boolean
  canUse?: boolean
  reason?: string
  modelName?: string
}): {
  title: string
  empty: boolean
  accountLine: string
  modeLabel: string
  status: { tone: StatusTone; label: string; count?: number }
  usage: { tokens: number; label: string; prompt: number; completion: number } | null
  panel: { open: boolean; count: number; label: string }
  observer: boolean
  modelMissing: boolean
  modelReason: string
  modelName: string
}

export function headerStatus(input: {
  activeRun?: { status?: string; stage?: string } | null
  connection?: string
  pendingActions?: number
  pendingQuestions?: number
  goalStatus?: string | null
  lastRunStatus?: string | null
}): { tone: StatusTone; label: string; count?: number }

export function conversationRowState(item: {
  pending_actions?: number
  pending_questions?: number
  has_active_run?: boolean
  has_unread?: boolean
  archived_at?: string | null
  goal?: { status?: string } | null
}): { tone: StatusTone; label: string; count: number; dot: boolean }

export function shouldAutoOpenPanel(input: {
  savedOpen?: boolean
  conversationId?: string | null
  pendingActions?: number
  pendingQuestions?: number
  artifacts?: number
  browserOp?: boolean
}): boolean

export function tabCountLabel(value: number | null | undefined): string

export function tabLabel(tab: { title?: string | null; url?: string | null } | null | undefined): {
  label: string
  full: string
  title: string
}

export function detectComposerTrigger(value: string, caret: number, composing: boolean): ComposerTrigger | null
export function removeComposerTrigger(value: string, trigger: ComposerTrigger | null): { text: string; caret: number }
export function matchCommands(query: string, list?: AgentCommand[]): AgentCommand[]

export function addToLimitedList<T>(
  list: T[],
  item: T,
  limit: number,
  keyOf: (value: T) => string,
): { list: T[]; ok: boolean; reason: '' | 'duplicate' | 'limit' }

export function shouldPromptDraftSwitch(currentReviewID: string | null | undefined, targetID: string, hasDraft: boolean): boolean
export function buildRunTimeline(input: {
  plan?: {
    steps?: { id: string; title: string }[]
    step_states?: { step_id: string; status: string; evidence_refs?: { kind: string; id: string }[] }[]
  } | null
  toolCalls?: {
    id?: string
    name?: string
    domain?: string
    status?: string
    duration_ms?: number
    step_id?: string
    object_refs?: { id: string; label: string; domain?: string }[]
  }[]
  actions?: { id: string; status: string; title?: string }[]
}): RunTimeline | null

export function mapAgentError(error: AgentErrorInput): MappedAgentError

export function mergeAgentErrors(errors?: AgentErrorInput[]): AgentErrorInput[]

export function pendingItems(input?: {
  actions?: { id: string; status: string; title?: string; tool_name?: string; target?: { name?: string } }[]
  questions?: { id: string; status: string; items?: { title: string }[] }[]
}): PendingItem[]

export function onboardingHint(input: {
  readOnly?: boolean
  canUse?: boolean
  reason?: string
  hasAccount?: boolean
}): { id: string; text: string; action: string } | null

export function browserModeSummary(
  mode: 'inapp' | 'chrome',
  state?: { paired?: number; authorizing?: boolean },
): { label: string; tone: StatusTone; note: string }

export function latestBrowserActivity(
  messages: { tool_calls?: { id: string; name: string; summary?: string; status?: string }[] }[],
): { id: string; name: string; label: string } | null

export function modelRowMeta(model?: {
  provider_name?: string
  tools?: boolean
  vision?: boolean
  self_test?: 'passed' | 'failed' | 'untested' | string
  available?: boolean
  reason?: string
}): string

/** IX-09：命令面板驱动 AI 对话页执行与 / 命令同源的控件动作。 */
export function agentCmd(name: string): void
