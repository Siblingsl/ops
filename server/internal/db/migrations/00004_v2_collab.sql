-- +goose Up
-- viewer 角色 + 邀请邮件投递记录（SMTP 配置存 app_setting）

ALTER TABLE workspace_member DROP CONSTRAINT IF EXISTS workspace_member_role_check;
ALTER TABLE workspace_member ADD CONSTRAINT workspace_member_role_check
  CHECK (role IN ('owner', 'editor', 'viewer'));

ALTER TABLE workspace_invite DROP CONSTRAINT IF EXISTS workspace_invite_role_check;
ALTER TABLE workspace_invite ADD CONSTRAINT workspace_invite_role_check
  CHECK (role IN ('owner', 'editor', 'viewer'));

CREATE TABLE IF NOT EXISTS workspace_invite_email (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_id    uuid NOT NULL REFERENCES workspace_invite(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  to_email     text NOT NULL,
  status       text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'dev_logged', 'failed')),
  error        text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspace_invite_email_invite ON workspace_invite_email(invite_id);

ALTER TABLE topic DROP CONSTRAINT IF EXISTS topic_source_check;
ALTER TABLE topic ADD CONSTRAINT topic_source_check
  CHECK (source IN ('manual', 'ai', 'review', 'hot'));

ALTER TABLE asset ADD COLUMN IF NOT EXISTS ai_generated boolean NOT NULL DEFAULT false;
ALTER TABLE comic_panel ADD COLUMN IF NOT EXISTS bubbles jsonb NOT NULL DEFAULT '[]';

-- +goose Down
ALTER TABLE comic_panel DROP COLUMN IF EXISTS bubbles;
ALTER TABLE asset DROP COLUMN IF EXISTS ai_generated;
ALTER TABLE topic DROP CONSTRAINT IF EXISTS topic_source_check;
ALTER TABLE topic ADD CONSTRAINT topic_source_check
  CHECK (source IN ('manual', 'ai', 'review'));
DROP TABLE IF EXISTS workspace_invite_email;
ALTER TABLE workspace_member DROP CONSTRAINT IF EXISTS workspace_member_role_check;
ALTER TABLE workspace_member ADD CONSTRAINT workspace_member_role_check
  CHECK (role IN ('owner', 'editor'));
ALTER TABLE workspace_invite DROP CONSTRAINT IF EXISTS workspace_invite_role_check;
ALTER TABLE workspace_invite ADD CONSTRAINT workspace_invite_role_check
  CHECK (role IN ('owner', 'editor'));
