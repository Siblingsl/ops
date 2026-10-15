-- +goose Up
ALTER TABLE ai_feedback ADD COLUMN sample_text text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE ai_feedback DROP COLUMN sample_text;
