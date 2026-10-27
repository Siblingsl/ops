-- DEV-AW11 / D-152：附件解析回执、文档类型与敏感内容隔离。
-- +goose Up
ALTER TABLE agent_attachment DROP CONSTRAINT agent_attachment_kind_check;
ALTER TABLE agent_attachment
  ADD CONSTRAINT agent_attachment_kind_check CHECK (kind IN ('image','text','document')),
  ADD COLUMN parse_status text NOT NULL DEFAULT 'ready' CHECK (parse_status IN ('ready','quarantined')),
  ADD COLUMN quarantine_code text NOT NULL DEFAULT '',
  ADD COLUMN page_count integer CHECK (page_count IS NULL OR page_count BETWEEN 1 AND 100),
  ADD COLUMN page_basis text NOT NULL DEFAULT '',
  ADD COLUMN row_count integer CHECK (row_count IS NULL OR row_count BETWEEN 1 AND 10000),
  ADD COLUMN extracted_chars integer CHECK (extracted_chars IS NULL OR extracted_chars >= 0),
  ADD COLUMN injected_chars integer CHECK (injected_chars IS NULL OR injected_chars BETWEEN 0 AND 20000),
  ADD COLUMN truncated_from integer CHECK (truncated_from IS NULL OR truncated_from > 0),
  ADD COLUMN truncated_to integer CHECK (truncated_to IS NULL OR truncated_to >= 0);
ALTER TABLE agent_attachment
  ADD COLUMN upload_request_id uuid,
  ADD COLUMN upload_payload_hash char(64);
CREATE UNIQUE INDEX agent_attachment_upload_request ON agent_attachment(workspace_id,user_id,upload_request_id)
  WHERE upload_request_id IS NOT NULL;
CREATE TABLE agent_attachment_load (
  run_id uuid NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  attachment_id uuid NOT NULL REFERENCES agent_attachment(id) ON DELETE CASCADE,
  chars integer NOT NULL CHECK (chars BETWEEN 0 AND 20000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id,attachment_id)
);
CREATE INDEX agent_attachment_load_attachment ON agent_attachment_load(attachment_id,run_id);

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_attachment WHERE kind='document' OR upload_request_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM agent_attachment_load) THEN
    RAISE EXCEPTION '解析附件仍有数据，拒绝回滚以免丢失原文件与回执；请保留字段并前滚修复';
  END IF;
END;
$$;
-- +goose StatementEnd
ALTER TABLE agent_attachment DROP CONSTRAINT agent_attachment_kind_check;
DROP TABLE agent_attachment_load;
DROP INDEX agent_attachment_upload_request;
ALTER TABLE agent_attachment
  DROP COLUMN upload_payload_hash,
  DROP COLUMN upload_request_id,
  DROP COLUMN truncated_to,
  DROP COLUMN truncated_from,
  DROP COLUMN injected_chars,
  DROP COLUMN extracted_chars,
  DROP COLUMN row_count,
  DROP COLUMN page_basis,
  DROP COLUMN page_count,
  DROP COLUMN quarantine_code,
  DROP COLUMN parse_status,
  ADD CONSTRAINT agent_attachment_kind_check CHECK (kind IN ('image','text'));
