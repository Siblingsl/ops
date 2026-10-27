-- DEV-AW08 / D-152：持久输入、分支来源和可共享附件引用。
-- +goose Up
ALTER TABLE agent_conversation
  ADD COLUMN parent_id uuid REFERENCES agent_conversation(id) ON DELETE SET NULL,
  ADD COLUMN fork_upto_seq integer CHECK (fork_upto_seq IS NULL OR fork_upto_seq >= 0),
  ADD COLUMN input_queue_paused boolean NOT NULL DEFAULT false;
CREATE INDEX agent_conversation_parent ON agent_conversation(parent_id) WHERE parent_id IS NOT NULL;

ALTER TABLE agent_run ADD COLUMN parent_run_id uuid REFERENCES agent_run(id) ON DELETE SET NULL;
ALTER TABLE agent_run DROP CONSTRAINT agent_run_trigger_check;
ALTER TABLE agent_run ADD CONSTRAINT agent_run_trigger_check
  CHECK (trigger IN ('message','continue','regenerate','edit','plan_accept','answer','queue'));

CREATE TABLE agent_input (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     uuid NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL,
  user_id             uuid NOT NULL,
  run_id              uuid REFERENCES agent_run(id) ON DELETE SET NULL,
  kind                text NOT NULL CHECK (kind IN ('steer','queue')),
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','consumed','cancelled','needs_review','expired')),
  error_code          text NOT NULL DEFAULT '',
  request_id          uuid NOT NULL,
  revision            bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  payload_hash        char(64) NOT NULL,
  text                text NOT NULL DEFAULT '' CHECK (char_length(text) <= 8000),
  attachment_ids      uuid[] NOT NULL DEFAULT '{}',
  context_refs        jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(context_refs)='array'),
  skill_requests      jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(skill_requests)='array'),
  consumed_message_id uuid REFERENCES agent_message(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id,request_id),
  FOREIGN KEY (conversation_id,workspace_id,user_id)
    REFERENCES agent_conversation(id,workspace_id,user_id) ON DELETE CASCADE
);
CREATE INDEX agent_input_pending_fifo ON agent_input(conversation_id,created_at,id)
  WHERE kind='queue' AND status='pending';
CREATE INDEX agent_input_pending_steer ON agent_input(conversation_id,run_id,created_at,id)
  WHERE kind='steer' AND status='pending';

ALTER TABLE agent_attachment DROP CONSTRAINT agent_attachment_conversation_id_fkey;
ALTER TABLE agent_attachment
  ADD CONSTRAINT agent_attachment_identity_unique UNIQUE(id,workspace_id,user_id),
  ADD CONSTRAINT agent_attachment_conversation_id_fkey
    FOREIGN KEY (conversation_id) REFERENCES agent_conversation(id) ON DELETE SET NULL;
CREATE TABLE agent_attachment_ref (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  message_id uuid REFERENCES agent_message(id) ON DELETE CASCADE,
  artifact_version_id uuid REFERENCES agent_artifact_version(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((message_id IS NOT NULL) <> (artifact_version_id IS NOT NULL)),
  FOREIGN KEY (attachment_id,workspace_id,user_id)
    REFERENCES agent_attachment(id,workspace_id,user_id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id,workspace_id,user_id)
    REFERENCES agent_conversation(id,workspace_id,user_id) ON DELETE CASCADE
);
CREATE INDEX agent_attachment_ref_conversation ON agent_attachment_ref(conversation_id,attachment_id);
CREATE UNIQUE INDEX agent_attachment_ref_message ON agent_attachment_ref(attachment_id,message_id)
  WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX agent_attachment_ref_artifact ON agent_attachment_ref(attachment_id,artifact_version_id)
  WHERE artifact_version_id IS NOT NULL;
-- +goose StatementBegin
CREATE FUNCTION agent_attachment_ref_target_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_message m WHERE m.id=NEW.message_id AND m.conversation_id=NEW.conversation_id
  ) THEN
    RAISE EXCEPTION 'attachment message reference must belong to the same conversation';
  END IF;
  IF NEW.artifact_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_artifact_version v JOIN agent_artifact a ON a.id=v.artifact_id
    WHERE v.id=NEW.artifact_version_id AND a.conversation_id=NEW.conversation_id
  ) THEN
    RAISE EXCEPTION 'attachment artifact reference must belong to the same conversation';
  END IF;
  RETURN NEW;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER agent_attachment_ref_target_guard
  BEFORE INSERT OR UPDATE ON agent_attachment_ref
  FOR EACH ROW EXECUTE FUNCTION agent_attachment_ref_target_guard();
INSERT INTO agent_attachment_ref(attachment_id,conversation_id,workspace_id,user_id,message_id)
SELECT DISTINCT a.id,c.id,c.workspace_id,c.user_id,m.id
FROM agent_attachment a
JOIN agent_message m ON a.id=ANY(m.attachment_ids)
JOIN agent_conversation c ON c.id=m.conversation_id
WHERE a.referenced=true
ON CONFLICT DO NOTHING;
INSERT INTO agent_attachment_ref(attachment_id,conversation_id,workspace_id,user_id,artifact_version_id)
SELECT DISTINCT a.id,c.id,c.workspace_id,c.user_id,v.id
FROM agent_artifact_version v
JOIN agent_artifact ar ON ar.id=v.artifact_id
JOIN agent_conversation c ON c.id=ar.conversation_id
JOIN agent_attachment a ON a.id=(v.content_ref->>'attachment_id')::uuid
WHERE v.source_kind='attachment'
ON CONFLICT DO NOTHING;

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_input)
     OR EXISTS (SELECT 1 FROM agent_conversation WHERE parent_id IS NOT NULL OR fork_upto_seq IS NOT NULL OR input_queue_paused)
     OR EXISTS (SELECT 1 FROM agent_run WHERE trigger='queue' OR parent_run_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM agent_attachment_ref r
       JOIN agent_attachment a ON a.id=r.attachment_id
       WHERE a.conversation_id IS DISTINCT FROM r.conversation_id) THEN
    RAISE EXCEPTION '输入、分支或共享附件仍有数据，拒绝回滚；请保留字段并前滚修复';
  END IF;
END;
$$;
-- +goose StatementEnd
DROP TRIGGER agent_attachment_ref_target_guard ON agent_attachment_ref;
DROP FUNCTION agent_attachment_ref_target_guard();
DROP TABLE agent_attachment_ref;
ALTER TABLE agent_attachment
  DROP CONSTRAINT agent_attachment_conversation_id_fkey,
  DROP CONSTRAINT agent_attachment_identity_unique,
  ADD CONSTRAINT agent_attachment_conversation_id_fkey
    FOREIGN KEY (conversation_id) REFERENCES agent_conversation(id) ON DELETE CASCADE;
DROP TABLE agent_input;
ALTER TABLE agent_run DROP CONSTRAINT agent_run_trigger_check;
ALTER TABLE agent_run ADD CONSTRAINT agent_run_trigger_check
  CHECK (trigger IN ('message','continue','regenerate','edit','plan_accept','answer'));
ALTER TABLE agent_run DROP COLUMN parent_run_id;
DROP INDEX agent_conversation_parent;
ALTER TABLE agent_conversation DROP COLUMN parent_id,DROP COLUMN fork_upto_seq,DROP COLUMN input_queue_paused;
