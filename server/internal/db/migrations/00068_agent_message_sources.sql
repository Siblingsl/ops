-- DEV-AW08 / D-152：输入消费来源及分支消息来源定位。
-- +goose Up
ALTER TABLE agent_message
  ADD COLUMN source_input_id uuid REFERENCES agent_input(id) ON DELETE SET NULL,
  ADD COLUMN source_message_id uuid REFERENCES agent_message(id) ON DELETE SET NULL;

-- 只能将输入消费来源绑定到同一会话；历史输入删除时允许外键安全置空。
-- +goose StatementBegin
CREATE FUNCTION agent_message_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_input_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_input i WHERE i.id=NEW.source_input_id AND i.conversation_id=NEW.conversation_id
  ) THEN
    RAISE EXCEPTION 'message input source must belong to the same conversation';
  END IF;
  IF NEW.source_message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_message source
    JOIN agent_conversation child ON child.id=NEW.conversation_id
    WHERE source.id=NEW.source_message_id AND child.parent_id=source.conversation_id
      AND source.seq<=child.fork_upto_seq
  ) THEN
    RAISE EXCEPTION 'fork source message must belong to the parent conversation and fork boundary';
  END IF;
  RETURN NEW;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER agent_message_source_guard
  BEFORE INSERT OR UPDATE OF source_input_id,source_message_id,conversation_id ON agent_message
  FOR EACH ROW EXECUTE FUNCTION agent_message_source_guard();

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_message WHERE source_input_id IS NOT NULL OR source_message_id IS NOT NULL) THEN
    RAISE EXCEPTION '消息仍有输入或分支来源，拒绝回滚；请保留字段并前滚修复';
  END IF;
END;
$$;
-- +goose StatementEnd
DROP TRIGGER agent_message_source_guard ON agent_message;
DROP FUNCTION agent_message_source_guard();
ALTER TABLE agent_message DROP COLUMN source_input_id,DROP COLUMN source_message_id;
