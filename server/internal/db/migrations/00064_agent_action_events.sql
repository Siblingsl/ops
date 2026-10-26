-- +goose Up
-- DEV-AW06：操作卡片状态事件使用可比较的实体修订号。
ALTER TABLE agent_action ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0);

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_action WHERE revision<>1) THEN
    RAISE EXCEPTION '操作卡片已有修订与事件，拒绝回滚；请保留字段并前滚修复';
  END IF;
END;
$$;
-- +goose StatementEnd
ALTER TABLE agent_action DROP COLUMN revision;
