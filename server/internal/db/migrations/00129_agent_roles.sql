-- +goose Up
-- REF41 A6：角色 bot 与工具白名单。角色 = 工作区内的 bot 配置（人设/工具白名单/
-- 预算/模型路由）；不改变 D-117：卡片仍逐张确认，无批量执行。内置三角色可停用
-- 不可删（builtin_key 唯一）。角色不能授予管理员工具（settings__*/users__*/billing__*）。

CREATE TABLE agent_role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 30),
  persona text NOT NULL DEFAULT '' CHECK (char_length(persona) <= 800),
  tool_allowlist text[] NOT NULL DEFAULT '{}',
  max_rounds int NOT NULL DEFAULT 8 CHECK (max_rounds BETWEEN 1 AND 30),
  max_seconds int NOT NULL DEFAULT 180 CHECK (max_seconds BETWEEN 30 AND 900),
  model_task_type text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  builtin_key text NOT NULL DEFAULT '',
  created_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
CREATE UNIQUE INDEX agent_role_builtin ON agent_role(workspace_id, builtin_key)
  WHERE builtin_key <> '';
ALTER TABLE agent_run ADD COLUMN role_id uuid REFERENCES agent_role(id) ON DELETE SET NULL;

-- +goose Down
ALTER TABLE agent_run DROP COLUMN IF EXISTS role_id;
DROP INDEX IF EXISTS agent_role_builtin;
DROP TABLE IF EXISTS agent_role;
