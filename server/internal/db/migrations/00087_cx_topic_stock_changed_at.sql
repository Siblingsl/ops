-- 旧事件时间未知，不从创建或更新时间推断。
-- +goose Up
ALTER TABLE topic ADD COLUMN stock_changed_at timestamptz;

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM topic WHERE stock_changed_at IS NOT NULL) THEN
    RAISE EXCEPTION '选题库存已有状态变更时间，拒绝回滚丢弃';
  END IF;
END;
$$;
-- +goose StatementEnd
ALTER TABLE topic DROP COLUMN stock_changed_at;
