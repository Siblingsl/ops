-- +goose Up
-- D-046 V3 补齐：素材全文检索列、选题置顶、标题收藏、表达体检忽略项。

ALTER TABLE material ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, '') || ' ' || coalesce(source, ''))) STORED;
CREATE INDEX IF NOT EXISTS material_search_tsv ON material USING gin (search_tsv);

ALTER TABLE topic ADD COLUMN IF NOT EXISTS pinned_at timestamptz;

ALTER TABLE work ADD COLUMN IF NOT EXISTS title_favorites jsonb NOT NULL DEFAULT '[]';
ALTER TABLE work ADD COLUMN IF NOT EXISTS polish_ignored text[] NOT NULL DEFAULT '{}';
-- EX-L-02：审阅人独立于负责人，负责人不能给自己审阅通过。
ALTER TABLE work ADD COLUMN IF NOT EXISTS reviewer_id uuid REFERENCES app_user(id) ON DELETE SET NULL;

-- EX-J-03：复盘结论"忽略"需要持久化。
ALTER TABLE review_report ADD COLUMN IF NOT EXISTS ignored int[] NOT NULL DEFAULT '{}';

-- EX-P-01：评测调用不计入用量与质量统计。
ALTER TABLE ai_call ADD COLUMN IF NOT EXISTS is_eval boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE ai_call DROP COLUMN IF EXISTS is_eval;
ALTER TABLE review_report DROP COLUMN IF EXISTS ignored;
ALTER TABLE work DROP COLUMN IF EXISTS reviewer_id;
ALTER TABLE work DROP COLUMN IF EXISTS polish_ignored, DROP COLUMN IF EXISTS title_favorites;
ALTER TABLE topic DROP COLUMN IF EXISTS pinned_at;
DROP INDEX IF EXISTS material_search_tsv;
ALTER TABLE material DROP COLUMN IF EXISTS search_tsv;
