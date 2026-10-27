-- DEV-AW09 / D-152：持久目标预算、跨运行证据与显式摘要运行。

-- +goose Up
ALTER TABLE agent_run DROP CONSTRAINT agent_run_trigger_check;
ALTER TABLE agent_run ADD CONSTRAINT agent_run_trigger_check
  CHECK (trigger IN ('message','continue','regenerate','edit','plan_accept','answer','queue','goal','compact'));

CREATE TABLE agent_goal (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id       uuid NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
  workspace_id          uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  revision              bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  objective             text NOT NULL CHECK (char_length(btrim(objective)) BETWEEN 1 AND 500),
  criteria              jsonb NOT NULL CHECK (jsonb_typeof(criteria)='array' AND jsonb_array_length(criteria) BETWEEN 1 AND 5),
  constraints_text      text NOT NULL DEFAULT '' CHECK (char_length(constraints_text) <= 1000),
  account_id            uuid REFERENCES platform_account(id) ON DELETE SET NULL,
  model_provider_id     uuid REFERENCES model_provider(id) ON DELETE SET NULL,
  model                 text NOT NULL DEFAULT '',
  allow_background      boolean NOT NULL DEFAULT false,
  status                text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','paused','waiting_user','completed','blocked','budget_limited','cancelled')),
  run_budget            integer NOT NULL DEFAULT 10 CHECK (run_budget BETWEEN 1 AND 10),
  seconds_budget        integer NOT NULL DEFAULT 1800 CHECK (seconds_budget BETWEEN 60 AND 1800),
  token_budget          integer CHECK (token_budget IS NULL OR token_budget BETWEEN 1000 AND 100000),
  used_runs             integer NOT NULL DEFAULT 0 CHECK (used_runs >= 0),
  used_seconds          integer NOT NULL DEFAULT 0 CHECK (used_seconds >= 0),
  used_tokens           integer NOT NULL DEFAULT 0 CHECK (used_tokens >= 0),
  no_progress_runs      integer NOT NULL DEFAULT 0 CHECK (no_progress_runs BETWEEN 0 AND 2),
  progress_run_id       uuid REFERENCES agent_run(id) ON DELETE SET NULL,
  plan_id               uuid REFERENCES agent_plan(id) ON DELETE SET NULL,
  blocker               text NOT NULL DEFAULT '' CHECK (char_length(blocker) <= 500),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agent_goal_one_open_per_conversation ON agent_goal(conversation_id)
  WHERE status NOT IN ('completed','cancelled');
CREATE INDEX agent_goal_owner_status ON agent_goal(workspace_id,user_id,status,updated_at DESC);

ALTER TABLE agent_run ADD COLUMN goal_id uuid REFERENCES agent_goal(id) ON DELETE SET NULL;
CREATE INDEX agent_run_goal ON agent_run(goal_id,started_at DESC) WHERE goal_id IS NOT NULL;

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_goal)
     OR EXISTS (SELECT 1 FROM agent_run WHERE goal_id IS NOT NULL OR trigger IN ('goal','compact')) THEN
    RAISE EXCEPTION '目标或摘要运行数据仍存在，拒绝破坏性回滚；请保留数据并前滚修复';
  END IF;
END;
$$;
-- +goose StatementEnd
DROP INDEX agent_run_goal;
ALTER TABLE agent_run DROP COLUMN goal_id;
DROP INDEX agent_goal_owner_status;
DROP INDEX agent_goal_one_open_per_conversation;
DROP TABLE agent_goal;
ALTER TABLE agent_run DROP CONSTRAINT agent_run_trigger_check;
ALTER TABLE agent_run ADD CONSTRAINT agent_run_trigger_check
  CHECK (trigger IN ('message','continue','regenerate','edit','plan_accept','answer','queue'));
