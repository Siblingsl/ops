-- +goose Up
-- D-036: app_user + workspace_member + invites; model/settings per workspace

CREATE TABLE app_user (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username         text NOT NULL UNIQUE,
  password_hash    text NOT NULL,
  totp_secret_enc  bytea,
  failed_logins    int NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  last_login_at    timestamptz,
  last_login_ip    text,
  prev_login_at    timestamptz,
  prev_login_ip    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE workspace
  ADD COLUMN created_by_user_id uuid REFERENCES app_user(id);

CREATE TABLE workspace_member (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role          text NOT NULL DEFAULT 'editor' CHECK (role IN ('owner', 'editor')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);
CREATE INDEX workspace_member_user ON workspace_member(user_id);

INSERT INTO app_user (
  id, username, password_hash, totp_secret_enc, failed_logins, locked_until,
  last_login_at, last_login_ip, prev_login_at, prev_login_ip, created_at, updated_at
)
SELECT
  id, username, password_hash, totp_secret_enc, failed_logins, locked_until,
  last_login_at, last_login_ip, prev_login_at, prev_login_ip, created_at, updated_at
FROM member;

INSERT INTO workspace_member (workspace_id, user_id, role, status, created_at, updated_at)
SELECT
  workspace_id,
  id,
  CASE WHEN role IN ('owner', 'editor') THEN role ELSE 'owner' END,
  'active',
  created_at,
  updated_at
FROM member;

UPDATE workspace w
SET created_by_user_id = m.id
FROM member m
WHERE m.workspace_id = w.id;

ALTER TABLE session ADD COLUMN user_id uuid REFERENCES app_user(id) ON DELETE CASCADE;
ALTER TABLE session ADD COLUMN current_workspace_id uuid REFERENCES workspace(id);

UPDATE session s
SET user_id = s.member_id,
    current_workspace_id = m.workspace_id
FROM member m
WHERE m.id = s.member_id;

DELETE FROM session WHERE user_id IS NULL OR current_workspace_id IS NULL;

ALTER TABLE session ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE session ALTER COLUMN current_workspace_id SET NOT NULL;
ALTER TABLE session DROP COLUMN member_id;

CREATE TABLE workspace_invite (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  code                text NOT NULL UNIQUE,
  role                text NOT NULL DEFAULT 'editor' CHECK (role IN ('owner', 'editor')),
  max_uses            int NOT NULL DEFAULT 10 CHECK (max_uses >= 1),
  used_count          int NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  expires_at          timestamptz NOT NULL,
  created_by_user_id  uuid NOT NULL REFERENCES app_user(id),
  revoked_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_invite_ws ON workspace_invite(workspace_id);

ALTER TABLE model_provider ADD COLUMN workspace_id uuid REFERENCES workspace(id);
UPDATE model_provider
SET workspace_id = (SELECT id FROM workspace ORDER BY created_at LIMIT 1)
WHERE workspace_id IS NULL;
DELETE FROM model_route WHERE provider_id IN (SELECT id FROM model_provider WHERE workspace_id IS NULL);
DELETE FROM model_provider WHERE workspace_id IS NULL;
ALTER TABLE model_provider ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX model_provider_ws ON model_provider(workspace_id);

ALTER TABLE model_route ADD COLUMN workspace_id uuid REFERENCES workspace(id);
UPDATE model_route r
SET workspace_id = p.workspace_id
FROM model_provider p
WHERE p.id = r.provider_id;
DELETE FROM model_route WHERE workspace_id IS NULL;
ALTER TABLE model_route DROP CONSTRAINT model_route_pkey;
ALTER TABLE model_route ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE model_route ADD PRIMARY KEY (workspace_id, task_type);

ALTER TABLE app_setting ADD COLUMN workspace_id uuid REFERENCES workspace(id);
UPDATE app_setting
SET workspace_id = (SELECT id FROM workspace ORDER BY created_at LIMIT 1)
WHERE workspace_id IS NULL;
DELETE FROM app_setting WHERE workspace_id IS NULL;
ALTER TABLE app_setting DROP CONSTRAINT app_setting_pkey;
ALTER TABLE app_setting ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE app_setting ADD PRIMARY KEY (workspace_id, key);

DROP TABLE member;

-- +goose Down
CREATE TABLE member (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspace(id),
  username         text NOT NULL UNIQUE,
  password_hash    text NOT NULL,
  role             text NOT NULL DEFAULT 'owner',
  totp_secret_enc  bytea,
  failed_logins    int NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  last_login_at    timestamptz,
  last_login_ip    text,
  prev_login_at    timestamptz,
  prev_login_ip    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

INSERT INTO member (
  id, workspace_id, username, password_hash, role, totp_secret_enc, failed_logins, locked_until,
  last_login_at, last_login_ip, prev_login_at, prev_login_ip, created_at, updated_at
)
SELECT
  u.id,
  COALESCE(
    (SELECT wm.workspace_id FROM workspace_member wm WHERE wm.user_id = u.id AND wm.role = 'owner' ORDER BY wm.created_at LIMIT 1),
    (SELECT wm.workspace_id FROM workspace_member wm WHERE wm.user_id = u.id ORDER BY wm.created_at LIMIT 1)
  ),
  u.username, u.password_hash,
  COALESCE(
    (SELECT wm.role FROM workspace_member wm WHERE wm.user_id = u.id ORDER BY CASE wm.role WHEN 'owner' THEN 0 ELSE 1 END, wm.created_at LIMIT 1),
    'owner'
  ),
  u.totp_secret_enc, u.failed_logins, u.locked_until,
  u.last_login_at, u.last_login_ip, u.prev_login_at, u.prev_login_ip, u.created_at, u.updated_at
FROM app_user u
WHERE EXISTS (SELECT 1 FROM workspace_member wm WHERE wm.user_id = u.id);

ALTER TABLE session ADD COLUMN member_id uuid REFERENCES member(id) ON DELETE CASCADE;
UPDATE session SET member_id = user_id;
DELETE FROM session WHERE member_id IS NULL;
ALTER TABLE session ALTER COLUMN member_id SET NOT NULL;
ALTER TABLE session DROP COLUMN user_id;
ALTER TABLE session DROP COLUMN current_workspace_id;

DROP TABLE workspace_invite;
DROP TABLE workspace_member;

ALTER TABLE workspace DROP COLUMN created_by_user_id;

ALTER TABLE model_route DROP CONSTRAINT model_route_pkey;
ALTER TABLE model_route DROP COLUMN workspace_id;
ALTER TABLE model_route ADD PRIMARY KEY (task_type);

ALTER TABLE model_provider DROP COLUMN workspace_id;

ALTER TABLE app_setting DROP CONSTRAINT app_setting_pkey;
ALTER TABLE app_setting DROP COLUMN workspace_id;
ALTER TABLE app_setting ADD PRIMARY KEY (key);

DROP TABLE app_user;
