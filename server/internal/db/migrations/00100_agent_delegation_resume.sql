-- DEV-A13（W06 父 run 续接，docs/32 v1.0）：组等待态、承接标记、任务级预算账本、子 run 归属。
-- 仅加列/加表/扩展 CHECK；旧二进制遇到新列不受影响（列均可空或有默认）。
-- 注：agent_run.parent_run_id 已由 00067（排队输入派生的 fork 来源）存在，本迁移复用该列，
-- 子 run 的 parent_run_id 指向派发它的父 run；root_run_id 为本次新增。
-- +goose Up
ALTER TABLE agent_run
  ADD COLUMN root_run_id uuid REFERENCES agent_run(id) ON DELETE SET NULL,
  ADD COLUMN delegation_group_id uuid,
  ADD COLUMN delegation_id uuid;

-- 子 run 真实来源（00065 只允许 interactive/goal/routine，派发时子 run 落库被写成 interactive）。
ALTER TABLE agent_run DROP CONSTRAINT agent_run_execution_origin_check;
ALTER TABLE agent_run ADD CONSTRAINT agent_run_execution_origin_check
  CHECK (execution_origin IN ('interactive','goal','routine','delegation'));

ALTER TABLE agent_delegation_group
  ADD COLUMN parent_ended_at timestamptz,
  ADD COLUMN parent_end_run_id uuid REFERENCES agent_run(id) ON DELETE SET NULL,
  ADD COLUMN adopted_run_id uuid REFERENCES agent_run(id) ON DELETE SET NULL,
  ADD COLUMN adopted_at timestamptz,
  ADD COLUMN adoption_count integer NOT NULL DEFAULT 0,
  ADD COLUMN results_consumed_at timestamptz,
  ADD COLUMN consumed_by_run_id uuid REFERENCES agent_run(id) ON DELETE SET NULL;

-- 承接查询按会话找"待承接组"；部分索引避免扫历史终态组。
CREATE INDEX idx_agent_delegation_group_adoptable ON agent_delegation_group(conversation_id, state)
  WHERE state IN ('active','waiting_user');

-- 任务级预算账本（27 §11.3.3）：一次任务一个池，跨 run 不重复领取。
-- rounds_limit 由调用方按 max(agentMaxRounds, 累计委派上限×每子 4 轮 + 父汇总 2 轮) 计算；
-- 本表只做不变量约束，不内置业务默认值。
CREATE TABLE agent_task_budget (
  budget_scope_id   uuid PRIMARY KEY,
  conversation_id   uuid NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
  root_run_id       uuid NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  rounds_limit      integer NOT NULL CHECK (rounds_limit > 0),
  rounds_reserved   integer NOT NULL DEFAULT 0 CHECK (rounds_reserved >= 0),
  rounds_used       integer NOT NULL DEFAULT 0 CHECK (rounds_used >= 0),
  seconds_limit     integer NOT NULL CHECK (seconds_limit > 0),
  seconds_reserved  integer NOT NULL DEFAULT 0 CHECK (seconds_reserved >= 0),
  seconds_used      integer NOT NULL DEFAULT 0 CHECK (seconds_used >= 0),
  tokens_limit      integer CHECK (tokens_limit IS NULL OR tokens_limit > 0),
  tokens_used       integer NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  revision          integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_task_budget_rounds CHECK (rounds_used + rounds_reserved <= rounds_limit),
  CONSTRAINT agent_task_budget_seconds CHECK (seconds_used + seconds_reserved <= seconds_limit),
  CONSTRAINT agent_task_budget_tokens CHECK (tokens_limit IS NULL OR tokens_used <= tokens_limit)
);

ALTER TABLE agent_event DROP CONSTRAINT agent_event_type_check;
ALTER TABLE agent_event ADD CONSTRAINT agent_event_type_check CHECK (type IN (
    'run.started','run.stage','run.ended','message.delta','message.snapshot','message.saved',
    'tool.started','tool.ended','input.created','input.updated','input.consumed',
    'question.created','question.resolved','plan.updated','goal.updated','action.updated',
    'artifact.created','context.updated','conversation.updated',
    'browser.connection_changed','browser.scope_requested','browser.control_changed',
    'browser.command_started','browser.command_finished','browser.evidence_created',
    'browser.handoff_requested',
    'delegation.created','delegation.state_changed','delegation.result_ready','delegation.cancel_requested',
    'delegation.group_waiting_user','delegation.group_adopted','delegation.adoption_released',
    'delegation.budget_increased'));

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_delegation_group WHERE adoption_count > 0)
     OR EXISTS (SELECT 1 FROM agent_task_budget)
     OR EXISTS (SELECT 1 FROM agent_run WHERE execution_origin = 'delegation') THEN
    RAISE EXCEPTION '拒绝回滚：存在承接记录/预算账本/子 run 归属，请前滚修复';
  END IF;
END $$;
-- +goose StatementEnd

ALTER TABLE agent_event DROP CONSTRAINT agent_event_type_check;
ALTER TABLE agent_event ADD CONSTRAINT agent_event_type_check CHECK (type IN (
    'run.started','run.stage','run.ended','message.delta','message.snapshot','message.saved',
    'tool.started','tool.ended','input.created','input.updated','input.consumed',
    'question.created','question.resolved','plan.updated','goal.updated','action.updated',
    'artifact.created','context.updated','conversation.updated',
    'browser.connection_changed','browser.scope_requested','browser.control_changed',
    'browser.command_started','browser.command_finished','browser.evidence_created',
    'browser.handoff_requested',
    'delegation.created','delegation.state_changed','delegation.result_ready','delegation.cancel_requested'));

DROP TABLE IF EXISTS agent_task_budget;
DROP INDEX IF EXISTS idx_agent_delegation_group_adoptable;

ALTER TABLE agent_delegation_group
  DROP COLUMN consumed_by_run_id,
  DROP COLUMN results_consumed_at,
  DROP COLUMN adoption_count,
  DROP COLUMN adopted_at,
  DROP COLUMN adopted_run_id,
  DROP COLUMN parent_end_run_id,
  DROP COLUMN parent_ended_at;

ALTER TABLE agent_run DROP CONSTRAINT agent_run_execution_origin_check;
ALTER TABLE agent_run ADD CONSTRAINT agent_run_execution_origin_check
  CHECK (execution_origin IN ('interactive','goal','routine'));

ALTER TABLE agent_run
  DROP COLUMN delegation_id,
  DROP COLUMN delegation_group_id,
  DROP COLUMN root_run_id;
