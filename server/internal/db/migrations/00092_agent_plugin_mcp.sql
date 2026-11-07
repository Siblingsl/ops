-- +goose Up
-- DEV-AI27-14（W14）：插件/MCP 连接注册与调用回执（27 文档 §11.2 提案契约本机实现批）。
-- 秘密值不入库：服务端只存配置与环境变量键名清单；命令行/参数数组按用户提供存储，
-- 导出/日志接口不得返回 env 键对应的值（值在本机 safeStorage）。

CREATE TABLE agent_plugin_connection (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    name varchar(64) NOT NULL,
    transport varchar(8) NOT NULL CHECK (transport IN ('stdio','http')),
    command varchar(512) NOT NULL DEFAULT '',
    args text[] NOT NULL DEFAULT '{}',
    cwd varchar(512) NOT NULL DEFAULT '',
    env_keys text[] NOT NULL DEFAULT '{}',
    url varchar(512) NOT NULL DEFAULT '',
    protocol_version varchar(32) NOT NULL DEFAULT '',
    server_name varchar(128) NOT NULL DEFAULT '',
    server_version varchar(64) NOT NULL DEFAULT '',
    catalog_revision varchar(64) NOT NULL DEFAULT '',
    tools_catalog jsonb NOT NULL DEFAULT '[]'::jsonb,
    state varchar(16) NOT NULL DEFAULT 'draft',
    revision integer NOT NULL DEFAULT 1,
    last_error varchar(256) NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_plugin_connection_state CHECK (
        state IN ('draft','ready_disabled','enabled','disabled','revoked'))
);
CREATE INDEX idx_agent_plugin_connection_user ON agent_plugin_connection(user_id, workspace_id, state);

-- 调用回执（27 §11.2.4：状态单向、幂等 request_id、凭据不进回执）。
CREATE TABLE agent_plugin_call (
    id uuid PRIMARY KEY,
    connection_id uuid NOT NULL REFERENCES agent_plugin_connection(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    run_id uuid,
    tool_name varchar(128) NOT NULL,
    request_id uuid NOT NULL,
    input_hash varchar(64) NOT NULL,
    state varchar(20) NOT NULL,
    error_code varchar(64) NOT NULL DEFAULT '',
    duration_ms integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_plugin_call_state CHECK (
        state IN ('dispatched','succeeded','failed','cancelled','unknown_outcome')),
    CONSTRAINT uq_agent_plugin_call_request UNIQUE (connection_id, request_id)
);
CREATE INDEX idx_agent_plugin_call_conn ON agent_plugin_call(connection_id, created_at);

-- +goose Down
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM agent_plugin_call)
        OR EXISTS (SELECT 1 FROM agent_plugin_connection WHERE state <> 'draft') THEN
        RAISE EXCEPTION 'agent plugin tables not empty; refusing downgrade';
    END IF;
END $$;
DROP TABLE IF EXISTS agent_plugin_call;
DROP TABLE IF EXISTS agent_plugin_connection;
