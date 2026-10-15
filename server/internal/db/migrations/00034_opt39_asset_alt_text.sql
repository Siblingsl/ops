-- +goose Up
ALTER TABLE asset ADD COLUMN alt_text text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE asset DROP COLUMN alt_text;
