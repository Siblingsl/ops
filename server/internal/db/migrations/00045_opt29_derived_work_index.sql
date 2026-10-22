-- +goose Up
CREATE INDEX work_source_work_live ON work (source_work_id)
  WHERE source_work_id IS NOT NULL AND deleted_at IS NULL;

-- +goose Down
DROP INDEX work_source_work_live;
