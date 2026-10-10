-- +goose Up
ALTER TABLE hot_item ADD COLUMN page_title text NOT NULL DEFAULT '',ADD COLUMN summary_at timestamptz;
CREATE TABLE crawl_summary_url(url text PRIMARY KEY,attempt_at timestamptz NOT NULL);
CREATE TABLE crawl_summary_state(source_key text PRIMARY KEY REFERENCES crawl_source(key) ON DELETE CASCADE,last_attempt_at timestamptz NOT NULL);
-- +goose Down
DROP TABLE crawl_summary_state;
DROP TABLE crawl_summary_url;
ALTER TABLE hot_item DROP COLUMN page_title,DROP COLUMN summary_at;
