-- DEV-SK1 / D-151：技能系统（docs/23 第 5 节数据模型）。
-- skill 四层归属（恰一非空）、skill_binding 公共 / 本人分区、audit_log 私有可见性、
-- ai_call 私有上下文引用；内置技能不入库（Go 静态注册表 + 确定性 UUID）。

-- +goose Up
CREATE TABLE skill (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid REFERENCES workspace(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES app_user(id) ON DELETE CASCADE,
  account_id      uuid REFERENCES platform_account(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 30),
  summary         text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 60),
  triggers        text NOT NULL CHECK (char_length(triggers) BETWEEN 1 AND 120),
  instructions    text NOT NULL CHECK (
                    char_length(instructions) BETWEEN 1 AND 1200
                    AND btrim(instructions) <> ''),
  platforms       text[] NOT NULL DEFAULT '{}',
  content_formats text[] NOT NULL DEFAULT '{}',
  task_types      text[] NOT NULL DEFAULT '{}',
  task_enabled    boolean NOT NULL DEFAULT true,
  agent_enabled   boolean NOT NULL DEFAULT true,
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','disabled')),
  revision        bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  origin          text NOT NULL DEFAULT 'manual'
                    CHECK (origin IN ('manual','imported','copied')),
  source_key      text NOT NULL DEFAULT '',
  created_by      uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(workspace_id, user_id, account_id) = 1),
  CHECK (task_enabled OR agent_enabled)
);
CREATE UNIQUE INDEX skill_name_ws
  ON skill (workspace_id, lower(name)) WHERE workspace_id IS NOT NULL;
CREATE UNIQUE INDEX skill_name_user
  ON skill (user_id, lower(name)) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX skill_name_account
  ON skill (account_id, lower(name)) WHERE account_id IS NOT NULL;

CREATE TABLE skill_binding (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES platform_account(id) ON DELETE CASCADE,
  audience_user_id uuid REFERENCES app_user(id) ON DELETE CASCADE,
  skill_id         uuid REFERENCES skill(id) ON DELETE CASCADE,
  builtin_key      text NOT NULL DEFAULT '',
  priority         integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 999),
  created_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((skill_id IS NOT NULL AND builtin_key = '')
      OR (skill_id IS NULL AND builtin_key <> '')),
  CHECK (builtin_key = '' OR audience_user_id IS NULL)
);
CREATE UNIQUE INDEX skill_binding_skill_unique
  ON skill_binding (account_id, skill_id) WHERE skill_id IS NOT NULL;
CREATE UNIQUE INDEX skill_binding_builtin_unique
  ON skill_binding (account_id, builtin_key) WHERE builtin_key <> '';
CREATE INDEX skill_binding_partition
  ON skill_binding (account_id, audience_user_id);

ALTER TABLE audit_log ADD COLUMN visibility text NOT NULL DEFAULT 'workspace'
  CHECK (visibility IN ('workspace','personal'));
CREATE INDEX audit_log_personal_actor
  ON audit_log (actor_id, created_at DESC) WHERE visibility = 'personal';

ALTER TABLE ai_call
  ADD COLUMN context_owner_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  ADD COLUMN private_context_refs jsonb NOT NULL DEFAULT '{}';

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM skill)
     OR EXISTS (SELECT 1 FROM skill_binding)
     OR EXISTS (SELECT 1 FROM audit_log WHERE visibility = 'personal')
     OR EXISTS (SELECT 1 FROM ai_call WHERE private_context_refs <> '{}'::jsonb) THEN
    RAISE EXCEPTION '技能或私有记录仍存在，拒绝回滚；请保留字段并前滚修复';
  END IF;
END;
$$;
-- +goose StatementEnd
ALTER TABLE ai_call DROP COLUMN private_context_refs, DROP COLUMN context_owner_user_id;
DROP INDEX audit_log_personal_actor;
ALTER TABLE audit_log DROP COLUMN visibility;
DROP TABLE skill_binding, skill;
