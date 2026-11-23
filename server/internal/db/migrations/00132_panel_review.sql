-- +goose Up
-- REF41 C1：智囊团（先 5 席受众）。多角色并行审稿：每席独立调用（并发 ≤3），
-- 输出固定结构（结论/优点/风险/疑问/建议）；汇总只聚合不制造新观点；
-- 部分席位失败 → partial 保留成功席；不伪造失败席位意见；不自动改稿。

CREATE TABLE panel_review (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  work_id uuid NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  work_revision int NOT NULL CHECK (work_revision > 0),
  audiences text[] NOT NULL CHECK (array_length(audiences,1) BETWEEN 1 AND 12),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','partial','done','failed')),
  results jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(results)='array'),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_call_ids uuid[] NOT NULL DEFAULT '{}',
  model text NOT NULL DEFAULT '',
  prompt_version text NOT NULL DEFAULT '',
  created_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX panel_review_work ON panel_review(work_id, created_at DESC);

-- +goose Down
DROP INDEX IF EXISTS panel_review_work;
DROP TABLE IF EXISTS panel_review;
