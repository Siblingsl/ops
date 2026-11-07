-- +goose Up
-- DEV-AI27-13（W13）：个人跨对话记忆（27 文档 §11.1 提案契约的本机实现批）。
-- 个人记忆是 user 私有资源（跨 workspace 不注入）；候选不参与注入；模型不能自行确认；
-- 删除仅保留无正文的最小撤销标记用于去重（27 §11.1.2）。

CREATE TABLE agent_personal_memory (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    text text NOT NULL DEFAULT '',
    state varchar(20) NOT NULL DEFAULT 'candidate',
    source_conversation_id uuid REFERENCES agent_conversation(id) ON DELETE SET NULL,
    source_revision integer NOT NULL DEFAULT 0,
    revision integer NOT NULL DEFAULT 1,
    content_hash varchar(64) NOT NULL,
    supersedes_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_personal_memory_state CHECK (
        state IN ('candidate','active','ignored','disabled','source_unavailable','deleted')),
    CONSTRAINT agent_personal_memory_text CHECK (state <> 'deleted' OR text = '')
);
CREATE INDEX idx_agent_personal_memory_user ON agent_personal_memory(user_id, workspace_id, state);
-- 同一本人同内容至多一条候选/active（去重；ignored/deleted 不占位）。
CREATE UNIQUE INDEX uq_agent_personal_memory_active_hash
    ON agent_personal_memory(user_id, content_hash)
    WHERE state IN ('candidate','active');

-- 每次模型调用注入/省略的记录（27 §11.1.2：memory_id/revision/used_or_omitted/reason）。
CREATE TABLE agent_memory_usage (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id uuid NOT NULL,
    memory_id uuid NOT NULL REFERENCES agent_personal_memory(id) ON DELETE CASCADE,
    revision integer NOT NULL,
    used boolean NOT NULL,
    omitted_reason varchar(64) NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_memory_usage_run ON agent_memory_usage(run_id);

-- 个人记忆开关（本人级；会话级覆盖在 agent_conversation 列，'' = 跟随全局）。
CREATE TABLE agent_memory_setting (
    user_id uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    use_enabled boolean NOT NULL DEFAULT true,
    capture_enabled boolean NOT NULL DEFAULT true,
    revision integer NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE agent_conversation
    ADD COLUMN memory_use_override varchar(4) NOT NULL DEFAULT '',
    ADD COLUMN memory_capture_override varchar(4) NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE agent_conversation DROP COLUMN IF EXISTS memory_capture_override;
ALTER TABLE agent_conversation DROP COLUMN IF EXISTS memory_use_override;
DROP TABLE IF EXISTS agent_memory_setting;
DROP TABLE IF EXISTS agent_memory_usage;
DROP TABLE IF EXISTS agent_personal_memory;
