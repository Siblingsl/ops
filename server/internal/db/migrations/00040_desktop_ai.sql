-- +goose Up
-- D-119：桌面模型执行位置、本人设备与每设备路由映射。旧供应商/路由默认保持 server。
CREATE TABLE desktop_device (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  public_key   bytea NOT NULL CHECK (octet_length(public_key) = 32),
  name         text NOT NULL DEFAULT '',
  platform     text NOT NULL CHECK (platform IN ('windows-x64')),
  version      text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  UNIQUE (user_id, id),
  UNIQUE (user_id, public_key)
);

CREATE TABLE desktop_ai_policy (
  workspace_id             uuid PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  enabled                   boolean NOT NULL DEFAULT false,
  allow_member_endpoints    boolean NOT NULL DEFAULT false,
  authorization_revision   bigint NOT NULL DEFAULT 1 CHECK (authorization_revision > 0),
  updated_by_user_id        uuid REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE desktop_route_state (
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  device_id    uuid NOT NULL,
  revision     bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, device_id),
  FOREIGN KEY (user_id, device_id) REFERENCES desktop_device(user_id, id) ON DELETE CASCADE
);

ALTER TABLE model_capability
  ADD COLUMN config_revision bigint NOT NULL DEFAULT 1 CHECK (config_revision > 0);

ALTER TABLE model_provider
  ADD COLUMN execution_location text NOT NULL DEFAULT 'server'
    CHECK (execution_location IN ('server', 'desktop')),
  ADD COLUMN desktop_user_id uuid,
  ADD COLUMN desktop_device_id uuid,
  ADD COLUMN desktop_endpoint_kind text,
  ADD COLUMN desktop_config_revision bigint NOT NULL DEFAULT 1
    CHECK (desktop_config_revision > 0);

ALTER TABLE model_provider
  ALTER COLUMN base_url DROP NOT NULL,
  ALTER COLUMN api_key_enc DROP NOT NULL;

