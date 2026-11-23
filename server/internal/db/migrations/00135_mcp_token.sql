-- +goose Up
-- REF41 E2：MCP Server（只读）。token 按工作区签发、只存 sha256 哈希、带 scope；
-- 撤销立即生效；调用审计只存元数据（token/工具/耗时/结果码），不含正文。

CREATE TABLE mcp_token (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE TABLE mcp_call_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  token_id uuid NOT NULL REFERENCES mcp_token(id) ON DELETE CASCADE,
  tool text NOT NULL,
  result_code text NOT NULL,
  duration_ms int NOT NULL CHECK (duration_ms >= 0),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcp_call_log_token ON mcp_call_log(token_id, at DESC);

-- +goose Down
DROP INDEX IF EXISTS mcp_call_log_token;
DROP TABLE IF EXISTS mcp_call_log;
DROP TABLE IF EXISTS mcp_token;
