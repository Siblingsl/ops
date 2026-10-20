-- +goose Up
-- D-129 / 20 文档 §8.2：平台采集（网页后台读取）的工作区策略，与 desktop_ai_policy 分开，默认关闭。
-- 本表只承载增量授权；全局关闭开关在进程配置 OPS_DESKTOP_PLATFORM_ENABLED，不被本表覆盖。
CREATE TABLE platform_collection_policy (
  workspace_id              uuid PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  enabled                   boolean NOT NULL DEFAULT false,
  allow_member_connections  boolean NOT NULL DEFAULT false,
  authorization_revision    bigint NOT NULL DEFAULT 1 CHECK (authorization_revision > 0),
  daily_run_limit           int NOT NULL DEFAULT 3 CHECK (daily_run_limit BETWEEN 1 AND 3),
  daily_work_limit          int NOT NULL DEFAULT 60 CHECK (daily_work_limit BETWEEN 1 AND 60),
  updated_by_user_id        uuid REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  -- 关闭自动采集时不能保留“允许成员连接”这种增权状态。
  CHECK (NOT allow_member_connections OR enabled)
);

-- +goose Down
-- 已配置的平台采集策略是用户授权数据。只要还有工作区配置过（哪怕已关闭），回退都必须停下，
-- 不能静默丢失“谁开过自动采集”的痕迹；确认无人使用后再回退。
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_collection_policy) THEN
    RAISE EXCEPTION 'cannot roll back platform collection policy while any workspace has a policy row';
  END IF;
END
$$;
-- +goose StatementEnd

DROP TABLE platform_collection_policy;
