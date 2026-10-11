-- +goose Up
ALTER TABLE copilot_message ADD COLUMN suggestions jsonb NOT NULL DEFAULT '[]'::jsonb;

-- +goose Down
ALTER TABLE copilot_message DROP COLUMN suggestions;
