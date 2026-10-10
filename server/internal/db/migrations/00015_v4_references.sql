-- +goose Up
CREATE TABLE reference_item (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspace(id),account_id uuid NOT NULL REFERENCES platform_account(id),
 platform text NOT NULL CHECK(platform IN ('xhs','wechat_mp')),url text NOT NULL,status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','done','failed','blocked')),
 title text NOT NULL DEFAULT '',author text NOT NULL DEFAULT '',published_at text NOT NULL DEFAULT '',metrics jsonb NOT NULL DEFAULT '{}',body_text text NOT NULL DEFAULT '',analysis jsonb,
 error text NOT NULL DEFAULT '',queued_at timestamptz NOT NULL DEFAULT now(),fetched_at timestamptz,ai_call_id uuid REFERENCES ai_call(id) ON DELETE SET NULL,deleted_at timestamptz,
 UNIQUE(workspace_id,url)
);
CREATE INDEX reference_queue ON reference_item(queued_at) WHERE status='queued' AND deleted_at IS NULL;
-- +goose Down
DROP TABLE reference_item;
