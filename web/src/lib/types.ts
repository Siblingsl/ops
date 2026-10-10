export type Platform = 'wechat_mp' | 'xhs'
export type ContentFormat = 'long_article' | 'image_note' | 'comic'
export type WorkStatus = 'drafting' | 'checking' | 'reviewing' | 'ready' | 'pushed' | 'packed' | 'published'

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
  is_demo?: boolean
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

export interface CharacterCard {
  id: string
  account_id: string
  name: string
  appearance: string
  personality: string
  catchphrase: string
  ref_asset_id: string | null
  ref_url?: string
  created_at: string
  updated_at: string
}

export interface ComicBubble {
  text: string
  x: number
  y: number
  w: number
  h: number
}

export interface ComicPanel {
  id: string
  position: number
  scene: string
  character_ids: string[]
  action: string
  shot: string
  narration: string
  dialogue: string
  image_prompt: string
  asset_id: string | null
  bubbles?: ComicBubble[]
  created_at: string
  updated_at: string
}

export type MaterialKind = 'experience' | 'opinion' | 'case' | 'data'
export interface Material {
  id: string
  account_id: string | null
  kind: MaterialKind
  content: string
  source: string
  tags: string[]
  valid_until?: string | null
  usage_count?: number
  last_used_at?: string | null
  expired?: boolean
  created_at: string
}

export interface StrategyFields {
  niche: string
  audience: string
  differentiation: string
  persona: string
  pillars: { name: string; desc: string; ratio: number; examples: string[] }[]
  cadence: { per_week: number; days: number[]; format: string }
  stage: 'cold_start' | 'growth' | 'stable'
  goals: string[]
  benchmarks: { name: string; note: string; links: string[] }[]
  keywords: string[]
  taboo: string[]
  hot_enabled: boolean
  blocked_words: string[]
  daily_settings: Record<string, unknown>
}

export interface CrawlSettings {
  mode: string
  level: 'off' | 'conservative' | 'standard'
  limits: { interval_min: number; max_items: number; daily_requests: number; fail_limit: number; pause_hours: number }
  summary_fetch: boolean
  retention_days: number
}
export interface CrawlSource {
  key: string; kind: string; name: string; enabled: boolean; interval_min: number; max_items: number
  config: { url?: string }; workspace_id: string | null; fail_count: number
  paused_until: string | null; last_ok_at: string | null; robots_allow: boolean | null; error: string
}
export interface HotSourcesResult { sources: CrawlSource[]; selected: string[]; enabled: boolean }
export interface HotItem {
  id: string; source_key: string; source_name: string; title: string; url: string; rank: number
  heat: string; summary: string; cluster_id: string | null; first_seen_at: string; last_seen_at: string
}
export interface HotMatch {
  id: string; date: string; hot_item: HotItem; relevance: number; reason: string; angle: string
  risk: string[]; status: 'new' | 'converted' | 'dismissed'; topic_id: string | null
}
export interface AccountHot {
  date: string; enabled: boolean; items: HotMatch[]; paused_sources: string[]; updated_at: string | null
  job_id?: string | null; preparing?: boolean
}
export interface CrawlRun { id: string; source_key: string; started_at: string; requests: number; http_status: number; items: number; error: string }

export interface Strategy extends StrategyFields {
  id: string
  version: number
  status: string
  ai_call_id: string | null
  created_at: string
}

export interface PositioningOption extends StrategyFields {
  fit_reason: string
  risks: string[]
}

export interface StrategyResult { active: Strategy | null; versions: Strategy[] }
export type StrategyChange = { [K in keyof StrategyFields]: { field: K; from: StrategyFields[K]; to: StrategyFields[K]; reason: string } }[keyof StrategyFields]
export interface StrategyRevision { current: Strategy; changes: StrategyChange[]; ai_call_id: string }

export interface PlanSlot {
  id: string
  date: string
  pillar: string
  format: string
  status: 'empty' | 'suggested' | 'adopted'
  suggestion: { title: string; angle: string; reason: string; hot_item_id: string | null; ai_call_id: string | null } | null
  topic_id: string | null
  topic_title: string | null
  topic_status: string | null
  work_id: string | null
}
export interface AccountPlan { from: string; to: string; today: string; has_strategy: boolean; slots: PlanSlot[] }

