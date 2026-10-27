-- DEV-AW11：按附件保留实际解析器版本，不伪造历史回执。
-- +goose Up
ALTER TABLE agent_attachment ADD COLUMN parser_version text NOT NULL DEFAULT '';

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_attachment WHERE parser_version<>'') THEN
    RAISE EXCEPTION '解析器版本回执仍有数据，拒绝回滚；请保留字段并前滚修复';
  END IF;
END;
$$;
-- +goose StatementEnd
ALTER TABLE agent_attachment DROP COLUMN parser_version;
