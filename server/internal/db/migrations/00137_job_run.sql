-- +goose Up
-- REF41 F3：定时任务补跑。docs/41 计划 00130_job_run.sql 已被 A5 占用
--（D-211），00131–00136 已按 A7/C1/C3/E2/E1/F1 顺延，实际取 00137（决策随实施登记）。
-- job_run 统一台账：计划时间/开始/结束/状态/耗时/错误/是否补跑；
-- workspace_id 可空 = 系统级 job；唯一键抢占避免多实例重复补跑。

CREATE TABLE job_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,
  job_key text NOT NULL CHECK (char_length(job_key) BETWEEN 1 AND 80),
  scheduled_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','succeeded','failed','skipped')),
  catch_up boolean NOT NULL DEFAULT false,
  duration_ms int CHECK (duration_ms IS NULL OR duration_ms >= 0),
  error_code text NOT NULL DEFAULT '',
  error_message text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX job_run_slot ON job_run(
  COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), job_key, scheduled_at
);
CREATE INDEX job_run_recent ON job_run(job_key, scheduled_at DESC);

-- +goose Down
DROP INDEX IF EXISTS job_run_recent;
DROP INDEX IF EXISTS job_run_slot;
DROP TABLE IF EXISTS job_run;