export interface Topic {
  id: string
  account_id?: string
  title: string
  angle: string
  source: 'manual' | 'ai' | 'review' | 'hot' | 'inbox' | 'plan' | 'daily'
  strategy_pillar: string | null
  hot_item_id: string | null
  status: 'pending' | 'adopted' | 'dropped'
  work_id?: string | null
  created_at: string
  audience?: string
  hook?: string
  needed_materials?: string[]
  format?: string
  planned_date?: string | null
  series_id?: string | null
  score_fit?: number | null
  score_reason?: string
  score_material?: number
  score_novelty?: number
  pinned?: boolean
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
  ai_generated?: boolean
  created_at?: string
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
  panels: ComicPanel[]
  material_ids: string[]
  assets: Asset[]
  human_edit_ratio?: number | null
  draft_maybe_published?: boolean
  topic_audience?: string
  topic_hook?: string
  planned_date?: string | null
  target_chars?: number | null
  post_push_todos?: PostPushTodo[] | null
  title_favorites?: { text: string; style: string }[] | null
  assignee_id?: string | null
  reviewer_id?: string | null
  review_required?: boolean
  reviewed_by?: string | null
  reviewed_at?: string | null
  created_at: string
  updated_at: string
}

export interface PostPushTodo { key: string; label: string; done: boolean }

export interface WorkListItem {
  id: string
  title: string
  status: WorkStatus
  content_format: ContentFormat
  source_work_id: string | null
  source_title: string | null
  derived_count: number
  todos_done?: number
  todos_total?: number
  cover_asset_id: string | null
  first_asset_id: string | null
  char_count: number
  section_count: number
  published_at: string | null
  updated_at: string
  planned_date?: string | null
  assignee_id?: string | null
  target_chars?: number | null
}

export interface CheckItem {
  id: string
  category: 'format' | 'sensitive' | 'fact' | 'ai_disclosure' | 'similarity' | 'ad_law' | 'stale'
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
  content: { conclusions: string[]; topic_suggestions: { title: string; angle: string; reason: string }[]; writing_insights?: string[] }
  adopted: number[]
  remembered?: number[]
  ignored?: number[]
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
  price_per_1k_prompt?: number | null
  price_per_1k_completion?: number | null
}

export interface ModelRoute {
  task_type: string
  label: string
  provider_id: string | null
  model: string
  fallback_provider_id?: string | null
  fallback_model?: string
}

export interface AILimit { enabled: boolean; daily_tokens: number }

export type WorkspaceRole = 'owner' | 'editor' | 'viewer'

export interface WorkspaceRef {
  id: string
  name: string
  role: WorkspaceRole
}

export interface Me {
  username: string
  user_id?: string
  role: WorkspaceRole
  is_system_admin?: boolean
  admin_override?: boolean
  csrf_token: string
  reauth_ok: boolean
  prev_login_at: string | null
  prev_login_ip: string | null
  dev: boolean
  workspace: WorkspaceRef
  workspaces: WorkspaceRef[]
}

export interface AdminUser {
  id: string
  username: string
  is_system_admin: boolean
  disabled_at: string | null
  last_login_at: string | null
  created_at: string
  workspace_count: number
  session_count: number
}

export interface AdminWorkspace {
  id: string
  name: string
  created_at: string
  created_by: string | null
  member_count: number
  account_count: number
}

export interface SystemSettings {
  registration_open: boolean
  maintenance_mode: boolean
}

export interface WorkspaceInvite {
  id: string
  code: string
  role: WorkspaceRole
  max_uses: number
  used_count: number
  expires_at: string
  revoked_at: string | null
  created_at: string
}

export interface WorkspaceMember {
  user_id: string
  username: string
  role: WorkspaceRole
  status: 'active' | 'disabled'
}

export interface SMTPSettings {
  host: string
  port: number
  username: string
  from: string
  has_password: boolean
}

export interface SystemInfo {
  egress_ip: string
  version: string
  dev: boolean
  data_bytes: number
  wechat_backend: string
}

// ---------- V3（10 文档） ----------

export interface Memory {
  id: string
  account_id: string
  kind: 'tone' | 'structure' | 'wording' | 'avoid' | 'fact'
  scope: 'all' | 'draft' | 'title' | 'topic'
  text: string
  status: 'suggested' | 'active' | 'disabled'
  source: string
  evidence: { note?: string; count?: number } | null
  use_count: number
  last_used_at: string | null
  confirmed_at: string | null
  created_at: string
}

