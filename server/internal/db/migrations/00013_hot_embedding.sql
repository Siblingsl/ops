-- +goose Up
ALTER TABLE content_embedding DROP CONSTRAINT content_embedding_object_type_check;
ALTER TABLE content_embedding ADD CONSTRAINT content_embedding_object_type_check CHECK (object_type IN ('material','section','hot'));

-- +goose Down
DELETE FROM content_embedding WHERE object_type='hot';
ALTER TABLE content_embedding DROP CONSTRAINT content_embedding_object_type_check;
ALTER TABLE content_embedding ADD CONSTRAINT content_embedding_object_type_check CHECK (object_type IN ('material','section'));
