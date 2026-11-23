-- +goose Up
-- REF41 A7：工作流模板（基于计划）。模板 = 有序步骤（key 唯一、requires 只允许
-- 现有上下文键）；启动只建 conversation+run+plan 并展示预览，用户确认后才开始；
-- 每步仍走计划状态与动作卡片，不做“全部执行”。内置三模板可停用不可删。

CREATE TABLE workflow_template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 200),
  steps jsonb NOT NULL CHECK (jsonb_typeof(steps)='array' AND jsonb_array_length(steps) BETWEEN 1 AND 12),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  builtin_key text NOT NULL DEFAULT '',
  created_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
CREATE UNIQUE INDEX workflow_template_builtin ON workflow_template(workspace_id, builtin_key)
  WHERE builtin_key <> '';

-- +goose Down
DROP INDEX IF EXISTS workflow_template_builtin;
DROP TABLE IF EXISTS workflow_template;
