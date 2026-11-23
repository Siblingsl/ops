-- +goose Up
-- P1/P2（docs/41 §3.2、§4.2）：发布 manifest 是发布字段唯一快照；发布任务只是执行台账，公开事实仍由 work 保持唯一真源。
CREATE TABLE publish_manifest (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  account_id uuid NOT NULL REFERENCES platform_account(id),
  work_id uuid NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('wechat_mp','xhs','toutiao')),
  revision int NOT NULL DEFAULT 1 CHECK (revision > 0),
  schema_version int NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  validation jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(validation)='object'),
  validation_state text NOT NULL DEFAULT 'pending'
    CHECK (validation_state IN ('pending','valid','invalid','stale')),
  validated_at timestamptz,
  validator_version text NOT NULL DEFAULT '',
  created_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_id, platform)
);
CREATE INDEX publish_manifest_account ON publish_manifest(account_id, platform, updated_at DESC);

CREATE TABLE publish_manifest_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_id uuid NOT NULL REFERENCES publish_manifest(id) ON DELETE CASCADE,
  revision int NOT NULL CHECK (revision > 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  validation jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(validation)='object'),
  validator_version text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (manifest_id, revision)
);

-- P2（docs/41 §4.2）：一条作品 × 一个平台同时只有一条活动任务。
CREATE TABLE publish_task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  account_id uuid NOT NULL REFERENCES platform_account(id),
  work_id uuid NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('wechat_mp','xhs','toutiao')),
  state text NOT NULL DEFAULT 'ready' CHECK (state IN
    ('ready','queued','filling','filled','awaiting_user','submitted','scheduled','published','failed','not_logged_in','skipped','stopped')),
  state_version int NOT NULL DEFAULT 1 CHECK (state_version > 0),
  mode text NOT NULL DEFAULT 'desktop' CHECK (mode IN ('api','desktop','manual')),
  batch_id uuid,
  attempt int NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts int NOT NULL DEFAULT 2 CHECK (max_attempts BETWEEN 1 AND 5),
  next_retry_at timestamptz,
  plan_at timestamptz,
  platform_schedule_at timestamptz,
  filled_at timestamptz,
  submitted_at timestamptz,
  published_at timestamptz,
  last_error_code text NOT NULL DEFAULT '' CHECK (char_length(last_error_code) <= 80),
  last_error_message text NOT NULL DEFAULT '' CHECK (char_length(last_error_message) <= 500),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  idempotency_key text NOT NULL DEFAULT '',
  created_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_id, platform),
  CHECK (state <> 'scheduled' OR platform_schedule_at IS NOT NULL)
);
CREATE INDEX publish_task_board ON publish_task(workspace_id, state, updated_at DESC);
CREATE INDEX publish_task_retry ON publish_task(next_retry_at) WHERE state IN ('failed','not_logged_in');

CREATE TABLE publish_task_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES publish_task(id) ON DELETE CASCADE,
  from_state text,
  to_state text NOT NULL,
  state_version int NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN
    ('transition','fill','readback','drift','correction','adopt','import','invalidation','retry')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  actor uuid REFERENCES app_user(id) ON DELETE SET NULL,
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, idempotency_key)
);

CREATE TABLE publish_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  account_id uuid NOT NULL REFERENCES platform_account(id),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 100),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','queued','running','completed','stopped','failed')),
  total int NOT NULL DEFAULT 0 CHECK (total >= 0),
  done int NOT NULL DEFAULT 0 CHECK (done >= 0 AND done <= total),
  created_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
-- 发布工程表一旦有数据，回滚会丢失 manifest/任务/批次证据；拒滚并提示前滚修复。
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM publish_manifest) OR EXISTS (SELECT 1 FROM publish_manifest_revision)
     OR EXISTS (SELECT 1 FROM publish_task) OR EXISTS (SELECT 1 FROM publish_task_event)
     OR EXISTS (SELECT 1 FROM publish_batch) THEN
    RAISE EXCEPTION '发布工程表已有数据，拒绝回滚丢弃；请保留数据并前滚修复';
  END IF;
END;
$$;
-- +goose StatementEnd
DROP TABLE publish_task_event;
DROP TABLE publish_task;
DROP TABLE publish_batch;
DROP TABLE publish_manifest_revision;
DROP TABLE publish_manifest;
