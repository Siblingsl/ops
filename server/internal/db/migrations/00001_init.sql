-- +goose Up
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE workspace (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE member (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspace(id),
  username         text NOT NULL UNIQUE,
  password_hash    text NOT NULL,
  role             text NOT NULL DEFAULT 'owner',
  totp_secret_enc  bytea,
  failed_logins    int NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  last_login_at    timestamptz,
  last_login_ip    text,
  prev_login_at    timestamptz,
  prev_login_ip    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE session (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id     uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  user_agent    text NOT NULL DEFAULT '',
  ip            text NOT NULL DEFAULT '',
  reauth_until  timestamptz,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_account (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspace(id),
  platform          text NOT NULL CHECK (platform IN ('wechat_mp', 'xhs')),
  name              text NOT NULL,
  content_format    text NOT NULL CHECK (content_format IN ('long_article', 'image_note', 'comic')),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  daily_push_limit  int NOT NULL DEFAULT 3 CHECK (daily_push_limit >= 1),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (platform = 'wechat_mp' AND content_format IN ('long_article', 'comic')) OR
    (platform = 'xhs' AND content_format IN ('image_note', 'comic'))
  )
);

CREATE TABLE wechat_credential (
  account_id         uuid PRIMARY KEY REFERENCES platform_account(id) ON DELETE CASCADE,
  app_id             text NOT NULL,
  app_secret_enc     bytea NOT NULL,
  key_version        int NOT NULL DEFAULT 1,
  last_check_at      timestamptz,
  last_check_ok      boolean,
  last_check_result  text NOT NULL DEFAULT '',
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wechat_token (
  account_id        uuid PRIMARY KEY REFERENCES platform_account(id) ON DELETE CASCADE,
  access_token_enc  bytea NOT NULL,
  key_version       int NOT NULL DEFAULT 1,
  expires_at        timestamptz NOT NULL
);

CREATE TABLE account_profile (
  account_id        uuid PRIMARY KEY REFERENCES platform_account(id) ON DELETE CASCADE,
  positioning_tags  text[] NOT NULL DEFAULT '{}',
  target_audience   text NOT NULL DEFAULT '',
  persona_tone      text NOT NULL DEFAULT '',
  banned_words      text[] NOT NULL DEFAULT '{}',
  style_summary     text NOT NULL DEFAULT '',
  default_theme     text NOT NULL DEFAULT 'ink',
  wechat_defaults   jsonb NOT NULL DEFAULT '{}',
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE style_sample (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES platform_account(id),
  title       text NOT NULL,
  content_md  text NOT NULL,
  char_count  int NOT NULL DEFAULT 0,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX style_sample_account ON style_sample(account_id) WHERE deleted_at IS NULL;

CREATE TABLE material (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id),
  account_id    uuid REFERENCES platform_account(id),
  kind          text NOT NULL CHECK (kind IN ('experience', 'opinion', 'case', 'data')),
  content       text NOT NULL,
  source        text NOT NULL DEFAULT '',
  tags          text[] NOT NULL DEFAULT '{}',
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX material_account ON material(account_id) WHERE deleted_at IS NULL;

CREATE TABLE character_card (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES platform_account(id),
  name          text NOT NULL,
  appearance    text NOT NULL DEFAULT '',
  personality   text NOT NULL DEFAULT '',
  catchphrase   text NOT NULL DEFAULT '',
  ref_asset_id  uuid,
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_call (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid,
  work_id            uuid,
  task_type          text NOT NULL,
  provider           text NOT NULL DEFAULT '',
  model              text NOT NULL DEFAULT '',
  template_version   int NOT NULL DEFAULT 1,
  context_refs       jsonb NOT NULL DEFAULT '{}',
  prompt_tokens      int NOT NULL DEFAULT 0,
  completion_tokens  int NOT NULL DEFAULT 0,
  latency_ms         int NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'ok',
  error              text NOT NULL DEFAULT '',
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_call_created ON ai_call(created_at);

CREATE TABLE review_report (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES platform_account(id),
  work_ids    uuid[] NOT NULL DEFAULT '{}',
  content     jsonb NOT NULL,
  adopted     int[] NOT NULL DEFAULT '{}',
  ai_call_id  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE topic (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES platform_account(id),
  title             text NOT NULL,
  angle             text NOT NULL DEFAULT '',
  source            text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai', 'review')),
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'adopted', 'dropped')),
  review_report_id  uuid REFERENCES review_report(id),
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX topic_account ON topic(account_id) WHERE deleted_at IS NULL;

CREATE TABLE work (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             uuid NOT NULL REFERENCES platform_account(id),
  topic_id               uuid REFERENCES topic(id),
  source_work_id         uuid REFERENCES work(id),
  content_format         text NOT NULL,
  status                 text NOT NULL DEFAULT 'drafting'
                           CHECK (status IN ('drafting', 'checking', 'ready', 'pushed', 'packed', 'published')),
  title                  text NOT NULL DEFAULT '',
  summary                text NOT NULL DEFAULT '',
  viewpoint              text NOT NULL DEFAULT '',
  outline                jsonb NOT NULL DEFAULT '[]',
  outline_confirmed_at   timestamptz,
  theme                  text NOT NULL DEFAULT 'ink',
  cover_asset_id         uuid,
  cover_crops            jsonb,
  wechat_fields          jsonb NOT NULL DEFAULT '{}',
  topics                 text[] NOT NULL DEFAULT '{}',
  wechat_draft_media_id  text,
  wechat_draft_hash      text,
  published_url          text,
  published_at           timestamptz,
  locked                 boolean NOT NULL DEFAULT false,
  revision               int NOT NULL DEFAULT 1,
  source_revision        int,
  deleted_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX work_account ON work(account_id) WHERE deleted_at IS NULL;
CREATE INDEX work_title_trgm ON work USING gin (title gin_trgm_ops);

CREATE TABLE work_section (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id             uuid NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  position            int NOT NULL,
  heading             text NOT NULL DEFAULT '',
  key_point           text NOT NULL DEFAULT '',
  content_md          text NOT NULL DEFAULT '',
  ai_raw_md           text NOT NULL DEFAULT '',
  origin              text NOT NULL DEFAULT 'human' CHECK (origin IN ('ai', 'human', 'mixed')),
  source_section_ids  uuid[] NOT NULL DEFAULT '{}',
  material_ids        uuid[] NOT NULL DEFAULT '{}',
  revision            int NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX work_section_work ON work_section(work_id, position);

CREATE TABLE comic_panel (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id        uuid NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  position       int NOT NULL,
  scene          text NOT NULL DEFAULT '',
  character_ids  uuid[] NOT NULL DEFAULT '{}',
  action         text NOT NULL DEFAULT '',
  shot           text NOT NULL DEFAULT '',
  narration      text NOT NULL DEFAULT '',
  dialogue       text NOT NULL DEFAULT '',
  image_prompt   text NOT NULL DEFAULT '',
  asset_id       uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE work_version (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id     uuid NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  version_no  int NOT NULL,
  snapshot    jsonb NOT NULL,
  reason      text NOT NULL CHECK (reason IN ('auto', 'ai', 'manual', 'check', 'restore')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_id, version_no)
);

CREATE TABLE work_material (
  work_id      uuid NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  material_id  uuid NOT NULL REFERENCES material(id) ON DELETE CASCADE,
  PRIMARY KEY (work_id, material_id)
);

CREATE TABLE asset (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id),
  account_id    uuid REFERENCES platform_account(id),
  work_id       uuid REFERENCES work(id) ON DELETE CASCADE,
  storage_path  text NOT NULL,
  mime          text NOT NULL,
  width         int NOT NULL,
  height        int NOT NULL,
  bytes         int NOT NULL,
  sha256        text NOT NULL,
  position      int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX asset_work ON asset(work_id, position);

CREATE TABLE check_run (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id          uuid NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  revision         int NOT NULL,
  target_platform  text NOT NULL,
  fact_status      text NOT NULL DEFAULT 'pending' CHECK (fact_status IN ('pending', 'done', 'failed', 'skipped')),
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE check_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_run_id  uuid NOT NULL REFERENCES check_run(id) ON DELETE CASCADE,
  category      text NOT NULL CHECK (category IN ('format', 'sensitive', 'fact', 'ai_disclosure', 'similarity', 'ad_law')),
  passed        boolean NOT NULL DEFAULT false,
  fingerprint   text NOT NULL,
  matched_text  text NOT NULL DEFAULT '',
  location      jsonb NOT NULL DEFAULT '{}',
  message       text NOT NULL,
  detail        text NOT NULL DEFAULT '',
  resolution    text CHECK (resolution IN ('modified', 'kept', 'verified', 'acknowledged')),
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX check_item_run ON check_item(check_run_id);

CREATE TABLE push_record (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id         uuid REFERENCES work(id) ON DELETE SET NULL,
  account_id      uuid NOT NULL REFERENCES platform_account(id),
  action          text NOT NULL CHECK (action IN ('add', 'update', 'newspic')),
  status          text NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
  failed_step     text NOT NULL DEFAULT '',
  error_code      text NOT NULL DEFAULT '',
  error_message   text NOT NULL DEFAULT '',
  draft_media_id  text NOT NULL DEFAULT '',
  over_limit      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_record_account_day ON push_record(account_id, created_at);

CREATE TABLE wechat_media_cache (
  account_id  uuid NOT NULL REFERENCES platform_account(id) ON DELETE CASCADE,
  sha256      text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('content_image', 'thumb', 'image')),
  wechat_url  text NOT NULL DEFAULT '',
  media_id    text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, sha256, kind)
);

CREATE TABLE metric_snapshot (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id         uuid NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  captured_at     timestamptz NOT NULL,
  reads           int,
  likes           int,
  wows            int,
  favorites       int,
  comments        int,
  shares          int,
  follows_gained  int,
  note            text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE model_provider (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  base_url          text NOT NULL,
  api_key_enc       bytea NOT NULL,
  key_version       int NOT NULL DEFAULT 1,
  models            text[] NOT NULL DEFAULT '{}',
  status            text NOT NULL DEFAULT 'active',
  last_test_at      timestamptz,
  last_test_ok      boolean,
  last_test_result  text NOT NULL DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE model_route (
  task_type    text PRIMARY KEY,
  provider_id  uuid NOT NULL REFERENCES model_provider(id) ON DELETE CASCADE,
  model        text NOT NULL
);

CREATE TABLE prompt_template (
  task_type   text NOT NULL,
  version     int NOT NULL,
  content     text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_type, version)
);

CREATE TABLE sensitive_word (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id),
  word          text NOT NULL,
  category      text NOT NULL DEFAULT '',
  source        text NOT NULL DEFAULT 'custom' CHECK (source IN ('base', 'custom')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, word)
);

CREATE TABLE audit_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id     uuid,
  action       text NOT NULL,
  target_type  text NOT NULL DEFAULT '',
  target_id    text NOT NULL DEFAULT '',
  result       text NOT NULL DEFAULT 'ok',
  detail       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created ON audit_log(created_at DESC);

CREATE TABLE app_setting (
  key    text PRIMARY KEY,
  value  jsonb NOT NULL
);

-- +goose Down
DROP TABLE app_setting, audit_log, sensitive_word, prompt_template, model_route, model_provider,
  metric_snapshot, wechat_media_cache, push_record, check_item, check_run, asset, work_material,
  work_version, comic_panel, work_section, work, topic, review_report, ai_call, character_card,
  material, style_sample, account_profile, wechat_token, wechat_credential, platform_account,
  session, member, workspace;
