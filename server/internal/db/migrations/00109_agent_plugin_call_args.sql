-- +goose Up
-- CF-DESK-03（90 D-186 已批准，2026-11-13）：run 内 tools/call 执行链路——调用账本
-- 增列 args/result 脱敏快照与 schema/目录绑定（契约 §2.2；27 §11.2.4 回执要求）。
-- 凭据字段不进 args_json / result_json / 回执 / 日志（27 §11.2.3 第 3 点）。

ALTER TABLE agent_plugin_call
    ADD COLUMN args_json jsonb,
    ADD COLUMN result_json jsonb,
    ADD COLUMN input_schema_hash varchar(64) NOT NULL DEFAULT '',
    ADD COLUMN catalog_revision varchar(64) NOT NULL DEFAULT '',
    ADD COLUMN protocol_version varchar(32) NOT NULL DEFAULT '',
    ADD COLUMN result_hash varchar(64) NOT NULL DEFAULT '';

-- 事件类型白名单补齐：run 内 MCP 调用时间线事件（契约 §2.2 第 4 点）。
-- 未登记前违反 agent_event_type_check（23514），事件会静默丢失（同 00108 的踩坑记录）。
ALTER TABLE agent_event DROP CONSTRAINT agent_event_type_check;
ALTER TABLE agent_event ADD CONSTRAINT agent_event_type_check CHECK (type IN (
    'run.started','run.stage','run.ended','message.delta','message.snapshot','message.saved',
    'tool.started','tool.ended','input.created','input.updated','input.consumed',
    'question.created','question.resolved','plan.updated','goal.updated','action.updated',
    'artifact.created','context.updated','conversation.updated',
    'browser.connection_changed','browser.scope_requested','browser.control_changed',
    'browser.command_started','browser.command_finished','browser.evidence_created',
    'browser.handoff_requested',
    'computer.command_requested','computer.command_started','computer.command_finished',
    'computer.target_changed','computer.approval_invalidated','computer.handoff_requested',
    'delegation.created','delegation.state_changed','delegation.cancel_requested',
    'delegation.budget_increased','delegation.adoption_released',
    'delegation.group_adopted','delegation.group_waiting_user',
    'mcp.call_requested'));

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM agent_plugin_call WHERE args_json IS NOT NULL OR result_json IS NOT NULL) THEN
        RAISE EXCEPTION 'agent_plugin_call has args/result snapshots; refusing downgrade';
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
    'computer.command_requested','computer.command_started','computer.command_finished',
    'computer.target_changed','computer.approval_invalidated','computer.handoff_requested',
    'delegation.created','delegation.state_changed','delegation.cancel_requested',
    'delegation.budget_increased','delegation.adoption_released',
    'delegation.group_adopted','delegation.group_waiting_user'));
ALTER TABLE agent_plugin_call
    DROP COLUMN IF EXISTS args_json,
    DROP COLUMN IF EXISTS result_json,
    DROP COLUMN IF EXISTS input_schema_hash,
    DROP COLUMN IF EXISTS catalog_revision,
    DROP COLUMN IF EXISTS protocol_version,
    DROP COLUMN IF EXISTS result_hash;
