-- +goose Up
-- REF41 I2：竞对作品半自动拆解。
-- docs/41 计划 00115_benchmark_decompose.sql；00115 已被并行 I4 WIP 占用，
-- 00116-00122 已按 D-195/D-196/D-197/D-198/D-199/D-200/D-203 顺延使用，
-- 实际取下一可用号 00123（D-204）。
-- 拆解草稿与当前结构分离：AI 只写 decompose_draft，用户确认后才写 structure。

ALTER TABLE benchmark_note
  ADD COLUMN decompose_state text NOT NULL DEFAULT 'none'
    CHECK (decompose_state IN ('none','ai_draft','confirmed','failed')),
  ADD COLUMN decompose_revision int NOT NULL DEFAULT 0
    CHECK (decompose_revision >= 0),
  ADD COLUMN decompose_draft jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(decompose_draft) = 'object'),
  ADD COLUMN decompose_ai_call_id uuid REFERENCES ai_call(id) ON DELETE SET NULL,
  ADD COLUMN decompose_error text NOT NULL DEFAULT '',
  ADD COLUMN decompose_confirmed_at timestamptz;

-- +goose Down
-- 只移除本迁移新增列，不触碰既有 structure/revision/ai_call_id。
ALTER TABLE benchmark_note
  DROP COLUMN IF EXISTS decompose_confirmed_at,
  DROP COLUMN IF EXISTS decompose_error,
  DROP COLUMN IF EXISTS decompose_ai_call_id,
  DROP COLUMN IF EXISTS decompose_draft,
  DROP COLUMN IF EXISTS decompose_revision,
  DROP COLUMN IF EXISTS decompose_state;
