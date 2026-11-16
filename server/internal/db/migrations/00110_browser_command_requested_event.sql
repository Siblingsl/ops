-- +goose Up
-- 2026-11-15（R 真实旅程接线发现，如实登记）：browser.command_requested 由 A30b 片 2
-- （d63e854f）的 createAgentBrowserCommand 引入并每次登记命令即发出，但事件白名单
-- 自 00091 起只登记了 command_started/finished/evidence_created，requested 从未入列
-- ——数据库 agent_event_type_check（23514）把它静默丢掉，时间线缺第一条命令事件。
-- 此前未触发是因为历史调用方均由桌面执行器在命令已 queued 后才轮询，run 内同步等待
-- 的 R 真实旅程是第一个完整走 requested → started → finished 的链路。补登记，不改状态机。
ALTER TABLE agent_event DROP CONSTRAINT agent_event_type_check;
ALTER TABLE agent_event ADD CONSTRAINT agent_event_type_check CHECK (type IN (
    'run.started','run.stage','run.ended','message.delta','message.snapshot','message.saved',
    'tool.started','tool.ended','input.created','input.updated','input.consumed',
    'question.created','question.resolved','plan.updated','goal.updated','action.updated',
    'artifact.created','context.updated','conversation.updated',
    'browser.connection_changed','browser.scope_requested','browser.control_changed',
    'browser.command_requested','browser.command_started','browser.command_finished','browser.evidence_created',
    'browser.handoff_requested',
    'computer.command_requested','computer.command_started','computer.command_finished',
    'computer.target_changed','computer.approval_invalidated','computer.handoff_requested',
    'delegation.created','delegation.state_changed','delegation.cancel_requested',
    'delegation.budget_increased','delegation.adoption_released',
    'delegation.group_adopted','delegation.group_waiting_user',
    'mcp.call_requested'));

-- +goose Down
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
DELETE FROM agent_event WHERE type = 'browser.command_requested';
