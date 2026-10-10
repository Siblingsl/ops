-- +goose Up
-- D-046 V3：智能底座（上下文、记忆、反馈、检索、任务、降级）、交互底座（通知、撤销）与模块增量。

ALTER TABLE ai_call ADD COLUMN IF NOT EXISTS workspace_id uuid;
CREATE INDEX IF NOT EXISTS ai_call_ws ON ai_call(workspace_id, created_at);

CREATE TABLE account_memory (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES platform_account(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('tone', 'structure', 'wording', 'avoid', 'fact')),
  scope         text NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'draft', 'title', 'topic')),
  text          text NOT NULL,
  status        text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'active', 'disabled')),
  source        text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'instruction', 'edit_diff', 'rejection', 'review', 'breakdown')),
  evidence      jsonb NOT NULL DEFAULT '{}',
  use_count     int NOT NULL DEFAULT 0,
  last_used_at  timestamptz,
  created_by    uuid,
  confirmed_by  uuid,
  confirmed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_memory_account ON account_memory(account_id, status);

CREATE TABLE ai_feedback (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_call_id    uuid NOT NULL UNIQUE,
  workspace_id  uuid,
  task_type     text NOT NULL DEFAULT '',
  outcome       text CHECK (outcome IN ('accepted', 'rejected', 'edited', 'regenerated')),
  choice_index  int,
  edit_ratio    numeric,
  rating        smallint CHECK (rating IN (-1, 0, 1)),
  reason_tags   text[] NOT NULL DEFAULT '{}',
  note          text NOT NULL DEFAULT '',
  user_id       uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_feedback_ws ON ai_feedback(workspace_id, created_at);

CREATE TABLE ai_job (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  account_id    uuid,
  work_id       uuid,
  section_id    uuid,
  task_type     text NOT NULL,
  label         text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  input         jsonb NOT NULL DEFAULT '{}',
  result        jsonb,
  partial       text NOT NULL DEFAULT '',
  error         text NOT NULL DEFAULT '',
  ai_call_id    uuid,
  link          text NOT NULL DEFAULT '',
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
CREATE INDEX ai_job_ws ON ai_job(workspace_id, created_at DESC);
CREATE INDEX ai_job_section ON ai_job(section_id) WHERE section_id IS NOT NULL;

ALTER TABLE model_route
  ADD COLUMN IF NOT EXISTS fallback_provider_id uuid REFERENCES model_provider(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS fallback_model text NOT NULL DEFAULT '';

CREATE TABLE content_embedding (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  object_type   text NOT NULL CHECK (object_type IN ('material', 'section')),
  object_id     uuid NOT NULL,
  chunk_no      int NOT NULL DEFAULT 0,
  content_hash  text NOT NULL,
  model         text NOT NULL DEFAULT '',
  embedding     real[] NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (object_type, object_id, chunk_no)
);
CREATE INDEX content_embedding_ws ON content_embedding(workspace_id, object_type);

ALTER TABLE material ADD COLUMN IF NOT EXISTS valid_until date;
CREATE INDEX IF NOT EXISTS material_content_trgm ON material USING gin (content gin_trgm_ops);

CREATE TABLE notification (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  title         text NOT NULL,
  body          text NOT NULL DEFAULT '',
  link          text NOT NULL DEFAULT '',
  dedupe_key    text,
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_user ON notification(user_id, workspace_id, created_at DESC);
CREATE UNIQUE INDEX notification_dedupe ON notification(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

ALTER TABLE work
  ADD COLUMN IF NOT EXISTS planned_date date,
  ADD COLUMN IF NOT EXISTS target_chars int,
  ADD COLUMN IF NOT EXISTS post_push_todos jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS assignee_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS review_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE work DROP CONSTRAINT IF EXISTS work_status_check;
ALTER TABLE work ADD CONSTRAINT work_status_check
  CHECK (status IN ('drafting', 'checking', 'reviewing', 'ready', 'pushed', 'packed', 'published'));

CREATE TABLE topic_series (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES platform_account(id) ON DELETE CASCADE,
  name        text NOT NULL,
  outline     text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE topic
  ADD COLUMN IF NOT EXISTS planned_date date,
  ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS hook text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS needed_materials text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS format text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS series_id uuid REFERENCES topic_series(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS score_fit int,
  ADD COLUMN IF NOT EXISTS score_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS scored_at timestamptz;

CREATE TABLE inbox_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  account_id    uuid REFERENCES platform_account(id) ON DELETE SET NULL,
  content       text NOT NULL,
  source        text NOT NULL DEFAULT 'quick' CHECK (source IN ('quick', 'share', 'palette', 'mobile')),
  suggestion    jsonb,
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'converted', 'dismissed')),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inbox_item_ws ON inbox_item(workspace_id, status, created_at DESC);

CREATE TABLE copilot_message (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id        uuid NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  role           text NOT NULL CHECK (role IN ('user', 'assistant')),
  content        text NOT NULL,
  context_scope  text NOT NULL DEFAULT 'section' CHECK (context_scope IN ('section', 'selection', 'work')),
  section_id     uuid,
  ai_call_id     uuid,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX copilot_message_work ON copilot_message(work_id, created_at);

ALTER TABLE work_section
  ADD COLUMN IF NOT EXISTS source_revisions jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS ai_call_id uuid;

CREATE TABLE section_revision (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id  uuid NOT NULL REFERENCES work_section(id) ON DELETE CASCADE,
  content_md  text NOT NULL,
  origin      text NOT NULL,
  ai_call_id  uuid,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX section_revision_section ON section_revision(section_id, created_at DESC);

CREATE TABLE comment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id      uuid NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  section_id   uuid,
  anchor_text  text NOT NULL DEFAULT '',
  body         text NOT NULL,
  author_id    uuid NOT NULL,
  mentions     uuid[] NOT NULL DEFAULT '{}',
  resolved_at  timestamptz,
  resolved_by  uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comment_work ON comment(work_id, created_at);

CREATE TABLE prompt_eval_case (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  task_type         text NOT NULL,
  name              text NOT NULL,
  context_snapshot  jsonb NOT NULL,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE prompt_eval_run (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id             uuid NOT NULL REFERENCES prompt_eval_case(id) ON DELETE CASCADE,
  template_version_a  int NOT NULL DEFAULT 0,
  template_version_b  int NOT NULL DEFAULT 0,
  template_a          text NOT NULL DEFAULT '',
  template_b          text NOT NULL DEFAULT '',
  output_a            text NOT NULL DEFAULT '',
  output_b            text NOT NULL DEFAULT '',
  verdict             text CHECK (verdict IN ('b_better', 'a_better', 'same')),
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS preferences jsonb NOT NULL DEFAULT '{}';

ALTER TABLE model_provider
  ADD COLUMN IF NOT EXISTS price_per_1k_prompt numeric,
  ADD COLUMN IF NOT EXISTS price_per_1k_completion numeric;

ALTER TABLE check_item DROP CONSTRAINT IF EXISTS check_item_category_check;
ALTER TABLE check_item ADD CONSTRAINT check_item_category_check
  CHECK (category IN ('format', 'sensitive', 'fact', 'ai_disclosure', 'similarity', 'ad_law', 'stale'));

ALTER TABLE account_profile ADD COLUMN IF NOT EXISTS custom_theme jsonb;
ALTER TABLE platform_account ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE asset ADD COLUMN IF NOT EXISTS origin_asset_id uuid;

CREATE TABLE star (
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  object_type   text NOT NULL CHECK (object_type IN ('work', 'material', 'topic')),
  object_id     uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, object_type, object_id)
);

CREATE TABLE weekly_digest (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES platform_account(id) ON DELETE CASCADE,
  week_start  date NOT NULL,
  stats       jsonb NOT NULL DEFAULT '{}',
  content     jsonb NOT NULL DEFAULT '{}',
  ai_call_id  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, week_start)
);

CREATE TABLE ux_event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  workspace_id uuid,
  event        text NOT NULL,
  target_type  text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ux_event_created ON ux_event(created_at);

ALTER TABLE review_report ADD COLUMN IF NOT EXISTS remembered int[] NOT NULL DEFAULT '{}';
ALTER TABLE check_item ADD COLUMN IF NOT EXISTS resolved_by uuid;
ALTER TABLE topic DROP CONSTRAINT IF EXISTS topic_source_check;
ALTER TABLE topic ADD CONSTRAINT topic_source_check CHECK (source IN ('manual', 'ai', 'review', 'hot', 'inbox'));

CREATE TABLE job_marker (
  key         text PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE IF EXISTS job_marker, ux_event, weekly_digest, star, prompt_eval_run, prompt_eval_case, comment,
  section_revision, copilot_message, inbox_item, notification, content_embedding, ai_job, ai_feedback, account_memory;
ALTER TABLE review_report DROP COLUMN IF EXISTS remembered;
ALTER TABLE check_item DROP COLUMN IF EXISTS resolved_by;
UPDATE topic SET source='manual' WHERE source='inbox';
ALTER TABLE topic DROP CONSTRAINT IF EXISTS topic_source_check;
ALTER TABLE topic ADD CONSTRAINT topic_source_check CHECK (source IN ('manual', 'ai', 'review', 'hot'));
ALTER TABLE asset DROP COLUMN IF EXISTS origin_asset_id;
ALTER TABLE platform_account DROP COLUMN IF EXISTS is_demo;
ALTER TABLE account_profile DROP COLUMN IF EXISTS custom_theme;
ALTER TABLE check_item DROP CONSTRAINT IF EXISTS check_item_category_check;
ALTER TABLE check_item ADD CONSTRAINT check_item_category_check
  CHECK (category IN ('format', 'sensitive', 'fact', 'ai_disclosure', 'similarity', 'ad_law'));
ALTER TABLE model_provider DROP COLUMN IF EXISTS price_per_1k_prompt, DROP COLUMN IF EXISTS price_per_1k_completion;
ALTER TABLE app_user DROP COLUMN IF EXISTS preferences;
ALTER TABLE work_section DROP COLUMN IF EXISTS source_revisions, DROP COLUMN IF EXISTS deleted_at, DROP COLUMN IF EXISTS ai_call_id;
ALTER TABLE topic DROP COLUMN IF EXISTS planned_date, DROP COLUMN IF EXISTS audience, DROP COLUMN IF EXISTS hook,
  DROP COLUMN IF EXISTS needed_materials, DROP COLUMN IF EXISTS format, DROP COLUMN IF EXISTS series_id,
  DROP COLUMN IF EXISTS score_fit, DROP COLUMN IF EXISTS score_reason, DROP COLUMN IF EXISTS scored_at;
DROP TABLE IF EXISTS topic_series;
UPDATE work SET status='ready' WHERE status='reviewing';
ALTER TABLE work DROP CONSTRAINT IF EXISTS work_status_check;
ALTER TABLE work ADD CONSTRAINT work_status_check
  CHECK (status IN ('drafting', 'checking', 'ready', 'pushed', 'packed', 'published'));
ALTER TABLE work DROP COLUMN IF EXISTS planned_date, DROP COLUMN IF EXISTS target_chars, DROP COLUMN IF EXISTS post_push_todos,
  DROP COLUMN IF EXISTS assignee_id, DROP COLUMN IF EXISTS review_required, DROP COLUMN IF EXISTS reviewed_by, DROP COLUMN IF EXISTS reviewed_at;
DROP INDEX IF EXISTS material_content_trgm;
ALTER TABLE material DROP COLUMN IF EXISTS valid_until;
ALTER TABLE model_route DROP COLUMN IF EXISTS fallback_provider_id, DROP COLUMN IF EXISTS fallback_model;
DROP INDEX IF EXISTS ai_call_ws;
ALTER TABLE ai_call DROP COLUMN IF EXISTS workspace_id;
