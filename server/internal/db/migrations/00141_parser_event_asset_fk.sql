-- +goose Up
-- REF41 F4-N5 收口：parser_event.sample_asset_id 补外键。历史行可能含已删除/跨区样本，
-- 用 NOT VALID 先保证新写入受约束，不在迁移中回写或删除既有诊断数据。
ALTER TABLE parser_event
  ADD CONSTRAINT parser_event_sample_asset_fk
  FOREIGN KEY (sample_asset_id) REFERENCES asset(id) ON DELETE SET NULL NOT VALID;

-- +goose Down
ALTER TABLE parser_event DROP CONSTRAINT IF EXISTS parser_event_sample_asset_fk;