ALTER TABLE model_provider
  ADD CONSTRAINT model_provider_desktop_scope_fk
    FOREIGN KEY (desktop_user_id, desktop_device_id)
    REFERENCES desktop_device(user_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT model_provider_execution_scope_check CHECK (
    (execution_location = 'server' AND desktop_user_id IS NULL AND desktop_device_id IS NULL
      AND base_url IS NOT NULL AND api_key_enc IS NOT NULL)
    OR
    (execution_location = 'desktop' AND desktop_user_id IS NOT NULL AND desktop_device_id IS NOT NULL
      AND desktop_endpoint_kind IS NOT NULL AND desktop_endpoint_kind IN ('loopback', 'public')
      AND base_url IS NULL AND api_key_enc IS NULL)
  ),
  ADD CONSTRAINT model_provider_location_ref UNIQUE (id, workspace_id, execution_location);

-- A legacy model_route may only reference server providers, even if an application
-- query accidentally omits an execution_location filter.
ALTER TABLE model_route
  ADD COLUMN execution_location text NOT NULL DEFAULT 'server'
    CHECK (execution_location = 'server'),
  ADD CONSTRAINT model_route_server_provider_fk
    FOREIGN KEY (provider_id, workspace_id, execution_location)
    REFERENCES model_provider(id, workspace_id, execution_location) ON DELETE CASCADE;

CREATE TABLE desktop_route (
  workspace_id         uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  device_id            uuid NOT NULL,
  task_type            text NOT NULL,
  execution_location   text NOT NULL CHECK (execution_location IN ('server', 'desktop', 'disabled')),
  provider_id          uuid,
  model                text NOT NULL,
  fallback_provider_id uuid,
  fallback_model       text NOT NULL DEFAULT '',
  PRIMARY KEY (workspace_id, user_id, device_id, task_type),
  FOREIGN KEY (user_id, device_id) REFERENCES desktop_device(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id, workspace_id, execution_location)
    REFERENCES model_provider(id, workspace_id, execution_location),
  FOREIGN KEY (fallback_provider_id, workspace_id, execution_location)
    REFERENCES model_provider(id, workspace_id, execution_location),
  CHECK (
    (execution_location = 'disabled' AND provider_id IS NULL AND model = ''
      AND fallback_provider_id IS NULL AND fallback_model = '')
    OR
    (execution_location IN ('server', 'desktop') AND provider_id IS NOT NULL AND model <> ''
      AND ((fallback_provider_id IS NULL AND fallback_model = '')
        OR (fallback_provider_id IS NOT NULL AND fallback_model <> '')))
  )
);

-- +goose StatementBegin
CREATE FUNCTION desktop_route_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_location = 'desktop' AND NOT EXISTS (
    SELECT 1 FROM model_provider p
    WHERE p.id = NEW.provider_id AND p.workspace_id = NEW.workspace_id
      AND p.execution_location = 'desktop' AND p.desktop_user_id = NEW.user_id
      AND p.desktop_device_id = NEW.device_id AND p.status = 'active'
      AND NEW.model = ANY(p.models)
  ) THEN
    RAISE EXCEPTION 'desktop route provider is outside the user/device scope';
  END IF;
  IF NEW.fallback_provider_id IS NOT NULL AND NEW.execution_location = 'desktop' AND NOT EXISTS (
    SELECT 1 FROM model_provider p
    WHERE p.id = NEW.fallback_provider_id AND p.workspace_id = NEW.workspace_id
      AND p.execution_location = 'desktop' AND p.desktop_user_id = NEW.user_id
      AND p.desktop_device_id = NEW.device_id AND p.status = 'active'
      AND NEW.fallback_model = ANY(p.models)
  ) THEN
    RAISE EXCEPTION 'desktop fallback provider is outside the user/device scope';
  END IF;
  RETURN NEW;
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER desktop_route_scope_guard
  BEFORE INSERT OR UPDATE ON desktop_route
  FOR EACH ROW EXECUTE FUNCTION desktop_route_scope_guard();

CREATE INDEX desktop_device_user_active ON desktop_device(user_id, created_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX model_provider_desktop_scope ON model_provider(workspace_id, desktop_user_id, desktop_device_id)
  WHERE execution_location = 'desktop';

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM model_provider WHERE execution_location = 'desktop') THEN
    RAISE EXCEPTION 'desktop model providers exist; export/deactivate desktop routes before rolling back 00040';
  END IF;
END;
$$;
-- +goose StatementEnd

ALTER TABLE model_provider
  ALTER COLUMN base_url SET NOT NULL,
  ALTER COLUMN api_key_enc SET NOT NULL;

DROP INDEX model_provider_desktop_scope;
DROP INDEX desktop_device_user_active;
DROP TRIGGER desktop_route_scope_guard ON desktop_route;
DROP FUNCTION desktop_route_scope_guard();
DROP TABLE desktop_route;
DROP TABLE desktop_route_state;
DROP TABLE desktop_ai_policy;
ALTER TABLE model_capability DROP COLUMN config_revision;
ALTER TABLE model_route DROP CONSTRAINT model_route_server_provider_fk;
ALTER TABLE model_route DROP COLUMN execution_location;
ALTER TABLE model_provider DROP CONSTRAINT model_provider_location_ref;
ALTER TABLE model_provider DROP CONSTRAINT model_provider_execution_scope_check;
ALTER TABLE model_provider DROP CONSTRAINT model_provider_desktop_scope_fk;
ALTER TABLE model_provider DROP COLUMN desktop_config_revision;
ALTER TABLE model_provider DROP COLUMN desktop_endpoint_kind;
ALTER TABLE model_provider DROP COLUMN desktop_device_id;
ALTER TABLE model_provider DROP COLUMN desktop_user_id;
ALTER TABLE model_provider DROP COLUMN execution_location;
DROP TABLE desktop_device;
