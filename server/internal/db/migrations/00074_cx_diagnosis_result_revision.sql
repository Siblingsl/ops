-- DEV-CX13-D：账号分析报告人工编辑与逐项反馈使用独立 CAS 修订号。
-- +goose Up
ALTER TABLE content_diagnosis
  ADD COLUMN result_revision integer NOT NULL DEFAULT 1 CHECK (result_revision > 0);

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM content_diagnosis WHERE result_revision<>1) THEN
    RAISE EXCEPTION '已编辑诊断报告仍依赖 result_revision，拒绝回滚；请保留版本字段并前滚修复';
  END IF;
END;
$$;
-- +goose StatementEnd
ALTER TABLE content_diagnosis DROP COLUMN result_revision;
