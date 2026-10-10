-- +goose Up
-- EX-E-07 标题工作台：收藏的候选保存在作品上，换设备、协作成员都能看到。
ALTER TABLE work ADD COLUMN IF NOT EXISTS title_favorites jsonb NOT NULL DEFAULT '[]';

-- +goose Down
ALTER TABLE work DROP COLUMN IF EXISTS title_favorites;
