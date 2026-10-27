-- DEV-AW10 / D-152：受限例行任务、唯一执行槽与无用户session的受限运行。
-- +goose Up
ALTER TABLE agent_run DROP CONSTRAINT agent_run_trigger_check;
ALTER TABLE agent_run ADD CONSTRAINT agent_run_trigger_check
  CHECK (trigger IN ('message','continue','regenerate','edit','plan_accept','answer','queue','goal','compact','routine'));
ALTER TABLE agent_run ALTER COLUMN session_id DROP NOT NULL;

CREATE TABLE agent_routine (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  account_id         uuid NOT NULL REFERENCES platform_account(id),
  revision           bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  name               text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  prompt             text NOT NULL CHECK (char_length(btrim(prompt)) BETWEEN 1 AND 4000),
  public_context_refs jsonb NOT NULL DEFAULT '[]'::jsonb
                     CHECK (jsonb_typeof(public_context_refs)='array' AND jsonb_array_length(public_context_refs)<=12),
  cadence            text NOT NULL CHECK (cadence IN ('once','daily','weekly')),
  weekday            smallint CHECK (weekday BETWEEN 1 AND 7),
  time_of_day        time NOT NULL,
  once_at            timestamptz,
  timezone            text NOT NULL DEFAULT 'Asia/Shanghai' CHECK (timezone='Asia/Shanghai'),
  destination        text NOT NULL CHECK (destination IN ('current','new')),
  conversation_id    uuid REFERENCES agent_conversation(id) ON DELETE SET NULL,
  model_provider_id  uuid NOT NULL REFERENCES model_provider(id),
  model              text NOT NULL CHECK (char_length(btrim(model)) BETWEEN 1 AND 200),
  status             text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled','paused','completed','deleted')),
  next_due_at        timestamptz,
  failure_count      smallint NOT NULL DEFAULT 0 CHECK (failure_count BETWEEN 0 AND 3),
  error_code         text NOT NULL DEFAULT '' CHECK (char_length(error_code)<=80),
  last_run_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((destination='current' AND conversation_id IS NOT NULL) OR
         (destination='new' AND conversation_id IS NULL)),
  CHECK ((cadence='once' AND once_at IS NOT NULL AND weekday IS NULL) OR
         (cadence='daily' AND once_at IS NULL AND weekday IS NULL) OR
         (cadence='weekly' AND once_at IS NULL AND weekday IS NOT NULL))
);
CREATE INDEX agent_routine_owner_status ON agent_routine(workspace_id,user_id,status,updated_at DESC);
CREATE INDEX agent_routine_due ON agent_routine(next_due_at,id) WHERE status='enabled' AND next_due_at IS NOT NULL;

CREATE TABLE agent_routine_occurrence (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_id   uuid NOT NULL REFERENCES agent_routine(id) ON DELETE CASCADE,
  due_at       timestamptz NOT NULL,
  request_id   uuid NOT NULL,
  kind         text NOT NULL DEFAULT 'scheduled' CHECK (kind IN ('scheduled','manual')),
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','leased','running','completed','failed','missed','interrupted')),
  lease_token  uuid,
  lease_until  timestamptz,
  run_id       uuid REFERENCES agent_run(id) ON DELETE SET NULL,
  error_code   text NOT NULL DEFAULT '' CHECK (char_length(error_code)<=80),
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (routine_id,due_at)
);
CREATE UNIQUE INDEX agent_routine_occurrence_request ON agent_routine_occurrence(routine_id,request_id);
CREATE UNIQUE INDEX agent_routine_one_active_occurrence ON agent_routine_occurrence(routine_id)
  WHERE status IN ('pending','leased','running');
CREATE INDEX agent_routine_occurrence_list ON agent_routine_occurrence(routine_id,due_at DESC,id DESC);

ALTER TABLE agent_run ADD COLUMN routine_occurrence_id uuid REFERENCES agent_routine_occurrence(id) ON DELETE SET NULL;
CREATE INDEX agent_run_routine_occurrence ON agent_run(routine_occurrence_id) WHERE routine_occurrence_id IS NOT NULL;

CREATE TABLE agent_routine_event (
  seq         bigserial PRIMARY KEY,
  routine_id  uuid NOT NULL REFERENCES agent_routine(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (char_length(type) BETWEEN 1 AND 60),
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload)='object'),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_routine_event_list ON agent_routine_event(routine_id,seq DESC);

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_routine)
     OR EXISTS (SELECT 1 FROM agent_routine_occurrence)
     OR EXISTS (SELECT 1 FROM agent_run WHERE trigger='routine' OR routine_occurrence_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM agent_routine_event) THEN
    RAISE EXCEPTION '例行任务、执行记录或运行数据仍存在，拒绝破坏性回滚；请保留数据并前滚修复';
  END IF;
END;
$$;
-- +goose StatementEnd
DROP INDEX agent_run_routine_occurrence;
ALTER TABLE agent_run DROP COLUMN routine_occurrence_id;
DROP TABLE agent_routine_event;
DROP INDEX agent_routine_occurrence_list;
DROP INDEX agent_routine_one_active_occurrence;
DROP INDEX agent_routine_occurrence_request;
DROP TABLE agent_routine_occurrence;
DROP INDEX agent_routine_due;
DROP INDEX agent_routine_owner_status;
DROP TABLE agent_routine;
ALTER TABLE agent_run ALTER COLUMN session_id SET NOT NULL;
ALTER TABLE agent_run DROP CONSTRAINT agent_run_trigger_check;
ALTER TABLE agent_run ADD CONSTRAINT agent_run_trigger_check
  CHECK (trigger IN ('message','continue','regenerate','edit','plan_accept','answer','queue','goal','compact'));