export interface AIJob {
  id: string
  account_id: string | null
  work_id: string | null
  section_id: string | null
  task_type: string
  label: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'
  result: unknown
  error: string
  ai_call_id: string | null
  link: string
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface AppNotification {
  id: string
  kind: string
  title: string
  body: string
  link: string
  read_at: string | null
  created_at: string
}

export interface UserPrefs {
  default_variants: 1 | 3
  use_history: boolean
  live_lint: boolean
  ghost_text: boolean
  ghost_key: string
  auto_jump_next_empty: boolean
  focus_default: boolean
  write_ending_first: boolean
  ux_events: boolean
  cost_tier: 'economy' | 'standard' | 'quality'
  saved_views: SavedView[]
}

export interface SavedView { id: string; name: string; page: string; query: string }

export interface NextAction {
  kind: string
  text: string
  action: string
  link: string
  work_id?: string
  score: number
}

export interface HealthItem { key: string; label: string; score: number; max: number; hint: string; link: string }

export interface SeriesNeighbour { topic_id: string; title: string; viewpoint: string; work_id: string | null }
export interface SeriesContext { id: string; name: string; outline: string; position: number; total: number; prev: SeriesNeighbour | null; next: SeriesNeighbour | null }

export interface CalendarItem {
  kind: 'work' | 'topic'
  id: string
  account_id: string
  account_name: string
  platform: Platform
  title: string
  status: string
  date: string
  date_kind: 'planned' | 'published'
  work_id?: string
}

export interface RetrieveHit {
  type: 'material' | 'history'
  id: string
  score: number
  reason: string
  content?: string
  kind?: MaterialKind
  source?: string
  tags?: string[]
  title?: string
  heading?: string
  excerpt?: string
  work_id?: string
}

export interface LintHit { start: number; end: number; word: string; category: string; reason: string; suggestion: string }

export interface PolishIssue { section_id: string; rule: string; message: string; excerpt: string; source: 'rule' | 'ai' }

export interface Variant { label: string; text: string; note?: string }

export interface InboxItem {
  id: string
  account_id: string | null
  content: string
  source: string
  suggestion: InboxSuggestion | null
  status: 'new' | 'converted' | 'dismissed'
  created_at: string
}

export interface InboxSuggestion { as: 'topic' | 'material'; title: string; angle: string; audience: string; kind: string; tags: string[]; reason: string }

export interface Series { id: string; account_id: string; name: string; outline: string; topics: number; created_at: string }

export interface Comment {
  id: string
  work_id: string
  section_id: string | null
  anchor_text: string
  body: string
  author_id: string
  author_name: string
  mentions: string[]
  resolved_at: string | null
  created_at: string
}

export interface ActivityItem { kind: string; actor: string; text: string; target: string; at: string }

export interface SearchHit {
  type: string
  id: string
  title: string
  snippet: string
  account_id: string | null
  account_name: string
  status?: string
  link: string
  score: number
  matched: string[]
  starred: boolean
  updated_at: string
}

export interface StarItem { object_type: string; object_id: string; title: string; account_id: string | null; link: string; created_at: string }

export interface SectionRevision { id: string; content_md: string; origin: string; ai_call_id: string | null; created_by: string | null; created_at: string }

export interface OutlineTemplate { id: string; name: string; structure: string; builtin: boolean }

export interface WeeklyDigest {
  id: string
  week_start: string
  stats: Record<string, number>
  content: { summary?: string; highlights?: string[]; next_week?: string[] } | null
  created_at: string
}

export interface AttrFeature { feature: string; label: string; groups: { value: string; n: number; avg_reads: number; avg_interactions: number }[] }

export interface LibraryAsset extends Asset { account_id: string | null; account_name: string; work_title: string }

export interface EvalCase { id: string; task_type: string; name: string; chars: number; created_at: string }

export interface EvalRun {
  id: string
  case_id: string
  template_version_a: number
  template_version_b: number
  template_a: string
  template_b: string
  output_a: string
  output_b: string
  verdict: 'a_better' | 'b_better' | 'same' | null
  created_at: string
}

export interface CustomTheme {
  base: string
  primary_color: string
  font_size: number
  line_height: number
  paragraph_gap: number
  heading_style: 'plain' | 'underline' | 'bar' | 'block'
  quote_style: 'bar' | 'box' | 'italic'
}

export interface LayoutSuggestion { section_id: string; kind: string; text: string; reason: string }

export interface ReferenceItem {
 id: string; account_id: string; platform: string; url: string; status: 'queued'|'done'|'failed'|'blocked'; title: string; author: string; published_at: string; metrics: Record<string,number>; error: string; queued_at: string; fetched_at: string|null; position: number; expected_at: string|null
 analysis: { title_pattern:string;hook_type:string;structure:string[];angle:string;tags:string[];takeaways:string[] }|null
}
