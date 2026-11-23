-- +goose Up
-- REF41 F1：日志脱敏与告警。alert_rule 四种规则（阈值/窗口/启停），
-- alert_event 去重（workspace+dedupe_key）与恢复语义；告警消息只含计数与规则，
-- 不含正文/密钥。job_run 随 F3 落库，首版四规则基于现有表聚合。

CREATE TABLE alert_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  key text NOT NULL CHECK (key IN ('job_failure_rate','publish_failure_count','model_5xx_count','health_failure_count')),
  threshold numeric NOT NULL CHECK (threshold >= 0),
  window_minutes int NOT NULL DEFAULT 60 CHECK (window_minutes BETWEEN 5 AND 1440),
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, key)
);

CREATE TABLE alert_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  rule_id uuid NOT NULL REFERENCES alert_rule(id) ON DELETE CASCADE,
  dedupe_key text NOT NULL,
  message text NOT NULL,
  state text NOT NULL DEFAULT 'firing' CHECK (state IN ('firing','resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (workspace_id, dedupe_key)
);

-- +goose Down
DROP TABLE IF EXISTS alert_event;
DROP TABLE IF EXISTS alert_rule;
