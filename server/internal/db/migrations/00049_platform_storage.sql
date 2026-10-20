-- +goose Up
-- D-129 / 20 文档 §8：平台采集的存储与绑定。本迁移只建事实与归属，不写正式指标：
-- 新来源在 PS08 完成统一读取入口前只落观测，不进入 metric_snapshot。
--
-- 复合外键需要被引用列先具备唯一性：账号的归属（工作区 + 平台）必须由库层保证，
-- 不能只靠代码在请求体里相信 account_id。
ALTER TABLE platform_account ADD CONSTRAINT platform_account_scope_ref UNIQUE (id, workspace_id, platform);
ALTER TABLE platform_account ADD CONSTRAINT platform_account_workspace_ref UNIQUE (id, workspace_id);

-- 平台连接：网页通路的授权与设备归属。account_id 必须属于同一工作区且平台一致，
-- 用复合外键在库层保证，不只靠代码相信请求体。
CREATE TABLE platform_connection (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  account_id               uuid NOT NULL,
  platform                 text NOT NULL CHECK (platform IN ('wechat_mp', 'xhs')),
  user_id                  uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  device_id                uuid NOT NULL REFERENCES desktop_device(id) ON DELETE RESTRICT,
  external_account_key     text NOT NULL CHECK (external_account_key ~ '^(wechat_biz|xhs_user_id):.+'),
  state                    text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'paused', 'revoked')),
  availability             text NOT NULL DEFAULT 'unknown' CHECK (availability IN (
                             'unknown', 'login_required', 'verifying', 'ready', 'challenge_required',
                             'restricted', 'identity_mismatch', 'degraded', 'unsupported')),
  authorization_revision   bigint NOT NULL DEFAULT 1 CHECK (authorization_revision > 0),
  adoption_revision        bigint NOT NULL DEFAULT 1 CHECK (adoption_revision > 0),
  capabilities             jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_verified_at         timestamptz,
  last_seen_at             timestamptz,
  auto_collect             boolean NOT NULL DEFAULT false,
  auto_adopt               boolean NOT NULL DEFAULT false,
  next_due_at              timestamptz,
  failure_count            int NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  cooldown_until           timestamptz,
  platform_consent_version int NOT NULL DEFAULT 1 CHECK (platform_consent_version > 0),
  consented_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  -- 自动采用必须先开启自动采集；首版 auto_adopt 一律关闭，由 PS08 之后才允许开启。
  CHECK (NOT auto_adopt OR auto_collect),
  -- 连接的平台必须与账号平台一致，不能由客户端另报一个平台。
  FOREIGN KEY (account_id, workspace_id, platform)
    REFERENCES platform_account (id, workspace_id, platform) ON DELETE CASCADE,
  -- device_id 必须属于保管人，防止借用他人的设备凭据。
  FOREIGN KEY (user_id, device_id) REFERENCES desktop_device (user_id, id) ON DELETE RESTRICT
);

-- 同工作区同平台的活动连接唯一（撤销记录保留）；同账号最多一条未撤销主连接，paused 仍占位。
CREATE UNIQUE INDEX platform_connection_workspace_identity
  ON platform_connection (workspace_id, platform, external_account_key)
  WHERE state <> 'revoked';
CREATE UNIQUE INDEX platform_connection_account_active
  ON platform_connection (account_id)
  WHERE state <> 'revoked';

-- 任务：领取、租约、预算、回执与恢复。不存 Cookie 或完整响应。
CREATE TABLE platform_sync_run (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id                 uuid NOT NULL REFERENCES platform_connection(id) ON DELETE CASCADE,
  workspace_id                  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  account_id                    uuid NOT NULL,
  requested_by                  uuid REFERENCES app_user(id) ON DELETE SET NULL,
  trigger                       text NOT NULL CHECK (trigger IN ('manual', 'daily', 'node', 'reconnect')),
  task_kind                     text NOT NULL CHECK (task_kind IN ('probe', 'discover', 'collect')),
  status                        text NOT NULL DEFAULT 'queued' CHECK (status IN (
                                  'queued', 'leased', 'running', 'succeeded', 'partial', 'failed', 'canceled', 'expired')),
  query_scope                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  authorization_revision        bigint NOT NULL CHECK (authorization_revision > 0),
  workspace_authorization_revision bigint NOT NULL CHECK (workspace_authorization_revision > 0),
  adapter_version               text NOT NULL DEFAULT '',
  mapping_version               int NOT NULL DEFAULT 1 CHECK (mapping_version > 0),
  browser_version               text NOT NULL DEFAULT '',
  lease_generation              bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_expires_at              timestamptz,
  deadline_at                   timestamptz,
  binding_snapshot              jsonb NOT NULL DEFAULT '{}'::jsonb,
  cursor                        jsonb,
  batch_receipts                jsonb NOT NULL DEFAULT '[]'::jsonb,
  counters                      jsonb NOT NULL DEFAULT '{}'::jsonb,
  stop_reason                   text CHECK (stop_reason IS NULL OR stop_reason IN (
                                  'budget', 'login_required', 'challenge_required', 'schema_changed', 'network',
                                  'identity_mismatch', 'canceled')),
  error_code                    text,
  attempt                       int NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 2),
  cancel_requested_at           timestamptz,
  last_error_at                 timestamptz,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  started_at                    timestamptz,
  finished_at                   timestamptz,
  FOREIGN KEY (account_id, workspace_id) REFERENCES platform_account (id, workspace_id) ON DELETE CASCADE
);

