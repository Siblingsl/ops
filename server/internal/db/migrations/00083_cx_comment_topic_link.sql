-- DEV-CX13-E / FR-CX-22：评论转选题所需的 topic 增量（8.9 表：source_comment_id 与幂等键）。
-- stock_status 等 CX13-C 库存字段不在本迁移范围。
-- +goose Up
ALTER TABLE topic ADD COLUMN IF NOT EXISTS source_comment_id uuid;
ALTER TABLE topic ADD COLUMN IF NOT EXISTS origin_request_key text;
ALTER TABLE topic ADD COLUMN IF NOT EXISTS origin_request_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS topic_origin_request_key ON topic(account_id,origin_request_key)
  WHERE origin_request_key IS NOT NULL AND deleted_at IS NULL;

-- +goose Down
DROP INDEX IF EXISTS topic_origin_request_key;
ALTER TABLE topic DROP COLUMN IF EXISTS origin_request_hash;
ALTER TABLE topic DROP COLUMN IF EXISTS origin_request_key;
ALTER TABLE topic DROP COLUMN IF EXISTS source_comment_id;
