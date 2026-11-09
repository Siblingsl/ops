-- +goose Up
-- DEV-AI27-04（W04）：浏览器配对、绑定、授权租约与命令账本（27 文档 §13.2/§13.4 提案契约的本机实现批）。
-- 归属全部由真实关系派生（本人+工作区+设备+扩展实例），不接受客户端任意 owner。

CREATE TABLE agent_browser_pairing (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    code varchar(6) NOT NULL,
    state varchar(16) NOT NULL DEFAULT 'pending',
    binding_id uuid,
    expected_revision integer NOT NULL DEFAULT 1,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_browser_pairing_state CHECK (state IN ('pending','confirmed','expired','cancelled'))
);
CREATE INDEX idx_agent_browser_pairing_user ON agent_browser_pairing(user_id, state, expires_at);

CREATE TABLE agent_browser_binding (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    device_id uuid NOT NULL,
    extension_instance_id uuid NOT NULL,
    connection_name varchar(64) NOT NULL DEFAULT '',
    browser_kind varchar(16) NOT NULL DEFAULT 'chrome',
    protocol_range varchar(32) NOT NULL DEFAULT '',
    state varchar(16) NOT NULL DEFAULT 'ready',
    revision integer NOT NULL DEFAULT 1,
    last_seen_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_browser_binding_state CHECK (state IN ('ready','disconnected','revoked')),
    -- 同一扩展实例在同一时刻只归属一个本人绑定（重装/换 profile 即新实例）。
    CONSTRAINT uq_agent_browser_binding_instance UNIQUE (extension_instance_id)
);
CREATE INDEX idx_agent_browser_binding_user ON agent_browser_binding(user_id, workspace_id, state);

CREATE TABLE agent_browser_grant (
    id uuid PRIMARY KEY,
    binding_id uuid NOT NULL REFERENCES agent_browser_binding(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
    run_id uuid,
    tab_handle varchar(128) NOT NULL,
    origins text[] NOT NULL DEFAULT '{}',
    actions text[] NOT NULL DEFAULT '{}',
    policy_version varchar(32) NOT NULL DEFAULT '',
    generation integer NOT NULL DEFAULT 0,
    state varchar(16) NOT NULL DEFAULT 'active',
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_browser_grant_state CHECK (state IN ('active','revoked','expired'))
);
CREATE INDEX idx_agent_browser_grant_conversation ON agent_browser_grant(conversation_id, state, expires_at);

CREATE TABLE agent_browser_command (
    id uuid PRIMARY KEY,
    run_id uuid,
    grant_id uuid NOT NULL REFERENCES agent_browser_grant(id) ON DELETE CASCADE,
    request_id uuid NOT NULL,
    action_kind varchar(32) NOT NULL,
    target_ref varchar(256) NOT NULL DEFAULT '',
    input_hash varchar(64) NOT NULL,
    state varchar(24) NOT NULL,
    deadline_at timestamptz,
    dispatched_at timestamptz,
    receipt_hash varchar(64),
    error_code varchar(64),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_browser_command_state CHECK (state IN ('queued','dispatched','succeeded','rejected','cancelled','failed','unknown_outcome')),
    -- 27 §13.2：run+请求编号唯一；同编号不同输入拒绝（input_hash 冲突由应用层 409）。
    CONSTRAINT uq_agent_browser_command_request UNIQUE (grant_id, request_id)
);
CREATE INDEX idx_agent_browser_command_run ON agent_browser_command(run_id, created_at);

-- +goose Down
-- DO 块内含分号，必须用 StatementBegin/End 包住；否则 goose 会按分号切开，
-- 报 unterminated dollar-quoted string（同 00092）。
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM agent_browser_command)
        OR EXISTS (SELECT 1 FROM agent_browser_grant)
        OR EXISTS (SELECT 1 FROM agent_browser_binding)
        OR EXISTS (SELECT 1 FROM agent_browser_pairing) THEN
        RAISE EXCEPTION 'agent_browser_* tables not empty; refusing downgrade (D-170 scope)';
    END IF;
END $$;
-- +goose StatementEnd
DROP TABLE IF EXISTS agent_browser_command;
DROP TABLE IF EXISTS agent_browser_grant;
DROP TABLE IF EXISTS agent_browser_binding;
DROP TABLE IF EXISTS agent_browser_pairing;
