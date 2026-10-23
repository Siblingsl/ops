-- ST-08: keep deleted custom sensitive words recoverable in the recycle bin.

-- +goose Up
ALTER TABLE sensitive_word ADD COLUMN deleted_at timestamptz;
CREATE INDEX sensitive_word_deleted_workspace
  ON sensitive_word (workspace_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

-- +goose Down
DROP INDEX sensitive_word_deleted_workspace;
ALTER TABLE sensitive_word DROP COLUMN deleted_at;
