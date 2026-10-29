export type Platform = 'wechat_mp' | 'xhs' | 'toutiao'
// D-048 首批账号类型（90 文档第 9 节）：预设类型决定真实工作流；账号类型可在同平台内迁移（D-123）。
export type ContentFormat = 'long_article' | 'image_note' | 'comic' | 'qa_article' | 'briefing' | 'list_note' | 'card_post' | 'script' | 'micro_post'
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
  type_note: string
  status: 'active' | 'disabled'
  daily_push_limit: number
  created_at: string
  is_demo?: boolean
  credential?: CredState
  datacube_state?: DatacubeState
  metrics_wechat_auto?: WechatAuto
}

export type DatacubeState = 'ok' | 'no_permission' | 'unknown'

/** 平台连接可用性（20 文档 §5.2）：全文“可用”均指 availability='ready'。 */
export type PlatformAvailability =
  | 'unknown' | 'login_required' | 'verifying' | 'ready' | 'challenge_required'
  | 'restricted' | 'identity_mismatch' | 'degraded' | 'unsupported'

/** 平台数据连接摘要（20 文档 §11.2）：不包含凭据或本机路径。 */
export interface PlatformConnection {
  id: string
  account_id: string
  platform: 'wechat_mp' | 'xhs'
  is_holder?: boolean
  state: 'active' | 'paused' | 'revoked'
  availability: PlatformAvailability
  external_account_key: string
  auto_collect: boolean
  auto_adopt: boolean
  last_verified_at: string | null
  last_seen_at: string | null
  next_due_at: string | null
  failure_count: number
  authorization_revision: number
  adoption_revision: number
  platform_consent_version: number
  consented_at: string | null
  sync_capabilities?: {
    catalog: 'supported' | 'denied' | 'unknown' | 'temporarily_unavailable' | 'unsupported'
    content: 'supported' | 'denied' | 'unknown' | 'temporarily_unavailable' | 'unsupported'
    metrics: 'supported' | 'denied' | 'unknown' | 'temporarily_unavailable' | 'unsupported'
  }
}

export interface PlatformSyncCoverageStage {
  state?: string
  reason?: string | null
  incomplete_reason?: string | null
  pages_read?: number
  has_more?: boolean
  retryable?: boolean
  total_count?: number | null
  discovered?: number
  succeeded?: number
  failed?: number
  pending?: number
  consistency?: string
  [key: string]: unknown
}

export interface PlatformSyncCoverage {
  state?: string
  reason?: string | null
  pages_read?: number
  has_more?: boolean
  incomplete_reason?: string | null
  retryable?: boolean
  total_count?: number | null
  discovered?: number
  succeeded?: number
  failed?: number
  pending?: number
  consistency?: string
  [stage: string]: PlatformSyncCoverageStage | number | boolean | string | null | undefined
}

export interface PlatformSyncOperation {
  id: string
  kind: 'account_sync' | 'metrics_refresh'
  effective_mode: string
  revision: number
  status: 'queued' | 'running' | 'paused' | 'waiting_budget' | 'waiting_device' | 'waiting_login' | 'succeeded' | 'partial' | 'failed' | 'canceled'
  stage: string
  account_id: string
  connection_id: string
  created_at: string
  scope_upper_bound: string | null
  expires_at: string | null
  next_allowed_at: string | null
  pause_reason: string | null
  coverage: PlatformSyncCoverage
  counters: Record<string, number>
  last_error: { code: string } | null
  available_actions: Array<'pause' | 'resume' | 'cancel'>
}

export interface PlatformSyncOperationItem {
  platform_work_id: string
  external_id: string
  title: string
  content_state: string
  initial_metrics_state?: string
  error_code: string | null
  last_seen_at: string
  content_observed_at: string | null
}

export interface PlatformWorkMirrorListItem {
  id: string
  external_id: string
  remote_content_type: 'image_note' | 'video_note' | 'wechat_article' | 'toutiao_article' | 'toutiao_micro_post' | 'unknown'
  remote_status: 'published' | 'draft' | 'reviewing' | 'hidden' | 'deleted' | 'unknown'
  title: string
  summary: string
  cover_ref: string | null
  canonical_url: string | null
  published_at: string | null
  remote_updated_at: string | null
  content_state: string
  content_error_code: string | null
  field_coverage: Record<string, string>
  last_seen_at: string
  content_observed_at: string | null
  revision: number
  created_at: string
  is_bound: boolean
  latest_metric_as_of_at: string | null
  latest_metric_observed_at: string | null
}

