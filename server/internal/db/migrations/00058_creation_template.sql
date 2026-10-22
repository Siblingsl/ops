-- DEV-416 / D-124 / D-140：创作模板（单一"模板"概念，吸收原 outline-templates）。
-- 一个模板 = 结构 + 提示词补充 + 段落数区间 + 语气；用户侧只有一个决策点。

-- +goose Up
CREATE TABLE creation_template (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  content_format text NOT NULL,
  name           text NOT NULL,
  builtin        boolean NOT NULL DEFAULT false,
  structure      jsonb NOT NULL DEFAULT '[]',
  prompt_addon   text NOT NULL DEFAULT '',
  section_min    int NOT NULL DEFAULT 0,
  section_max    int NOT NULL DEFAULT 0,
  tone           text NOT NULL DEFAULT '',
  deleted_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX creation_template_workspace ON creation_template (workspace_id, content_format) WHERE deleted_at IS NULL;

-- 内置模板是代码里的稳定派生 id，不在表里；因此这里不加外键，只存 id 供复盘。
ALTER TABLE work ADD COLUMN template_id uuid;

-- +goose Down
ALTER TABLE work DROP COLUMN template_id;
DROP INDEX creation_template_workspace;
DROP TABLE creation_template;
