-- DEV-AW07 / D-152：版本化计划、步骤证据和结构化澄清问题。
-- +goose Up
ALTER TABLE agent_run DROP CONSTRAINT agent_run_trigger_check;
ALTER TABLE agent_run ADD CONSTRAINT agent_run_trigger_check
  CHECK (trigger IN ('message','continue','regenerate','edit','plan_accept','answer'));
ALTER TABLE agent_run DROP CONSTRAINT agent_run_status_check;
ALTER TABLE agent_run ADD CONSTRAINT agent_run_status_check
  CHECK (status IN ('queued','running','awaiting_input','awaiting_confirmation','completed','stopped','failed'));

CREATE TABLE agent_plan (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     uuid NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
  source_run_id       uuid NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  source_tool_call_id text NOT NULL,
  request_hash        char(64) NOT NULL,
  version             integer NOT NULL CHECK (version > 0),
  summary             text NOT NULL CHECK (char_length(btrim(summary)) BETWEEN 1 AND 2000),
  steps               jsonb NOT NULL CHECK (jsonb_typeof(steps)='array' AND jsonb_array_length(steps) BETWEEN 1 AND 12),
  status              text NOT NULL DEFAULT 'current' CHECK (status IN ('current','superseded')),
  accepted_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id,version),
  UNIQUE (source_run_id,source_tool_call_id)
);
CREATE UNIQUE INDEX agent_plan_one_current ON agent_plan(conversation_id) WHERE status='current';
CREATE INDEX agent_plan_history ON agent_plan(conversation_id,version DESC);

CREATE TABLE agent_plan_step_state (
  plan_id      uuid NOT NULL REFERENCES agent_plan(id) ON DELETE CASCADE,
  step_id      text NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','in_progress','waiting_user','completed','failed','skipped')),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs)='array'),
  revision     bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  source_tool_call_id text NOT NULL DEFAULT '',
  request_hash char(64) NOT NULL DEFAULT '',
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id,step_id)
);
CREATE UNIQUE INDEX agent_plan_step_source_call_unique ON agent_plan_step_state(plan_id,source_tool_call_id)
  WHERE source_tool_call_id<>'';

CREATE TABLE agent_question (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     uuid NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
  source_run_id       uuid NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  source_tool_call_id text NOT NULL,
  request_hash        char(64) NOT NULL,
  revision            bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  items               jsonb NOT NULL CHECK (jsonb_typeof(items)='array' AND jsonb_array_length(items) BETWEEN 1 AND 3),
  answers             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(answers)='array'),
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','answered','skipped','superseded','expired')),
  expires_at          timestamptz NOT NULL,
  answered_message_id uuid REFERENCES agent_message(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  UNIQUE (source_run_id),
  UNIQUE (source_run_id,source_tool_call_id)
);
CREATE UNIQUE INDEX agent_question_one_pending ON agent_question(conversation_id) WHERE status='pending';
CREATE INDEX agent_question_expiry ON agent_question(expires_at) WHERE status='pending';

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_plan) OR EXISTS (SELECT 1 FROM agent_plan_step_state)
     OR EXISTS (SELECT 1 FROM agent_question)
     OR EXISTS (SELECT 1 FROM agent_run WHERE trigger IN ('plan_accept','answer') OR status='awaiting_input') THEN
    RAISE EXCEPTION '计划或澄清数据仍存在，拒绝破坏性回滚；请保留数据并前滚修复';
  END IF;
END;
$$;
-- +goose StatementEnd
DROP TABLE agent_question, agent_plan_step_state, agent_plan;
ALTER TABLE agent_run DROP CONSTRAINT agent_run_trigger_check;
ALTER TABLE agent_run ADD CONSTRAINT agent_run_trigger_check
  CHECK (trigger IN ('message','continue','regenerate','edit'));
ALTER TABLE agent_run DROP CONSTRAINT agent_run_status_check;
ALTER TABLE agent_run ADD CONSTRAINT agent_run_status_check
  CHECK (status IN ('queued','running','awaiting_confirmation','completed','stopped','failed'));
