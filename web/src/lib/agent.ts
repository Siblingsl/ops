import { useQuery } from '@tanstack/react-query'
import { get } from './api'
import type { AgentRunEnd } from './agent-events'
export { streamAgentEvents } from './agent-events'
export type { AgentRunAcceptance, AgentRunEnd, AgentEventEnvelope } from './agent-events'

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
  features: Record<string, boolean>
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
  revision: number
  archived_at?: string | null
  group_id?: string | null
  read_upto_message_seq?: number
  force_unread?: boolean
}

export type AgentConversationListItem = AgentConversation & {
  pending_actions: number
  has_active_run: boolean
  has_unread?: boolean
  matched_message_id?: string
  matched_message_seq?: number
  matched_message_snippet?: string
}

export interface AgentConversationGroup {
  id: string
  name: string
  created_at: string
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
  status?: 'running' | 'done' | 'error' | 'cancelled' | 'interrupted' | string
  duration_ms?: number
  error?: { code: string; message: string; request_id?: string }
}

export interface AgentContextReference {
  type: string
  id: string
  revision?: string
  scope: 'turn' | 'conversation' | string
  name?: string
}

export interface AgentSkillRequest {
  skill_id: string
  work_id?: string
  name?: string
}

export interface AgentSkillUsage {
  id: string
  name: string
  scope: string
  loaded: boolean
  used?: boolean
  reason?: string
}

export interface AgentMessage {
  id: string
  seq: number
  message_key?: string
  role: 'user' | 'assistant' | 'system'
  content: string
  tool_calls: AgentToolCall[]
  attachments: AgentAttachment[]
  context_refs?: AgentContextReference[]
  skill_requests?: AgentSkillRequest[]
  skill_usage?: AgentSkillUsage[]
  run_id: string | null
  ai_call_id?: string | null
  created_at: string
}

export interface AgentAction {
  id: string
  revision?: number
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
  last_run?: (AgentActiveRun & AgentRunEnd) | null
  can_continue: boolean
  has_more: boolean
  last_event_seq?: number
  read_upto_event_seq?: number
  has_unread?: boolean
  partial_output?: { run_id: string; message_key: string; text: string; chunk_index: number; complete: false } | null
}

export interface AgentArtifactSummary {
  id: string
  kind: string
  title: string
  current_version: number
  source_kind?: string
  source_run_id?: string
  updated_at: string
}

export interface AgentArtifactPage {
  items: AgentArtifactSummary[]
  next_cursor: string | null
}

export interface AgentArtifactVersion {
  id: string
  version: number
  source_kind: string
  content: unknown
  hash: string
  status: string
  created_at: string
  available: boolean
  open_url?: string
  image_url?: string
  object_revision?: string
}

export interface AgentArtifactDetail {
  artifact: { id: string; conversation_id: string; kind: string; title: string; updated_at: string }
  current_version: AgentArtifactVersion | null
  versions: AgentArtifactVersion[]
  next_cursor: string | null
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

