-- +goose Up
CREATE INDEX hot_item_title_trgm ON hot_item USING gin (title_norm gin_trgm_ops);
CREATE INDEX audit_log_target_created ON audit_log (target_id, created_at DESC);
CREATE INDEX work_account_updated ON work (account_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX topic_account_order ON topic (account_id, pinned_at DESC NULLS LAST, created_at DESC) WHERE deleted_at IS NULL;

-- +goose Down
DROP INDEX topic_account_order;
DROP INDEX work_account_updated;
DROP INDEX audit_log_target_created;
DROP INDEX hot_item_title_trgm;