-- 同一连接同一时刻只允许一条未结束 run（不区分 trigger）；自动任务串行分批，manual 只在空闲时新建。
CREATE UNIQUE INDEX platform_sync_run_single_active
  ON platform_sync_run (connection_id)
  WHERE status IN ('queued', 'leased', 'running');
CREATE INDEX platform_sync_run_connection_created
  ON platform_sync_run (connection_id, created_at DESC);

-- 观测：外部最小事实与回溯依据，不是供业务报表直接读取的第二套指标表。
CREATE TABLE platform_metric_observation (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supersedes_id        uuid REFERENCES platform_metric_observation(id) ON DELETE SET NULL,
  run_id               uuid REFERENCES platform_sync_run(id) ON DELETE SET NULL,
  batch_seq            int,
  row_no               int,
  workspace_id         uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  account_id           uuid NOT NULL,
  external_account_key text NOT NULL CHECK (external_account_key ~ '^(wechat_biz|xhs_user_id):.+'),
  external_id          text,
  scope                text NOT NULL CHECK (scope IN ('account', 'work')),
  source               text NOT NULL CHECK (source IN ('wechat_browser', 'xhs_browser', 'file', 'screenshot', 'paste', 'manual')),
  observed_at          timestamptz NOT NULL,
  as_of_at             timestamptz,
  window_start         timestamptz,
  window_end           timestamptz,
  temporal_kind        text NOT NULL CHECK (temporal_kind IN ('cumulative', 'interval', 'current_total')),
  values               jsonb NOT NULL,
  field_paths          jsonb NOT NULL DEFAULT '{}'::jsonb,
  adapter_version      text NOT NULL DEFAULT '',
  mapping_version      int NOT NULL CHECK (mapping_version > 0),
  browser_version      text NOT NULL DEFAULT '',
  payload_hash         text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  quality_state        text NOT NULL DEFAULT 'valid' CHECK (quality_state IN (
                         'valid', 'needs_confirmation', 'rejected', 'superseded')),
  match_state          text NOT NULL DEFAULT 'not_applicable' CHECK (match_state IN (
                         'not_applicable', 'bound', 'unmatched', 'ignored')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- 作品观测必须有外部编号；账号观测不要求。
  CHECK (scope <> 'work' OR external_id IS NOT NULL),
  -- 累计必须有 as_of_at；区间必须有起止且起止有序。
  CHECK (temporal_kind <> 'cumulative' OR as_of_at IS NOT NULL),
  CHECK (temporal_kind <> 'interval' OR (window_start IS NOT NULL AND window_end IS NOT NULL AND window_start <= window_end)),
  -- 账号观测不参与作品匹配。
  CHECK (scope <> 'account' OR match_state = 'not_applicable'),
  CHECK (batch_seq IS NULL OR batch_seq >= 0),
  CHECK (row_no IS NULL OR row_no >= 0),
  FOREIGN KEY (account_id, workspace_id) REFERENCES platform_account (id, workspace_id) ON DELETE CASCADE
);

-- 同一 run 的观测以 (run_id, batch_seq, row_no) 唯一。
CREATE UNIQUE INDEX platform_metric_observation_run_row
  ON platform_metric_observation (run_id, batch_seq, row_no)
  WHERE run_id IS NOT NULL;
-- 同一 run 内同一内容再发（换 batch_seq）也去重。
CREATE UNIQUE INDEX platform_metric_observation_run_payload
  ON platform_metric_observation (run_id, payload_hash, scope, coalesce(external_id, ''), as_of_at)
  WHERE run_id IS NOT NULL;
-- 无 run 的人工/文件导入按内容去重。
CREATE UNIQUE INDEX platform_metric_observation_offline_payload
  ON platform_metric_observation (payload_hash, scope, coalesce(external_id, ''), as_of_at)
  WHERE run_id IS NULL;

-- work：平台作品编号与绑定来源/版本。微信仍用 wechat_msgid，小红书用 xhs_note_id；
-- 不新增可独立写入的通用 platform_identity_key。
ALTER TABLE work
  ADD COLUMN xhs_note_id                  text,
  ADD COLUMN metric_binding_revision      int NOT NULL DEFAULT 1 CHECK (metric_binding_revision > 0),
  ADD COLUMN metric_binding_confirmed_at   timestamptz,
  ADD COLUMN metric_binding_confirmed_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
  ADD COLUMN platform_binding_source       text CHECK (platform_binding_source IN (
                                             'user_link', 'user_confirm', 'official_exact', 'legacy_title')),
  ADD COLUMN platform_binding_verified_at  timestamptz;

-- 存量：无法判断来源的编号一律标 legacy_title 并留待逐条核对；
-- 不从 published_url 反推 official_exact（能解析出数字不等于用户或官方确认过归属）。
UPDATE work SET platform_binding_source = 'legacy_title'
  WHERE (wechat_msgid IS NOT NULL OR xhs_note_id IS NOT NULL) AND deleted_at IS NULL;

-- 存量重复编号必须先处理：同一账号下同一外部编号只能属于一篇未删除作品。
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM work
    WHERE deleted_at IS NULL AND wechat_msgid IS NOT NULL
    GROUP BY account_id, wechat_msgid HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate wechat_msgid within one account; resolve conflicts before upgrading';
  END IF;
END
$$;
-- +goose StatementEnd

CREATE UNIQUE INDEX work_account_wechat_msgid
  ON work (account_id, wechat_msgid) WHERE deleted_at IS NULL AND wechat_msgid IS NOT NULL;
CREATE UNIQUE INDEX work_account_xhs_note_id
  ON work (account_id, xhs_note_id) WHERE deleted_at IS NULL AND xhs_note_id IS NOT NULL;

-- metric_unmatched：新增结果走观测；旧路径仍可读。按账号与外部编号的既有唯一键保留，
-- 乐观并发由 binding_revision 与 updated_at 承担。
ALTER TABLE metric_unmatched
  ADD COLUMN observation_id   uuid REFERENCES platform_metric_observation(id) ON DELETE SET NULL,
  ADD COLUMN as_of_at         timestamptz,
  ADD COLUMN binding_revision int NOT NULL DEFAULT 1 CHECK (binding_revision > 0),
  ADD COLUMN source           text;
ALTER TABLE metric_unmatched DROP CONSTRAINT metric_unmatched_reason_check;
ALTER TABLE metric_unmatched ADD CONSTRAINT metric_unmatched_reason_check
  CHECK (reason IN ('none', 'ambiguous', 'identity_unverified', 'no_stable_id', 'schema_changed',
                    'scope_mismatch', 'legacy_title'));

-- account_metric_daily：各来源各自一行，用户显式更正只把自己那行设为 preferred。
ALTER TABLE account_metric_daily DROP CONSTRAINT account_metric_daily_source_check;
ALTER TABLE account_metric_daily ADD CONSTRAINT account_metric_daily_source_check
  CHECK (source IN ('wechat_api', 'wechat_browser', 'xhs_browser', 'manual'));
ALTER TABLE account_metric_daily
  ADD COLUMN observation_id uuid REFERENCES platform_metric_observation(id) ON DELETE SET NULL,
  ADD COLUMN as_of_at       timestamptz,
  ADD COLUMN metric_meta    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN net_follow     int,
  ADD COLUMN preferred      boolean NOT NULL DEFAULT false;

-- +goose Down
-- 观测/任务/连接是用户授权与回溯依据，不能通过删表“解决”回退。存在任何数据时拒绝回退。
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_metric_observation) OR EXISTS (SELECT 1 FROM platform_sync_run)
     OR EXISTS (SELECT 1 FROM platform_connection) THEN
    RAISE EXCEPTION 'cannot roll back platform collection storage while connection, run or observation rows exist';
  END IF;
