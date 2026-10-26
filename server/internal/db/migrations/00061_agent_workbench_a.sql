-- DEV-AW01 / D-152：阶段 A 的会话组织、上下文、产物与幂等基座。
-- 旧会话只补默认值；不伪造事件、未读或产物历史。

-- +goose Up
ALTER TABLE agent_conversation
  ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN group_id uuid,
  ADD COLUMN mode text NOT NULL DEFAULT 'execute' CHECK (mode IN ('discuss','plan','execute')),
  ADD COLUMN reasoning_effort text,
  ADD COLUMN read_upto_message_seq bigint NOT NULL DEFAULT 0 CHECK (read_upto_message_seq >= 0),
  ADD COLUMN force_unread boolean NOT NULL DEFAULT false,
  ADD COLUMN fixed_context_refs jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(fixed_context_refs) = 'array'),
  ADD CONSTRAINT agent_conversation_identity_unique UNIQUE (id, workspace_id, user_id);

CREATE TABLE agent_conversation_group (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 30),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id, user_id)
);
CREATE UNIQUE INDEX agent_conversation_group_name
  ON agent_conversation_group (workspace_id, user_id, lower(btrim(name)));
CREATE INDEX agent_conversation_group_owner
  ON agent_conversation_group (workspace_id, user_id, created_at);
ALTER TABLE agent_conversation
  ADD CONSTRAINT agent_conversation_group_owner_fk
  FOREIGN KEY (group_id, workspace_id, user_id)
  REFERENCES agent_conversation_group (id, workspace_id, user_id);
CREATE INDEX agent_conversation_group_list
  ON agent_conversation (workspace_id, user_id, group_id, last_message_at DESC)
  WHERE group_id IS NOT NULL;

ALTER TABLE agent_message
  ADD COLUMN context_refs jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(context_refs) = 'array'),
  ADD COLUMN skill_requests jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(skill_requests) = 'array');

CREATE TABLE agent_artifact (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id    uuid NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('markdown','title','table','image','business_ref')),
  title              text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  current_version_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, conversation_id)
);
CREATE INDEX agent_artifact_conversation
  ON agent_artifact (conversation_id, updated_at DESC, id);

CREATE TABLE agent_artifact_version (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id       uuid NOT NULL REFERENCES agent_artifact(id) ON DELETE CASCADE,
  version           integer NOT NULL CHECK (version > 0),
  source_run_id     uuid REFERENCES agent_run(id) ON DELETE SET NULL,
  source_message_id uuid REFERENCES agent_message(id) ON DELETE SET NULL,
  source_ai_call_id uuid,
  source_kind       text NOT NULL,
  content_ref       jsonb NOT NULL DEFAULT '{}'::jsonb,
  hash              text NOT NULL DEFAULT '',
  context_refs      jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(context_refs) = 'array'),
  status            text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','applied','source_unavailable','superseded')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (artifact_id, version),
  UNIQUE (id, artifact_id)
);
CREATE INDEX agent_artifact_version_list
  ON agent_artifact_version (artifact_id, version DESC);
ALTER TABLE agent_artifact
  ADD CONSTRAINT agent_artifact_current_version_fk
  FOREIGN KEY (current_version_id, id)
  REFERENCES agent_artifact_version (id, artifact_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE agent_request (
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  operation    text NOT NULL CHECK (char_length(operation) BETWEEN 1 AND 80),
  request_id   uuid NOT NULL,
  payload_hash char(64) NOT NULL,
  resource_id  uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, user_id, operation, request_id)
);
CREATE INDEX agent_request_expiry ON agent_request (expires_at);

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_conversation_group)
     OR EXISTS (SELECT 1 FROM agent_artifact)
     OR EXISTS (SELECT 1 FROM agent_artifact_version)
     OR EXISTS (SELECT 1 FROM agent_request)
     OR EXISTS (SELECT 1 FROM agent_conversation WHERE revision <> 1 OR archived_at IS NOT NULL
       OR group_id IS NOT NULL OR mode <> 'execute' OR reasoning_effort IS NOT NULL
       OR read_upto_message_seq <> 0 OR force_unread OR fixed_context_refs <> '[]'::jsonb)
     OR EXISTS (SELECT 1 FROM agent_message WHERE context_refs <> '[]'::jsonb OR skill_requests <> '[]'::jsonb) THEN
    RAISE EXCEPTION '工作台数据仍存在，拒绝回滚；请保留字段并前滚修复';
  END IF;
END;
$$;
-- +goose StatementEnd
ALTER TABLE agent_artifact DROP CONSTRAINT agent_artifact_current_version_fk;
DROP TABLE agent_artifact_version, agent_artifact;
DROP TABLE agent_request;
DROP INDEX agent_conversation_group_list;
ALTER TABLE agent_conversation DROP CONSTRAINT agent_conversation_group_owner_fk;
DROP TABLE agent_conversation_group;
ALTER TABLE agent_conversation
  DROP CONSTRAINT agent_conversation_identity_unique,
  DROP COLUMN revision,
  DROP COLUMN archived_at,
  DROP COLUMN group_id,
  DROP COLUMN mode,
  DROP COLUMN reasoning_effort,
  DROP COLUMN read_upto_message_seq,
  DROP COLUMN force_unread,
  DROP COLUMN fixed_context_refs;
ALTER TABLE agent_message DROP COLUMN context_refs, DROP COLUMN skill_requests;
