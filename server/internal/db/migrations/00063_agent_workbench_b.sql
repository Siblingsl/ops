-- DEV-AW06 / D-152：为同一智能体运行增加可恢复事件、partial快照与协议版本。
-- 历史消息不改写为活动事件；基线仅表示该对话的服务端快照起点。

-- +goose Up
ALTER TABLE agent_conversation
  ADD COLUMN next_event_seq bigint NOT NULL DEFAULT 0 CHECK (next_event_seq >= 0),
  ADD COLUMN read_upto_event_seq bigint NOT NULL DEFAULT 0 CHECK (read_upto_event_seq >= 0),
  ADD COLUMN event_retention_floor bigint NOT NULL DEFAULT 0 CHECK (event_retention_floor >= 0);

ALTER TABLE agent_run
  ADD COLUMN protocol_version smallint NOT NULL DEFAULT 1 CHECK (protocol_version IN (1,2)),
  ADD COLUMN request_id uuid,
  ADD COLUMN request_hash char(64) NOT NULL DEFAULT '',
  ADD COLUMN partial_message_key text NOT NULL DEFAULT '',
  ADD COLUMN partial_output text NOT NULL DEFAULT '',
  ADD COLUMN partial_chunk_index integer NOT NULL DEFAULT 0 CHECK (partial_chunk_index >= 0),
  ADD COLUMN partial_updated_at timestamptz;
CREATE UNIQUE INDEX agent_run_request_idempotency
  ON agent_run (conversation_id, trigger, request_id) WHERE request_id IS NOT NULL;

ALTER TABLE agent_message ADD COLUMN message_key text NOT NULL DEFAULT '';

CREATE TABLE agent_event (
  conversation_id uuid NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
  event_seq       bigint NOT NULL CHECK (event_seq > 0),
  run_id          uuid REFERENCES agent_run(id) ON DELETE SET NULL,
  type            text NOT NULL CHECK (type IN (
    'run.started','run.stage','run.ended','message.delta','message.snapshot','message.saved',
    'tool.started','tool.ended','input.created','input.updated','input.consumed',
    'question.created','question.resolved','plan.updated','goal.updated','action.updated',
    'artifact.created','context.updated','conversation.updated')),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  PRIMARY KEY (conversation_id, event_seq),
  CHECK ((type = 'message.delta') = (expires_at IS NOT NULL))
);
CREATE INDEX agent_event_run ON agent_event (run_id, event_seq) WHERE run_id IS NOT NULL;
CREATE INDEX agent_event_delta_expiry ON agent_event (expires_at, conversation_id, event_seq)
  WHERE type = 'message.delta';

-- 事件水位从空游标开始。保留旧未读状态，不把历史消息伪造成message.saved。
UPDATE agent_conversation c
SET force_unread = c.force_unread OR EXISTS (
      SELECT 1 FROM agent_message m
      WHERE m.conversation_id = c.id
        AND m.role IN ('assistant','action_result','system_note')
        AND m.seq > c.read_upto_message_seq),
    next_event_seq = 1,
    read_upto_event_seq = 1;
INSERT INTO agent_event (conversation_id, event_seq, type, payload)
SELECT id, 1, 'conversation.updated', '{"snapshot_baseline":true}'::jsonb
FROM agent_conversation;

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_event WHERE NOT (
       event_seq=1 AND type='conversation.updated' AND run_id IS NULL AND payload='{"snapshot_baseline":true}'::jsonb))
     OR EXISTS (SELECT 1 FROM agent_conversation WHERE read_upto_event_seq>1 OR event_retention_floor>0)
     OR EXISTS (SELECT 1 FROM agent_run WHERE protocol_version <> 1 OR request_id IS NOT NULL OR partial_output <> '' OR partial_message_key <> '')
     OR EXISTS (SELECT 1 FROM agent_message WHERE message_key <> '') THEN
    RAISE EXCEPTION '工作台运行或事件数据仍存在，拒绝回滚；请保留字段并前滚修复';
  END IF;
END;
$$;
-- +goose StatementEnd
DROP TABLE agent_event;
ALTER TABLE agent_message DROP COLUMN message_key;
DROP INDEX agent_run_request_idempotency;
ALTER TABLE agent_run DROP COLUMN protocol_version, DROP COLUMN partial_message_key,
  DROP COLUMN partial_output, DROP COLUMN partial_chunk_index, DROP COLUMN partial_updated_at,
  DROP COLUMN request_hash, DROP COLUMN request_id;
ALTER TABLE agent_conversation DROP COLUMN next_event_seq, DROP COLUMN read_upto_event_seq,
  DROP COLUMN event_retention_floor;
