-- +goose Up
ALTER TABLE work ADD COLUMN tags text[] NOT NULL DEFAULT '{}';

-- +goose Down
ALTER TABLE work DROP COLUMN tags;
