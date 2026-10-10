-- +goose Up
-- D-044 修订：永久超管为固定账号 skyeder（由进程启动 EnsurePermanentAdmin 创建/对齐），不再把首个用户升为超管。

-- Clear bootstrap from 00005 if that user is not skyeder; skyeder is enforced at runtime.
UPDATE app_user SET is_system_admin = false
WHERE is_system_admin = true
  AND lower(username) <> 'skyeder';

-- +goose Down
-- irreversible demotion; no-op
SELECT 1;
