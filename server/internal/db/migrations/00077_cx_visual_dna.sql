-- DEV-CX08：账号视觉令牌历史；回滚通过新版本保留完整链。
-- +goose Up
CREATE TABLE account_visual_dna (
  account_id uuid NOT NULL REFERENCES platform_account(id),
  version int NOT NULL CHECK (version > 0),
  tokens jsonb NOT NULL CHECK (jsonb_typeof(tokens)='object'),
  tokens_hash text NOT NULL CHECK (tokens_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id,version)
);

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM account_visual_dna) THEN
    RAISE EXCEPTION '账号视觉 DNA 仍有版本数据，拒绝回滚丢弃；请保留历史并前滚修复';
  END IF;
END;
$$;
-- +goose StatementEnd
DROP TABLE account_visual_dna;
