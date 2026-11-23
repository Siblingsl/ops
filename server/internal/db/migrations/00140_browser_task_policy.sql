-- +goose Up
-- REF41 F5：浏览器任务三道闸。策略表（目的/URL 白名单/账号/48h 时效/动作）；
-- 执行前三道闸：策略存在未过期、账号匹配、单标签页；全站模式禁止；
-- 过期自动失效（查询侧以 expires_at 判定，status='expired' 由 job 归档）。

CREATE TABLE browser_task_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  account_id uuid REFERENCES platform_account(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('publish_fill','publish_health','publish_patrol','benchmark_observe','followers')),
  url_patterns text[] NOT NULL CHECK (array_length(url_patterns,1) BETWEEN 1 AND 20),
  allowed_actions text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','expired')),
  created_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at <= created_at + interval '48 hours')
);
CREATE INDEX browser_task_policy_ws ON browser_task_policy(workspace_id, status, expires_at DESC);

-- +goose Down
DROP INDEX IF EXISTS browser_task_policy_ws;
DROP TABLE IF EXISTS browser_task_policy;
