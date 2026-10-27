-- DEV-AW07 / D-152：运行模式与配置快照；不伪造历史运行的账号/模型通道。
-- +goose Up
ALTER TABLE agent_run
  ADD COLUMN mode text NOT NULL DEFAULT 'execute' CHECK (mode IN ('discuss','plan','execute')),
  ADD COLUMN execution_origin text NOT NULL DEFAULT 'interactive' CHECK (execution_origin IN ('interactive','goal','routine')),
  ADD COLUMN config_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config_snapshot)='object');

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_run WHERE mode<>'execute' OR execution_origin<>'interactive' OR config_snapshot<>'{}'::jsonb)
     OR EXISTS (SELECT 1 FROM agent_conversation WHERE mode<>'execute' OR reasoning_effort IS NOT NULL) THEN
    RAISE EXCEPTION '拒绝回滚：存在工作台运行配置快照，请前滚修复';
  END IF;
END $$;
-- +goose StatementEnd
ALTER TABLE agent_run DROP COLUMN config_snapshot, DROP COLUMN execution_origin, DROP COLUMN mode;
