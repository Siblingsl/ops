-- +goose Up
-- DEV-AI27-15（W15）：子智能体委派组与委派（27 文档 §11.3 提案契约本机实现批）。
-- 约束：单父 run 并发子 run ≤2、累计委派 ≤4、深度 1（子 run 不得再委派）；
-- 子 run 归属原用户/工作区，权限=父权限∩显式委派范围∩执行器策略；
-- 子只能提案（result_artifact_id），不能创建可自执行写卡；取消传播走 cancel_generation。

CREATE TABLE agent_delegation_group (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
    root_run_id uuid NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
    current_parent_run_id uuid NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
    state varchar(16) NOT NULL DEFAULT 'active',
    budget_scope_id uuid NOT NULL,
    budget_used integer NOT NULL DEFAULT 0,
    budget_reserved integer NOT NULL DEFAULT 0,
    cancel_generation integer NOT NULL DEFAULT 0,
    revision integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_delegation_group_state CHECK (
        state IN ('active','waiting_user','completed','cancelled','failed'))
);
CREATE INDEX idx_agent_delegation_group_parent ON agent_delegation_group(current_parent_run_id, state);
CREATE INDEX idx_agent_delegation_group_conversation ON agent_delegation_group(conversation_id, state);

CREATE TABLE agent_delegation (
    id uuid PRIMARY KEY,
    group_id uuid NOT NULL REFERENCES agent_delegation_group(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    parent_run_id uuid NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
    -- 子 run 由 W06 派发时创建（agent_run_one_active 约束禁止同会话多活动 run）；
    -- 委派行先建，child_run_id 在派发时回填。
    child_run_id uuid REFERENCES agent_run(id) ON DELETE SET NULL,
    task text NOT NULL,
    context_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(context_refs) = 'array'),
    allowed_tools text[] NOT NULL DEFAULT '{}',
    resource_scopes jsonb NOT NULL DEFAULT '{}'::jsonb,
    scope_hash varchar(64) NOT NULL,
    budget_reserved integer NOT NULL DEFAULT 0,
    model varchar(128) NOT NULL DEFAULT '',
    state varchar(16) NOT NULL DEFAULT 'queued',
    generation integer NOT NULL DEFAULT 0,
    result_artifact_id uuid,
    result_summary text NOT NULL DEFAULT '',
    error_code varchar(64) NOT NULL DEFAULT '',
    request_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_delegation_state CHECK (
        state IN ('queued','running','waiting_user','succeeded','failed','cancelling','cancelled','expired')));
CREATE INDEX idx_agent_delegation_group ON agent_delegation(group_id, state);
CREATE INDEX idx_agent_delegation_run ON agent_delegation(parent_run_id, state);

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

-- +goose Down
ALTER TABLE agent_event DROP CONSTRAINT agent_event_type_check;
ALTER TABLE agent_event ADD CONSTRAINT agent_event_type_check CHECK (type IN (
    'run.started','run.stage','run.ended','message.delta','message.snapshot','message.saved',
    'tool.started','tool.ended','input.created','input.updated','input.consumed',
    'question.created','question.resolved','plan.updated','goal.updated','action.updated',
    'artifact.created','context.updated','conversation.updated',
    'browser.connection_changed','browser.scope_requested','browser.control_changed',
    'browser.command_started','browser.command_finished','browser.evidence_created',
    'browser.handoff_requested'));
DELETE FROM agent_delegation;
DELETE FROM agent_delegation_group;
DROP TABLE IF EXISTS agent_delegation;
DROP TABLE IF EXISTS agent_delegation_group;
