-- +goose Up
-- DEV-AI27-17（W17）：Windows 通用应用控制前台租约（27 文档 §11.5 提案契约本机实现批）。
-- 授权由本机选窗产生（不透明 target_handle），服务端只管租约生命周期与硬禁区校验。
-- 硬禁区（§11.5.2）在应用层拒绝；本批不实现 UIA/视觉执行 worker（W17 第二批）。

CREATE TABLE agent_computer_grant (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
    run_id uuid,
    target_handle varchar(256) NOT NULL,
    target_summary varchar(256) NOT NULL DEFAULT '',
    scope varchar(32) NOT NULL DEFAULT 'observe',
    generation integer NOT NULL DEFAULT 0,
    state varchar(16) NOT NULL DEFAULT 'pending',
    request_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    revoked_at timestamptz,
    CONSTRAINT agent_computer_grant_state CHECK (
        state IN ('pending','active','revoked','expired')),
    CONSTRAINT agent_computer_grant_scope CHECK (
        scope IN ('observe','act')),
    CONSTRAINT uq_agent_computer_grant_request UNIQUE (conversation_id, request_id)
);
CREATE INDEX idx_agent_computer_grant_conversation ON agent_computer_grant(conversation_id, state);

-- +goose Down
DELETE FROM agent_computer_grant;
DROP TABLE IF EXISTS agent_computer_grant;
