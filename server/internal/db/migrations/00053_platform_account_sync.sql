-- D-133 / DEV-AS01：保存本人平台资料、作品镜像与同步意图。
-- 平台作品与本地 work 分开；平台计数仍只写 platform_metric_observation。

-- +goose Up
ALTER TABLE platform_connection
  ADD CONSTRAINT platform_connection_sync_scope_ref
  UNIQUE (id, workspace_id, account_id, platform),
  ADD CONSTRAINT platform_connection_sync_actor_ref
  UNIQUE (id, workspace_id, account_id, platform, user_id, device_id),
  ADD CONSTRAINT platform_connection_sync_identity_ref
  UNIQUE (id, workspace_id, account_id, platform, external_account_key);

CREATE TABLE platform_sync_operation (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  account_id                    uuid NOT NULL,
  platform                      text NOT NULL CHECK (platform IN ('wechat_mp', 'xhs', 'toutiao')),
  connection_id                 uuid NOT NULL,
  requested_by                  uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  device_id                     uuid NOT NULL,
  kind                          text NOT NULL CHECK (kind IN ('account_sync', 'metrics_refresh')),
  requested_mode                text NOT NULL CHECK (requested_mode IN ('incremental', 'full_reconcile', 'due_and_recent', 'explicit')),
  effective_mode                text NOT NULL CHECK (effective_mode IN ('initial', 'incremental', 'full_reconcile', 'due_and_recent', 'explicit')),
  status                        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'paused', 'waiting_budget', 'waiting_device', 'waiting_login', 'partial', 'succeeded', 'failed', 'canceled', 'expired')),
  stage                         text NOT NULL DEFAULT 'queued' CHECK (stage IN ('queued', 'profile', 'catalog', 'content', 'metrics', 'complete')),
  revision                      bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  authorization_revision        bigint NOT NULL CHECK (authorization_revision > 0),
  workspace_authorization_revision bigint NOT NULL CHECK (workspace_authorization_revision > 0),
  platform_consent_version      int NOT NULL CHECK (platform_consent_version > 0),
  frozen_scope                  jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(frozen_scope) = 'object'),
  checkpoint                    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checkpoint) = 'object'),
  counters                      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counters) = 'object'),
  coverage                      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(coverage) = 'object'),
  request_receipts              jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(request_receipts) = 'array' AND jsonb_array_length(request_receipts) <= 1000),
  expires_at                    timestamptz,
  next_allowed_at               timestamptz,
  pause_reason                  text,
  last_error_code               text,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  started_at                    timestamptz,
  finished_at                   timestamptz,
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_sync_operation_account_scope_fk
    FOREIGN KEY (account_id, workspace_id, platform)
    REFERENCES platform_account (id, workspace_id, platform) ON DELETE CASCADE,
  CONSTRAINT platform_sync_operation_connection_scope_fk
    FOREIGN KEY (connection_id, workspace_id, account_id, platform, requested_by, device_id)
    REFERENCES platform_connection (id, workspace_id, account_id, platform, user_id, device_id) ON DELETE CASCADE,
  CONSTRAINT platform_sync_operation_kind_mode_check CHECK (
    (kind = 'account_sync' AND requested_mode IN ('incremental', 'full_reconcile') AND effective_mode IN ('initial', 'incremental', 'full_reconcile')) OR
    (kind = 'metrics_refresh' AND requested_mode IN ('due_and_recent', 'explicit') AND effective_mode IN ('due_and_recent', 'explicit'))
  ),
  CONSTRAINT platform_sync_operation_scope_ref UNIQUE (id, workspace_id, account_id, connection_id)
);

