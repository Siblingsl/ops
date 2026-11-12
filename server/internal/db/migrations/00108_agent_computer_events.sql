-- +goose Up
-- DEV-CU P4-12（docs/36 §4.13）+ 委派事件补口：事件类型白名单按代码实际使用补齐。
-- P4-4 起的 emitComputerCommandEvent 写 computer.command_requested / started / finished；
-- delegation.* 七类由委派域 appendAgentEvent 写入（00091 只登记了 browser 系）。
-- 未登记前违反 agent_event_type_check（23514），事件 best-effort 全部静默丢失。
-- delegation.cancel_requested / budget_increased / adoption_released 属服务端内部状态
-- 事件（D-117 卡片与时间线消费），与 browser.* 的先例同级登记。
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
