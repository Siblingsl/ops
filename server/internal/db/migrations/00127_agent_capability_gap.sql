-- REF41 A3 能力缺口台账（D-209）。
-- 规格原计划 00119；00118 已由 A1 agent_truth 使用、00119 已由 A2 使用，
-- 00120–00126 已按台账 §1.1 顺延，实际取下一可用号 00127。
-- +goose Up
CREATE TABLE agent_capability_gap (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  run_id uuid REFERENCES agent_run(id) ON DELETE SET NULL,
  gap_key text NOT NULL CHECK (char_length(gap_key) BETWEEN 3 AND 80),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  detail text NOT NULL DEFAULT '' CHECK (char_length(detail) <= 1000),
  request_count int NOT NULL DEFAULT 1 CHECK (request_count >= 1),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','planned','declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, gap_key)
);
CREATE INDEX agent_capability_gap_workspace_status
  ON agent_capability_gap (workspace_id, status, updated_at DESC);

-- +goose Down
DROP TABLE IF EXISTS agent_capability_gap;
