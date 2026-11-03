-- +goose Up
SELECT 1;

-- 配置是用户事实；从当前版本降级时不得静默丢弃。
-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM account_profile WHERE topic_stock_policy <> '{}'::jsonb) THEN
    RAISE EXCEPTION '选题库存已有水位配置，拒绝回滚丢弃';
  END IF;
END;
$$;
-- +goose StatementEnd
