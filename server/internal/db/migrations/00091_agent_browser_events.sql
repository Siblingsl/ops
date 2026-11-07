-- +goose Up
-- DEV-AI27-04 第二批：浏览器命令事件类型进 agent_event 白名单（27 §13.6）。
ALTER TABLE agent_event DROP CONSTRAINT agent_event_type_check;
ALTER TABLE agent_event ADD CONSTRAINT agent_event_type_check CHECK (type IN (
    'run.started','run.stage','run.ended','message.delta','message.snapshot','message.saved',
    'tool.started','tool.ended','input.created','input.updated','input.consumed',
    'question.created','question.resolved','plan.updated','goal.updated','action.updated',
    'artifact.created','context.updated','conversation.updated',
    'browser.connection_changed','browser.scope_requested','browser.control_changed',
    'browser.command_started','browser.command_finished','browser.evidence_created',
    'browser.handoff_requested'));

-- +goose Down
ALTER TABLE agent_event DROP CONSTRAINT agent_event_type_check;
ALTER TABLE agent_event ADD CONSTRAINT agent_event_type_check CHECK (type IN (
    'run.started','run.stage','run.ended','message.delta','message.snapshot','message.saved',
    'tool.started','tool.ended','input.created','input.updated','input.consumed',
    'question.created','question.resolved','plan.updated','goal.updated','action.updated',
    'artifact.created','context.updated','conversation.updated'));
DELETE FROM agent_event WHERE type LIKE 'browser.%';
