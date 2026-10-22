-- D-133 / DEV-AS03：把 v1/v2 run 的访问预留与实际消耗留在共享执行记录中。

-- +goose Up
ALTER TABLE platform_sync_run
  ADD COLUMN budget_query_count int NOT NULL DEFAULT 0 CHECK (budget_query_count BETWEEN 0 AND 100),
  ADD COLUMN budget_work_attempts int NOT NULL DEFAULT 0 CHECK (budget_work_attempts BETWEEN 0 AND 20),
  ADD COLUMN budget_static_requests int NOT NULL DEFAULT 0 CHECK (budget_static_requests BETWEEN 0 AND 500),
  ADD COLUMN budget_static_bytes bigint NOT NULL DEFAULT 0 CHECK (budget_static_bytes BETWEEN 0 AND 52428800),
  ADD COLUMN budget_result_rows int NOT NULL DEFAULT 0 CHECK (budget_result_rows BETWEEN 0 AND 100),
  ADD COLUMN budget_result_bytes bigint NOT NULL DEFAULT 0 CHECK (budget_result_bytes BETWEEN 0 AND 8388608),
  ADD COLUMN last_data_query_at timestamptz;

-- 旧端不会报告查询动作；对今天的 v1 运行保守预留单 run 上限，防止升级瞬间重置当日预算。
UPDATE platform_sync_run
SET budget_query_count=100
WHERE wire_protocol_version=1
  AND created_at >= ((now() AT TIME ZONE 'Asia/Shanghai')::date::timestamp AT TIME ZONE 'Asia/Shanghai');

CREATE INDEX platform_sync_run_subject_budget
  ON platform_sync_run (connection_id, created_at DESC)
  INCLUDE (budget_query_count, budget_work_attempts, budget_static_requests, budget_static_bytes, last_data_query_at);

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_sync_run WHERE budget_query_count > 0 OR budget_work_attempts > 0
      OR budget_static_requests > 0 OR budget_static_bytes > 0 OR budget_result_rows > 0
      OR budget_result_bytes > 0 OR last_data_query_at IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot roll back platform sync budget while usage data exists';
  END IF;
END
$$;
-- +goose StatementEnd

DROP INDEX platform_sync_run_subject_budget;
ALTER TABLE platform_sync_run DROP COLUMN budget_query_count, DROP COLUMN budget_work_attempts,
  DROP COLUMN budget_static_requests, DROP COLUMN budget_static_bytes, DROP COLUMN budget_result_rows,
  DROP COLUMN budget_result_bytes, DROP COLUMN last_data_query_at;
