#!/usr/bin/env bash
# 服务器上一键更新：拉代码 → 构建 → 滚动启动
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f deploy/.env ]]; then
  echo "缺少 deploy/.env，先复制 deploy/.env.example 并填写密钥" >&2
  exit 1
fi

git fetch origin
git reset --hard origin/main

cd deploy
# 更新前先备份（DEV-U104/105）：备份失败即中止更新
if ! ENV_FILE=.env ./backup.sh; then
  echo "更新前备份失败，已中止更新。" >&2
  exit 1
fi
docker compose -f docker-compose.prod.yml up -d --build --remove-orphans
docker compose -f docker-compose.prod.yml ps
echo "更新完成。健康检查：curl -fsS https://ops.88813888.xyz/healthz"