END
$$;
-- +goose StatementEnd

ALTER TABLE account_metric_daily
  DROP COLUMN preferred, DROP COLUMN net_follow, DROP COLUMN metric_meta,
  DROP COLUMN as_of_at, DROP COLUMN observation_id;
ALTER TABLE account_metric_daily DROP CONSTRAINT account_metric_daily_source_check;
ALTER TABLE account_metric_daily ADD CONSTRAINT account_metric_daily_source_check
  CHECK (source IN ('wechat_api', 'manual'));

ALTER TABLE metric_unmatched DROP CONSTRAINT metric_unmatched_reason_check;
ALTER TABLE metric_unmatched ADD CONSTRAINT metric_unmatched_reason_check
  CHECK (reason IN ('none', 'ambiguous'));
ALTER TABLE metric_unmatched
  DROP COLUMN source, DROP COLUMN binding_revision, DROP COLUMN as_of_at, DROP COLUMN observation_id;

DROP INDEX work_account_xhs_note_id;
DROP INDEX work_account_wechat_msgid;
ALTER TABLE work
  DROP COLUMN platform_binding_verified_at, DROP COLUMN platform_binding_source,
  DROP COLUMN metric_binding_confirmed_by, DROP COLUMN metric_binding_confirmed_at,
  DROP COLUMN metric_binding_revision, DROP COLUMN xhs_note_id;

DROP TABLE platform_metric_observation;
DROP TABLE platform_sync_run;
DROP TABLE platform_connection;
ALTER TABLE platform_account DROP CONSTRAINT platform_account_workspace_ref;
ALTER TABLE platform_account DROP CONSTRAINT platform_account_scope_ref;