export interface PlatformWorkMirror extends PlatformWorkMirrorListItem {
  account_id: string
  platform: 'wechat_mp' | 'xhs'
  external_account_key: string
  author_display?: string
  body_text: string
  body_structure: Array<{ type: string; text?: string; media_index?: number; level?: number }>
  topics: string[]
  tags: string[]
  media_refs: Array<{ kind: string; url: string; position: number; width?: number; height?: number; duration_seconds?: number }>
  content_hash: string | null
  content_revision: number
  content_observed_at: string | null
  bindings: Array<{ work_id: string; title: string; status: WorkStatus; published_at: string | null; binding_revision: number; publish_revision: number | null }>
  metric_observations: PlatformObservation[]
}

export interface PlatformWorkMirrorPage {
  items: PlatformWorkMirrorListItem[]
  next_cursor: string | null
}

export interface PlatformAccountSnapshot {
  account_id: string
  display_name: string | null
  public_account_id: string | null
  avatar_ref: string | null
  bio: string | null
  verified_type: string | null
  remote_account_type: string | null
  safe_fields: Record<string, string>
  field_states: Record<string, string>
  revision: number
  observed_at: string
}

/** 最小观测（20 文档 §8.1）：页面只读展示，不返回原始网络数据。 */
export interface PlatformObservation {
  id: string
  external_id: string | null
  scope: 'account' | 'work'
  source: MetricSource
  observed_at: string
  as_of_at: string | null
  quality_state: 'valid' | 'needs_confirmation' | 'rejected' | 'superseded'
  match_state: 'not_applicable' | 'bound' | 'unmatched' | 'ignored'
  adapter_version: string
  mapping_version: number
  values: Record<string, { value: number; precision: string; unit: MetricUnit }>
  field_paths: Record<string, string>
}

/** 公众号数据接口每日后台只读同步（DEV-DR06） */
export interface WechatAuto {
  enabled: boolean
  fails: number
  last_at?: string
  note?: string
}

export interface FollowerDay {
  date: string
  source: 'wechat_api' | 'manual'
  new_follow: number | null
  cancel_follow: number | null
  net: number | null
  cumulate: number | null
}