CREATE INDEX platform_sync_operation_account_created
  ON platform_sync_operation (account_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX platform_sync_operation_account_sync_active
  ON platform_sync_operation (account_id)
  WHERE kind = 'account_sync' AND status IN ('queued', 'running', 'paused', 'waiting_budget', 'waiting_device', 'waiting_login');

CREATE TABLE platform_account_snapshot (
  account_id             uuid PRIMARY KEY,
  workspace_id           uuid NOT NULL,
  platform               text NOT NULL CHECK (platform IN ('wechat_mp', 'xhs', 'toutiao')),
  external_account_key   text NOT NULL CHECK (external_account_key ~ '^(wechat_biz|xhs_user_id|toutiao_creator):.+'),
  connection_id          uuid NOT NULL,
  display_name           text,
  public_account_id      text,
  avatar_ref             text,
  bio                    text,
  verified_type          text,
  remote_account_type    text,
  safe_fields            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(safe_fields) = 'object'),
  field_states           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(field_states) = 'object'),
  revision               bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  observed_at            timestamptz NOT NULL,
  source_run_id          uuid REFERENCES platform_sync_run(id) ON DELETE SET NULL,
  adapter_version        text NOT NULL DEFAULT '',
  mapping_version        int NOT NULL DEFAULT 1 CHECK (mapping_version > 0),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_account_snapshot_account_scope_fk
    FOREIGN KEY (account_id, workspace_id, platform)
    REFERENCES platform_account (id, workspace_id, platform) ON DELETE CASCADE,
  CONSTRAINT platform_account_snapshot_connection_scope_fk
    FOREIGN KEY (connection_id, workspace_id, account_id, platform, external_account_key)
    REFERENCES platform_connection (id, workspace_id, account_id, platform, external_account_key) ON DELETE CASCADE
);

CREATE TABLE platform_work_mirror (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               uuid NOT NULL,
  account_id                 uuid NOT NULL,
  platform                   text NOT NULL CHECK (platform IN ('wechat_mp', 'xhs', 'toutiao')),
  external_account_key       text NOT NULL CHECK (external_account_key ~ '^(wechat_biz|xhs_user_id|toutiao_creator):.+'),
  external_id                text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 512),
  remote_content_type        text NOT NULL CHECK (remote_content_type IN ('image_note', 'video_note', 'wechat_article', 'toutiao_article', 'toutiao_micro_post', 'unknown')),
  remote_status              text NOT NULL DEFAULT 'unknown' CHECK (remote_status IN ('published', 'draft', 'reviewing', 'hidden', 'deleted', 'unknown')),
  title                      text NOT NULL DEFAULT '',
  body_text                  text NOT NULL DEFAULT '',
  body_structure             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(body_structure) = 'array'),
  summary                    text NOT NULL DEFAULT '',
  author_display             text NOT NULL DEFAULT '',
  topics                     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(topics) = 'array'),
  tags                       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tags) = 'array'),
  cover_ref                  text,
  media_refs                 jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(media_refs) = 'array'),
  canonical_url              text,
  published_at               timestamptz,
  remote_updated_at           timestamptz,
  content_hash               text CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  content_revision           int NOT NULL DEFAULT 0 CHECK (content_revision >= 0),
  revision                   bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  field_coverage             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(field_coverage) = 'object'),
  content_state              text NOT NULL DEFAULT 'unknown' CHECK (content_state IN ('complete', 'partial', 'unsupported', 'denied', 'not_requested', 'failed', 'unknown')),
  content_error_code         text,
  content_observed_at        timestamptz,
  last_seen_at               timestamptz NOT NULL DEFAULT now(),
  last_sync_operation_id     uuid REFERENCES platform_sync_operation(id) ON DELETE SET NULL,
  source_run_id              uuid REFERENCES platform_sync_run(id) ON DELETE SET NULL,
  initial_metrics_state      text NOT NULL DEFAULT 'not_started' CHECK (initial_metrics_state IN ('not_started', 'complete', 'partial', 'unsupported', 'denied', 'failed')),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_work_mirror_account_scope_fk
    FOREIGN KEY (account_id, workspace_id, platform)
    REFERENCES platform_account (id, workspace_id, platform) ON DELETE CASCADE,
  CONSTRAINT platform_work_mirror_identity_uniq
    UNIQUE (workspace_id, account_id, platform, external_id)
);

CREATE INDEX platform_work_mirror_account_published
  ON platform_work_mirror (account_id, published_at DESC NULLS LAST, id DESC);
CREATE INDEX platform_work_mirror_operation_content
  ON platform_work_mirror (account_id, last_sync_operation_id, content_state, id);
ALTER TABLE platform_work_mirror
  ADD CONSTRAINT platform_work_mirror_observation_scope_ref UNIQUE (id, workspace_id, account_id);

ALTER TABLE platform_sync_run
  ADD COLUMN operation_id uuid,
  ADD COLUMN wire_protocol_version int NOT NULL DEFAULT 1 CHECK (wire_protocol_version IN (1, 2)),
  ADD COLUMN operation_stage text NOT NULL DEFAULT '' CHECK (operation_stage IN ('', 'profile', 'catalog', 'content', 'metrics'));
