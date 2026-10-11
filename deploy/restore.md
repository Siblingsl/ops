# 备份与恢复（DEV-U104，12 文档）

备份由 `deploy/backup.sh` 产生，包含两部分：

- `ops-db-<时间戳>.sql.gz` — Postgres 逻辑备份（`pg_dump --no-owner`）
- `ops-assets-<时间戳>.tar.gz` — 应用数据卷 `/data`（assets 图片与本地文件）

## 1. 每日调度（宿主机 crontab）

```cron
30 3 * * * /opt/ops/deploy/backup.sh >> /var/log/ops-backup.log 2>&1
```

可用环境变量覆盖：`ENV_FILE`（默认 `deploy/.env`）、`BACKUP_DIR`（默认 `/var/backups/ops`）、`KEEP_DAYS`（默认 14）。备份只落在服务器本地磁盘；如需异地容灾，请在 crontab 中追加 rclone/scp 步骤（本系统不内置）。

## 2. 恢复步骤

> 以下命令在服务器上、`deploy/` 目录内执行。恢复会**覆盖**当前数据，请先确认。

```bash
# 1) 停应用（数据库保留）
docker compose --env-file .env -f docker-compose.prod.yml stop app

# 2) 恢复数据库
docker compose --env-file .env -f docker-compose.prod.yml exec -T postgres \
  psql -U ops -d postgres -c 'DROP DATABASE IF EXISTS ops;'
docker compose --env-file .env -f docker-compose.prod.yml exec -T postgres \
  psql -U ops -d postgres -c 'CREATE DATABASE ops;'
gunzip -c /var/backups/ops/ops-db-<时间戳>.sql.gz | \
  docker compose --env-file .env -f docker-compose.prod.yml exec -T postgres \
  psql -U ops -d ops -v ON_ERROR_STOP=1

# 3) 恢复应用数据卷（app 已停止，用临时容器解包；清空后恢复）
MSYS_NO_PATHCONV=1 docker compose --env-file .env -f docker-compose.prod.yml run --rm app \
  sh -c 'rm -rf /data/* && tar -xzf - -C /' < /var/backups/ops/ops-assets-<时间戳>.tar.gz

# 4) 启动并验证
docker compose --env-file .env -f docker-compose.prod.yml up -d
curl -fsS http://127.0.0.1:44537/healthz   # 宿主机端口按 compose 实际映射
```

## 3. 验证要点

- `/healthz` 返回 `ok`（健康检查包含数据库连通，DEV-U105）。
- 登录一个账号查看作品列表与图片能否打开（assets 与数据库一致）。
- 恢复演练建议每季度做一次，并记录耗时。