export interface FollowerList {
  days: FollowerDay[]
  api: boolean
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

export type MaterialPreview = Omit<Material, 'account_id' | 'source'> & { shared?: boolean; source?: string }

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
 sources?: {name:string;rank:number;url:string}[]
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
  hot_alternative?: HotMatch
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

export interface TopicPage {
  items: Topic[]
  status_counts: { pending: number; adopted: number; dropped: number }
  next_cursor: string | null
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
  alt_text: string
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
  tags: string[]
  wechat_draft_media_id: string | null
  published_url: string | null
  published_at: string | null
  publish_revision: number
  // 平台绑定（20 文档 §7.1）：external_id 按平台从 wechat_msgid/xhs_note_id 派生。
  external_id?: string | null
  metric_binding_revision: number
  metric_binding_confirmed_at?: string | null
  platform_binding_source?: 'user_link' | 'user_confirm' | 'official_exact' | 'legacy_title' | null
  platform_binding_verified_at?: string | null
  platform_source_mirror_id?: string | null
  platform_source_content_revision?: number | null
  platform_source_mirror_revision?: number | null
  locked: boolean
  revision: number
  sections: Section[]
  panels: ComicPanel[]
  cards?: WorkCard[]
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

// D-048 图文卡片：卡片 = 段落（标题与正文）+ 逐卡 AI 配图。
export interface WorkCard {
  id: string
  section_id: string
  position: number
  heading: string
  body: string
  image_asset_id?: string | null
  image_url?: string
  created_at: string
  updated_at: string
}

export interface WorkListItem {
  id: string
  title: string
  tags: string[]
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
  location: { field?: string; label?: string; section_id?: string; found?: boolean; material_support?: { material_id: string; quote: string } }
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
  material_basis_stale: boolean
  material_basis_unavailable: number
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
  impressions: number | null
  impressions_exact?: string | null
  ctr: number | null
  likes: number | null
  wows: number | null
  favorites: number | null
  comments: number | null
  shares: number | null
  follows_gained: number | null
  note: string
  source: MetricSource
  day_offset: number | null
  external_id: string | null
  revision: number
  // 口径与质量（20 文档 §9.1）：单位未知时不得与人数/次数聚合。
  read_unit: MetricUnit
  share_unit: MetricUnit
  quality_state: 'approved' | 'held' | 'superseded'
  observation_id: string | null
  observed_at: string | null
  as_of_at: string | null
  metric_meta: Record<string, unknown>
  ctr_unavailable?: string
}

export type MetricUnit = 'users' | 'times' | 'unknown'

export type MetricSource = 'manual' | 'paste' | 'file' | 'wechat_api' | 'screenshot' | 'wechat_browser' | 'xhs_browser'

export interface BoardRow {
  id: string
  title: string
  content_format: string
  status: WorkStatus
  published_at: string | null
  d7: Metric | null
  nodes: number[]
  points: number
}

export interface ReviewReport {
  id: string
  work_ids: string[]
  content: { content_format?: ContentFormat; conclusions: string[]; topic_suggestions: { title: string; angle: string; reason: string }[]; writing_insights?: string[] }
  adopted: number[]
  remembered?: number[]
  ignored?: number[]
  origin?: 'manual' | 'weekly_draft'
  created_at: string
}

export interface Provider {
  id: string
  name: string
  base_url: string
  key_mask: string
  models: string[]
  status: 'active' | 'disabled'
  circuit_state: 'closed' | 'open' | 'half_open'
  retry_after_seconds: number
  last_test_at: string | null
  last_test_ok: boolean | null
  last_test_result: string
  price_per_1k_prompt?: number | null
  price_per_1k_completion?: number | null
  capabilities?: ModelCapability[]
}

export interface ModelCapability {
  model: string
  tools_ok: boolean | null
  vision_ok: boolean | null
  tested_at: string | null
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
  session_expires_at: string
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
  /** 平台采集总开关（20 文档 §17.3）：与部署配置任一关闭即停。 */
  platform_kill_switch: boolean
  /** 每平台同步能力开关（20 文档 §21.15）：默认关闭，验收通过后由超管按平台打开。 */
  platform_features: {
    account_sync: Record<'xhs' | 'wechat_mp', boolean>
    metrics_refresh: Record<'xhs' | 'wechat_mp', boolean>
  }
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
  evidence: { note?: string; count?: number; pairs?: number; rejections?: number } | null
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
  agent_privacy_notice_seen?: boolean
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
  content_format: ContentFormat | ''
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

export interface InboxPage { items: InboxItem[]; total: number; next_cursor: string | null }

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
  platform?: Platform
  content_format?: ContentFormat
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

// DEV-416 / D-140：创作模板是唯一的"模板"概念（结构 + 语气 + 段落区间 + 提示词补充）。
export interface TemplateStep { heading: string; key_point: string; role?: string }
export interface CreationTemplate {
  id: string
  content_format: ContentFormat
  name: string
  builtin: boolean
  structure: TemplateStep[]
  prompt_addon: string
  section_min: number
  section_max: number
  tone: string
  updated_at?: string
}

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

export interface DailyItem {
 title:string;angle:string;audience:string;hook:string;needed_materials:string[];format:string;reason:string;primary:boolean
 basis:{type:'slot'|'pillar'|'hot'|'material'|'review'|'topic';id?:string;name?:string;url:string}[]
 action?:'adopted'|'started'|'dismissed';topic_id?:string;work_id?:string
}
export interface DailyRecommendation {id:string;date:string;version:number;items:DailyItem[];ai_call_id:string;generated_at:string;trigger:string}
export interface DailyResult {date:string;recommendation:DailyRecommendation|null;preparing:boolean;job_id?:string;new_hot?:boolean}

export interface HotTrend {id:string;title:string;first_seen_at:string;last_seen_at:string;sources:{name:string;rank:number;url:string}[];points:{at:string;rank:number;source:string}[];writing:{account:string;work_id:string;title:string}[]}

export interface DailyStatsResult {content_format?:ContentFormat;total:number;adopted:number;rate:number;sources:{type:string;total:number;adopted:number;rate:number;reduced:boolean;published:number;avg_reads:number|null;avg_likes:number|null}[];performance:{recommended:boolean;works:number;avg_reads:number|null;avg_likes:number|null}[]}

export interface SourceHealthWindow { runs: number; successful: number; success_rate: number | null; items: number; matches: number; converted: number; adopted: number }
export interface SourceHealthRow { key: string; name: string; days_7: SourceHealthWindow; days_30: SourceHealthWindow }
export interface CrawlHealth { sources: SourceHealthRow[]; generated_at: string; retention_days: number }
