import { useQuery } from '@tanstack/react-query'
import { get } from './api'

export interface AgentModel {
  provider_id: string
  provider_name: string
  model: string
  vision: boolean
  is_default: boolean
}

export interface AgentBootstrap {
  enabled: boolean
  can_use: boolean
  reason: '' | 'disabled' | 'viewer_disabled' | 'admin_override' | 'no_model' | 'not_tested' | string
  role: 'owner' | 'editor' | 'viewer'
  read_only: boolean
  models: AgentModel[]
  default_model: { provider_id: string; model: string } | null
  default_model_unsupported: boolean
  allow_model_pick: boolean
  limits: {
    max_rounds: number
    max_reads: number
    max_generates: number
    max_cards: number
    run_seconds: number
    max_continuations: number
    message_chars: number
    attachments_per_message: number
    image_bytes: number
    text_bytes: number
  }
  privacy_notice_seen: boolean
}

export interface AgentConversation {
  id: string
  title: string
  title_source: string
  pinned_at: string | null
  model_provider_id: string | null
  model: string
  account_id: string | null
  last_message_at: string
  created_at: string
  updated_at: string
}

export type AgentConversationListItem = AgentConversation & {
  pending_actions: number
  has_active_run: boolean
}

export interface AgentConversationUsage {
  prompt_tokens: number
  completion_tokens: number
}

export interface AgentAttachment {
  id: string
  kind: 'image' | 'text' | string
  name: string
  mime: string
  bytes: number
  width: number | null
  height: number | null
  url: string
}

export interface AgentToolCall {
  id: string
  name: string
  summary: string
  result_preview: string
}

export interface AgentMessage {
  id: string
  seq: number
  role: 'user' | 'assistant' | 'system'
  content: string
  tool_calls: AgentToolCall[]
  attachments: AgentAttachment[]
  run_id: string | null
  ai_call_id?: string | null
  created_at: string
}

export interface AgentAction {
  id: string
  run_id: string
  tool_name: string
  title: string
  kind: 'W' | 'H' | 'X' | string
  gate: string
  second_confirm: null | { text?: string; type_name?: string } | string
  status: string
  target: { type: string; id: string; name: string; link: string }
  changes: { field: string; label: string; before: string; after: string; editable: boolean; blank: boolean }[]
  notices: string[]
  ai_cost: boolean
  need: unknown
  result_summary: string
  error: unknown
  last_error: unknown
  expires_at: string
  batch_id: string
  created_at: string
  editable_fields: string[]
  blank_fields: string[]
}

export interface AgentActiveRun {
  id: string
  status: 'queued' | 'running' | string
  stage: string
  trigger: string
  model_provider_id: string | null
  model: string
  started_at: string
}

export interface AgentConversationDetail {
  conversation: AgentConversation
  usage: AgentConversationUsage
  messages: AgentMessage[]
  actions: AgentAction[]
  active_run: AgentActiveRun | null
  can_continue: boolean
  has_more: boolean
}

export interface AgentConversationPage {
  items: AgentConversationListItem[]
  next_cursor: string | null
}

export function useAgentBootstrap() {
  return useQuery({
    queryKey: ['agent-bootstrap'],
    queryFn: () => get<AgentBootstrap>('/agent/bootstrap'),
    staleTime: 30_000,
  })
}

