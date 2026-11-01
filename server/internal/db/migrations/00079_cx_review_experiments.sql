-- DEV-CX13-B：多时点复盘窗口与冻结规则的单变量观察实验。
-- +goose Up
ALTER TABLE metric_snapshot
  DROP CONSTRAINT metric_snapshot_read_unit_check,
  ADD CONSTRAINT metric_snapshot_read_unit_check CHECK (read_unit IN ('users','times','count','unknown')),
  DROP CONSTRAINT metric_snapshot_share_unit_check,
  ADD CONSTRAINT metric_snapshot_share_unit_check CHECK (share_unit IN ('users','times','count','unknown'));

CREATE TABLE review_experiment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  account_id uuid NOT NULL,
  hypothesis text NOT NULL CHECK (length(btrim(hypothesis)) BETWEEN 1 AND 1000),
  variable text NOT NULL CHECK (variable IN ('title','cover','topic','format','posting_time')),
  metric_key text NOT NULL CHECK (metric_key IN ('favorite_rate','interaction_rate','follow_rate')),
  "window" text NOT NULL CHECK ("window" IN ('T1','T3','T7','T30')),
  selection_basis jsonb NOT NULL CHECK (jsonb_typeof(selection_basis)='object'),
  baseline_from date NOT NULL,
  baseline_to date NOT NULL,
  result_from date NOT NULL,
  result_to date NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','concluded','abandoned')),
  conclusion text CHECK (conclusion IN ('support','reject','inconclusive')),
  result_snapshot jsonb CHECK (result_snapshot IS NULL OR jsonb_typeof(result_snapshot)='object'),
  note text NOT NULL DEFAULT '',
  revision int NOT NULL DEFAULT 1 CHECK (revision>0),
  created_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  concluded_at timestamptz,
  FOREIGN KEY (account_id,workspace_id) REFERENCES platform_account(id,workspace_id),
  CHECK (baseline_from<=baseline_to AND result_from<=result_to AND baseline_to<result_from),
  CHECK ((status='running' AND conclusion IS NULL AND concluded_at IS NULL)
      OR (status='concluded' AND conclusion IS NOT NULL AND concluded_at IS NOT NULL)
      OR (status='abandoned' AND conclusion IS NULL AND concluded_at IS NOT NULL))
);
CREATE UNIQUE INDEX review_experiment_one_running ON review_experiment(account_id) WHERE status='running';
CREATE INDEX review_experiment_list ON review_experiment(account_id,created_at DESC,id DESC);

-- +goose Down
-- 人工实验结论及其样本引用不可通过回滚删除；已有数据时必须前滚修复。
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM review_experiment) THEN
    RAISE EXCEPTION '单变量实验含记录，拒绝回滚丢弃；请保留记录并前滚修复';
  END IF;
END;
$$;
-- +goose StatementEnd
DROP INDEX review_experiment_list;
DROP INDEX review_experiment_one_running;
DROP TABLE review_experiment;
ALTER TABLE metric_snapshot
  DROP CONSTRAINT metric_snapshot_read_unit_check,
  ADD CONSTRAINT metric_snapshot_read_unit_check CHECK (read_unit IN ('users','times','unknown')),
  DROP CONSTRAINT metric_snapshot_share_unit_check,
  ADD CONSTRAINT metric_snapshot_share_unit_check CHECK (share_unit IN ('users','times','unknown'));
