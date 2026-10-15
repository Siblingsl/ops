-- +goose Up
-- D-117（16 文档第 10 节）：模型能力自检结果，按供应商 + 模型覆盖保存。
CREATE TABLE model_capability (
  provider_id   uuid NOT NULL REFERENCES model_provider(id) ON DELETE CASCADE,
  model         text NOT NULL,
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  tools_ok      boolean,
  vision_ok     boolean,
  detail        jsonb NOT NULL DEFAULT '{}',
  tested_at     timestamptz,
  PRIMARY KEY (provider_id, model)
);

-- +goose Down
DROP TABLE model_capability;
