-- +goose Up
-- D-044: system super admin, admin workspace override, global switches

ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS is_system_admin boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz;

ALTER TABLE session
  ADD COLUMN IF NOT EXISTS admin_override boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS system_setting (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT 'null'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO system_setting (key, value) VALUES
  ('registration_open', 'true'::jsonb),
  ('maintenance_mode', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Permanent super admin is username skyeder (ensured at process start, D-044).
-- Do not promote the first registered user.

-- +goose Down
UPDATE app_user SET is_system_admin = false;
ALTER TABLE app_user DROP COLUMN IF EXISTS disabled_at;
ALTER TABLE app_user DROP COLUMN IF EXISTS is_system_admin;
ALTER TABLE session DROP COLUMN IF EXISTS admin_override;
DROP TABLE IF EXISTS system_setting;
