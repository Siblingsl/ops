-- DEV-CX13-E / FR-CX-22：评论处理台账。
-- 无 author_raw：默认不持久化真实昵称，只存用户给的别名。
-- 删除清空正文与草稿并标记 deleted_at；读取一律排除已删除行。
-- +goose Up
CREATE TABLE comment_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  account_id uuid NOT NULL REFERENCES platform_account(id),
  work_id uuid REFERENCES work(id) ON DELETE SET NULL,
  author_alias text NOT NULL DEFAULT '',
  content text NOT NULL,
  captured_at timestamptz NOT NULL,
  category text CHECK (category IN ('question','objection','praise','negative','spam')),
  reply_draft text NOT NULL DEFAULT '',
  reply_status text NOT NULL DEFAULT 'none' CHECK (reply_status IN ('none','drafted','copied','sent_manual')),
  revision int NOT NULL DEFAULT 1 CHECK (revision>0),
  reply_revision int NOT NULL DEFAULT 0,
  ai_call_id uuid REFERENCES ai_call(id),
  copied_at timestamptz, sent_manual_at timestamptz,
  created_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX comment_inbox_list ON comment_inbox(account_id,captured_at DESC,id DESC) WHERE deleted_at IS NULL;

-- +goose Down
DROP TABLE comment_inbox;
