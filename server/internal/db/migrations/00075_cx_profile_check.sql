-- DEV-CX13-D：定位卡主页自检复用 account_profile，不建立第二份定位编辑源。
-- +goose Up
ALTER TABLE account_profile
  ADD COLUMN profile_check jsonb NOT NULL DEFAULT '{}'::jsonb;

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM account_profile WHERE profile_check <> '{}'::jsonb) THEN
    RAISE EXCEPTION '主页自检已有留存结果，拒绝回滚丢弃；请保留 profile_check 并前滚修复';
  END IF;
END;
$$;
-- +goose StatementEnd
ALTER TABLE account_profile DROP COLUMN profile_check;
