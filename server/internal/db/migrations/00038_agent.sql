-- +goose Up
-- D-117（16 文档第 10 节）：系统智能体的对话、运行、消息、操作卡片与附件。
-- model_capability 已在 00037 建立，本迁移只新增这五张表。
CREATE TABLE agent_conversation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  title             text NOT NULL DEFAULT '新对话',
  title_source      text NOT NULL DEFAULT 'auto' CHECK (title_source IN ('auto','user')),
  pinned_at         timestamptz,
  model_provider_id uuid REFERENCES model_provider(id) ON DELETE SET NULL,
  model             text NOT NULL DEFAULT '',
  account_id        uuid REFERENCES platform_account(id) ON DELETE SET NULL,
  loaded_domains    text[] NOT NULL DEFAULT '{}',
  summary           text NOT NULL DEFAULT '',
  summary_upto_seq  int NOT NULL DEFAULT 0,
  next_seq          int NOT NULL DEFAULT 1,
  auto_continue_count int NOT NULL DEFAULT 0,
  last_message_at   timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_conversation_list ON agent_conversation
  (workspace_id, user_id, (pinned_at IS NULL), pinned_at DESC, last_message_at DESC, id DESC);

CREATE TABLE agent_run (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id    uuid NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
  workspace_id       uuid NOT NULL,
  user_id            uuid NOT NULL,
  session_id         uuid NOT NULL,
  trigger            text NOT NULL CHECK (trigger IN ('message','continue','regenerate','edit')),
  status             text NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','running','awaiting_confirmation','completed','stopped','failed')),
  stage              text NOT NULL DEFAULT 'queued',
  model_provider_id  uuid,
  model              text NOT NULL DEFAULT '',
  rounds             int NOT NULL DEFAULT 0,
  read_calls         int NOT NULL DEFAULT 0,
  generate_calls     int NOT NULL DEFAULT 0,
  actions_proposed   int NOT NULL DEFAULT 0,
  prompt_tokens      int NOT NULL DEFAULT 0,
  completion_tokens  int NOT NULL DEFAULT 0,
  external_read      boolean NOT NULL DEFAULT false,
  reason             text NOT NULL DEFAULT '',
  error_code         text NOT NULL DEFAULT '',
  error_message      text NOT NULL DEFAULT '',
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz
);
CREATE INDEX agent_run_conversation ON agent_run (conversation_id, started_at DESC);
CREATE UNIQUE INDEX agent_run_one_active ON agent_run (conversation_id)
  WHERE status IN ('queued','running');

CREATE TABLE agent_message (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
  seq              int NOT NULL,
  run_id           uuid REFERENCES agent_run(id) ON DELETE SET NULL,
  role             text NOT NULL CHECK (role IN ('user','assistant','tool','action_result','system_note')),
  content          text NOT NULL DEFAULT '',
  tool_calls       jsonb,
  tool_call_id     text NOT NULL DEFAULT '',
  tool_name        text NOT NULL DEFAULT '',
  attachment_ids   uuid[] NOT NULL DEFAULT '{}',
  account_id       uuid,
  ai_call_id       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);

CREATE TABLE agent_action (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
  run_id           uuid NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  batch_id         uuid NOT NULL,
  workspace_id     uuid NOT NULL,
  user_id          uuid NOT NULL,
  tool_call_id     text NOT NULL,
  tool_name        text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('W','H','X')),
  gate             text NOT NULL DEFAULT '',
  body_class       boolean NOT NULL DEFAULT false,
  target_type      text NOT NULL,
  target_id        text NOT NULL,
  target_key       text NOT NULL,
  work_id          uuid,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','executing','needs_input','succeeded','failed','rejected','expired','superseded')),
  params           jsonb NOT NULL,
  preview          jsonb NOT NULL DEFAULT '{}',
  editable_fields  text[] NOT NULL DEFAULT '{}',
  blank_fields     text[] NOT NULL DEFAULT '{}',
  fingerprint      text NOT NULL DEFAULT '',
  need             jsonb,
  result           jsonb,
  error            jsonb,
  last_error       jsonb,
  edited_fields    text[] NOT NULL DEFAULT '{}',
  reject_reason    text NOT NULL DEFAULT '',
  decided_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  executed_at      timestamptz,
  finished_at      timestamptz,
  reported_at      timestamptz,
  expires_at       timestamptz NOT NULL
);
CREATE INDEX agent_action_conversation ON agent_action (conversation_id, created_at);
CREATE INDEX agent_action_open ON agent_action (user_id, status) WHERE status IN ('pending','executing','needs_input');
CREATE UNIQUE INDEX agent_action_one_open ON agent_action (user_id, tool_name, target_key)
  WHERE status IN ('pending','executing','needs_input');

CREATE TABLE agent_attachment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  conversation_id  uuid REFERENCES agent_conversation(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('image','text')),
  name             text NOT NULL,
  mime             text NOT NULL,
  bytes            int NOT NULL,
  width            int,
  height           int,
  sha256           text NOT NULL,
  storage_path     text NOT NULL,
  text_content     text,
  referenced       boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_attachment_orphan ON agent_attachment (created_at) WHERE referenced = false;

-- +goose Down
DROP TABLE agent_action, agent_attachment, agent_message, agent_run, agent_conversation;
