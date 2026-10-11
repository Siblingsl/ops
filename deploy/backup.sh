#!/usr/bin/env bash
# 每日备份（DEV-U104，12 文档）：Postgres 逻辑备份 + 应用数据卷（assets 与本地文件）。
# 调度示例（宿主机 crontab）：
#   30 3 * * * /path/to/ops/deploy/backup.sh >> /var/log/ops-backup.log 2>&1
# 可用环境变量覆盖：ENV_FILE（默认 .env）、BACKUP_DIR（默认 /var/backups/ops）、KEEP_DAYS（默认 14）
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE="${ENV_FILE:-.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/ops}"
KEEP_DAYS="${KEEP_DAYS:-14}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "缺少 $ENV_FILE（复制 .env.example 并填写）" >&2
  exit 1
fi
mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"

docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U ops -d ops --no-owner | gzip > "$BACKUP_DIR/ops-db-$STAMP.sql.gz"

# 应用数据卷挂载在 /data（assets 与上传文件）；流式打包到宿主机
docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml exec -T app \
  tar -czf - -C / data > "$BACKUP_DIR/ops-assets-$STAMP.tar.gz"

# 清理过期备份
find "$BACKUP_DIR" -name 'ops-*.gz' -type f -mtime "+$KEEP_DAYS" -print -delete

echo "备份完成：$BACKUP_DIR/ops-db-$STAMP.sql.gz + ops-assets-$STAMP.tar.gz"
ls -lh "$BACKUP_DIR" | tail -4
