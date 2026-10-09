export type Platform = 'wechat_mp' | 'xhs'
export type ContentFormat = 'long_article' | 'image_note' | 'comic'
export type WorkStatus = 'drafting' | 'checking' | 'ready' | 'pushed' | 'packed' | 'published'

export interface CredState {
  state: 'not_configured' | 'ok' | 'error' | 'unchecked'
  app_id?: string
  secret_mask?: string
  last_check_at?: string
  last_result?: string
}

export interface Account {
  id: string
  platform: Platform
  name: string
  content_format: ContentFormat
  status: 'active' | 'disabled'
  daily_push_limit: number
  created_at: string
  credential?: CredState
}

export interface WechatDefaults {
  author: string
  open_comment: boolean
  fans_only_comment: boolean
  source_url: string
}

export interface Profile {
  account_id: string
  positioning_tags: string[]
  target_audience: string
  persona_tone: string
  banned_words: string[]
  style_summary: string
  default_theme: string
  wechat_defaults: WechatDefaults
}

export interface StyleSample {
  id: string
  title: string
  content_md: string
  char_count: number
  created_at: string
}

export type MaterialKind = 'experience' | 'opinion' | 'case' | 'data'
export interface Material {
  id: string
  account_id: string | null
  kind: MaterialKind
  content: string
  source: string
  tags: string[]
  created_at: string
}

export interface Topic {
  id: string
  title: string
  angle: string
  source: 'manual' | 'ai' | 'review'
  status: 'pending' | 'adopted' | 'dropped'
  work_id?: string | null
  created_at: string
}

export interface OutlineItem {
  heading: string
  key_point: string
  material_ids: string[]
  section_id?: string
}

export interface Section {
  id: string
  position: number
  heading: string
  key_point: string
  content_md: string
  origin: 'ai' | 'human' | 'mixed'
  source_section_ids: string[]
  material_ids: string[]
  revision: number
  updated_at: string
}

export interface Asset {
  id: string
  work_id: string
  mime: string
  width: number
  height: number
  bytes: number
  position: number
  url: string
}

export interface WorkRef {
  id: string
  title: string
  account_name: string
  platform: Platform
  deleted: boolean
}

export interface CropBox { x1: number; y1: number; x2: number; y2: number }

export interface Work {
  id: string
  account_id: string
  platform: Platform
  account_name: string
  topic_id: string | null
  topic_angle: string
  source: WorkRef | null
  source_updated: boolean
  derived: WorkRef[]
  content_format: ContentFormat
  status: WorkStatus
  title: string
  summary: string
  viewpoint: string
  outline: OutlineItem[]
  outline_confirmed_at: string | null
  theme: string
  cover_asset_id: string | null
  cover_crops: Record<string, CropBox> | null
  wechat_fields: WechatDefaults
  topics: string[]
  wechat_draft_media_id: string | null
  published_url: string | null
  published_at: string | null
  locked: boolean
  revision: number
  sections: Section[]
  material_ids: string[]
  assets: Asset[]
  created_at: string
  updated_at: string
}

export interface WorkListItem {
  id: string
  title: string
  status: WorkStatus
  content_format: ContentFormat
  source_work_id: string | null
  source_title: string | null
  derived_count: number
  cover_asset_id: string | null
  first_asset_id: string | null
  char_count: number
  section_count: number
  published_at: string | null
  updated_at: string
}

export interface CheckItem {
  id: string
  category: 'format' | 'sensitive' | 'fact' | 'ai_disclosure' | 'similarity' | 'ad_law'
  passed: boolean
  matched_text: string
  location: { field?: string; label?: string; section_id?: string; found?: boolean }
  message: string
  detail: string
  resolution: string | null
  resolved_at: string | null
}

export interface CheckRun {
  id: string
  revision: number
  target_platform: Platform
  fact_status: 'pending' | 'done' | 'failed' | 'skipped'
  completed_at: string | null
  created_at: string
  stale: boolean
  items: CheckItem[]
  total: number
  confirmed: number
  blocking: number
}

export interface Metric {
  id: string
  work_id: string
  captured_at: string
  reads: number | null
  likes: number | null
  wows: number | null
  favorites: number | null
  comments: number | null
  shares: number | null
  follows_gained: number | null
  note: string
}

export interface BoardRow {
  id: string
  title: string
  status: WorkStatus
  published_at: string | null
  latest: Metric | null
  points: number
}

export interface ReviewReport {
  id: string
  work_ids: string[]
  content: { conclusions: string[]; topic_suggestions: { title: string; angle: string; reason: string }[] }
  adopted: number[]
  created_at: string
}

export interface Provider {
  id: string
  name: string
  base_url: string
  key_mask: string
  models: string[]
  status: 'active' | 'disabled'
  last_test_at: string | null
  last_test_ok: boolean | null
  last_test_result: string
}

export interface ModelRoute {
  task_type: string
  label: string
  provider_id: string | null
  model: string
}

export interface AILimit { enabled: boolean; daily_tokens: number }

export interface WorkspaceRef {
  id: string
  name: string
  role: 'owner' | 'editor'
}

export interface Me {
  username: string
  user_id?: string
  role: 'owner' | 'editor'
  csrf_token: string
  reauth_ok: boolean
  prev_login_at: string | null
  prev_login_ip: string | null
  dev: boolean
  workspace: WorkspaceRef
  workspaces: WorkspaceRef[]
}

export interface WorkspaceInvite {
  id: string
  code: string
  role: 'owner' | 'editor'
  max_uses: number
  used_count: number
  expires_at: string
  revoked_at: string | null
  created_at: string
}

export interface WorkspaceMember {
  user_id: string
  username: string
  role: 'owner' | 'editor'
  status: 'active' | 'disabled'
}

export interface SystemInfo {
  egress_ip: string
  version: string
  dev: boolean
  data_bytes: number
  wechat_backend: string
}