ALTER TABLE platform_sync_run DROP CONSTRAINT platform_sync_run_task_kind_check;
ALTER TABLE platform_sync_run ADD CONSTRAINT platform_sync_run_task_kind_check
  CHECK (task_kind IN ('probe', 'discover', 'collect', 'account_sync', 'content'));
ALTER TABLE platform_sync_run
  ADD CONSTRAINT platform_sync_run_operation_scope_fk
  FOREIGN KEY (operation_id, workspace_id, account_id, connection_id)
  REFERENCES platform_sync_operation (id, workspace_id, account_id, connection_id) ON DELETE CASCADE;
CREATE INDEX platform_sync_run_operation_created
  ON platform_sync_run (operation_id, created_at, id) WHERE operation_id IS NOT NULL;

ALTER TABLE platform_metric_observation
  ADD COLUMN platform_work_id uuid;
ALTER TABLE platform_metric_observation
  ADD CONSTRAINT platform_metric_observation_platform_work_scope_fk
  FOREIGN KEY (platform_work_id, workspace_id, account_id)
  REFERENCES platform_work_mirror (id, workspace_id, account_id) ON DELETE SET NULL (platform_work_id);
ALTER TABLE platform_metric_observation DROP CONSTRAINT platform_metric_observation_source_check;
ALTER TABLE platform_metric_observation ADD CONSTRAINT platform_metric_observation_source_check
  CHECK (source IN ('wechat_browser', 'xhs_browser', 'toutiao_browser', 'file', 'screenshot', 'paste', 'manual'));
ALTER TABLE platform_metric_observation DROP CONSTRAINT platform_metric_observation_external_account_key_check;
ALTER TABLE platform_metric_observation ADD CONSTRAINT platform_metric_observation_external_account_key_check
  CHECK (external_account_key ~ '^(wechat_biz|xhs_user_id|toutiao_creator):.+');

-- +goose Down
-- 新镜像和操作含用户授权范围/同步结果；有任何新数据时不能用 Down 静默丢弃。
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_account_snapshot)
     OR EXISTS (SELECT 1 FROM platform_work_mirror)
     OR EXISTS (SELECT 1 FROM platform_sync_operation)
     OR EXISTS (SELECT 1 FROM platform_sync_run WHERE operation_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM platform_metric_observation WHERE platform_work_id IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot roll back platform account sync while data exists';
  END IF;
END
$$;
-- +goose StatementEnd

ALTER TABLE platform_metric_observation DROP CONSTRAINT platform_metric_observation_platform_work_scope_fk;
ALTER TABLE platform_metric_observation DROP COLUMN platform_work_id;
ALTER TABLE platform_metric_observation DROP CONSTRAINT platform_metric_observation_source_check;
ALTER TABLE platform_metric_observation ADD CONSTRAINT platform_metric_observation_source_check
  CHECK (source IN ('wechat_browser', 'xhs_browser', 'file', 'screenshot', 'paste', 'manual'));
ALTER TABLE platform_metric_observation DROP CONSTRAINT platform_metric_observation_external_account_key_check;
ALTER TABLE platform_metric_observation ADD CONSTRAINT platform_metric_observation_external_account_key_check
  CHECK (external_account_key ~ '^(wechat_biz|xhs_user_id):.+');

DROP INDEX platform_sync_run_operation_created;
ALTER TABLE platform_sync_run DROP CONSTRAINT platform_sync_run_operation_scope_fk;
ALTER TABLE platform_sync_run DROP CONSTRAINT platform_sync_run_task_kind_check;
ALTER TABLE platform_sync_run ADD CONSTRAINT platform_sync_run_task_kind_check
  CHECK (task_kind IN ('probe', 'discover', 'collect'));
ALTER TABLE platform_sync_run DROP COLUMN operation_id, DROP COLUMN wire_protocol_version, DROP COLUMN operation_stage;

DROP INDEX platform_work_mirror_operation_content;
DROP INDEX platform_work_mirror_account_published;
ALTER TABLE platform_work_mirror DROP CONSTRAINT platform_work_mirror_observation_scope_ref;
DROP TABLE platform_work_mirror;
DROP TABLE platform_account_snapshot;
DROP INDEX platform_sync_operation_account_sync_active;
DROP INDEX platform_sync_operation_account_created;
DROP TABLE platform_sync_operation;
ALTER TABLE platform_connection DROP CONSTRAINT platform_connection_sync_scope_ref;
ALTER TABLE platform_connection DROP CONSTRAINT platform_connection_sync_actor_ref;
ALTER TABLE platform_connection DROP CONSTRAINT platform_connection_sync_identity_ref;
