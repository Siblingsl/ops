-- +goose Up
-- DEV-DR08：区分人手动发起的复盘和每周后台生成的复盘草稿（14 文档 4.6 第 2 条）。
ALTER TABLE review_report ADD COLUMN origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'weekly_draft'));

-- +goose Down
ALTER TABLE review_report DROP COLUMN origin;
