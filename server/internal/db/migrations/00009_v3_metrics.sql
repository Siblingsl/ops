-- +goose Up
-- D-046 第 10 节指标：从选题到首稿时间（作品创建到所有段落第一次都有内容）。
ALTER TABLE work ADD COLUMN IF NOT EXISTS first_draft_at timestamptz;

-- EX-G-02：收藏的金句（来自 EX-E-08 金句候选），排版建议优先建议加粗。
ALTER TABLE work ADD COLUMN IF NOT EXISTS golden_sentences text[] NOT NULL DEFAULT '{}';

-- 00008 在部分本地库应用后又补过列；这里幂等补齐，避免旧库缺列。
ALTER TABLE work ADD COLUMN IF NOT EXISTS reviewer_id uuid REFERENCES app_user(id) ON DELETE SET NULL;
ALTER TABLE review_report ADD COLUMN IF NOT EXISTS ignored int[] NOT NULL DEFAULT '{}';
ALTER TABLE ai_call ADD COLUMN IF NOT EXISTS is_eval boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE work DROP COLUMN IF EXISTS golden_sentences;
ALTER TABLE work DROP COLUMN IF EXISTS first_draft_at;
