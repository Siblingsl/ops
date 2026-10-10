-- +goose Up
CREATE TABLE hot_rank_history(hot_item_id uuid NOT NULL REFERENCES hot_item(id) ON DELETE CASCADE,observed_at timestamptz NOT NULL,rank int NOT NULL,heat text NOT NULL DEFAULT '',PRIMARY KEY(hot_item_id,observed_at));
CREATE INDEX hot_history_time ON hot_rank_history(observed_at);
-- +goose Down
DROP TABLE hot_rank_history;
