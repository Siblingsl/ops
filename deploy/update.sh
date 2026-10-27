#!/usr/bin/env bash
# 服务器上一键更新：拉代码 → 构建 → 滚动启动
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

EXPECTED_SHA="${1:-}"
if [[ $# -gt 1 ]]; then
  echo "用法：$0 [已通过 CI 的 40 位提交 SHA]" >&2
  exit 2
fi

if [[ ! -f deploy/.env ]]; then
  echo "缺少 deploy/.env，先复制 deploy/.env.example 并填写密钥" >&2
  exit 1
fi

git fetch origin
TARGET_REF=origin/main
if [[ -n "$EXPECTED_SHA" ]]; then
  if [[ ! "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]; then
    echo "提交 SHA 格式错误：需要 40 位小写十六进制 SHA。" >&2
    exit 2
  fi
  if ! git rev-parse --verify --quiet "${EXPECTED_SHA}^{commit}" >/dev/null; then
    echo "服务器仓库中找不到提交：$EXPECTED_SHA" >&2
    exit 1
  fi
  if ! git merge-base --is-ancestor "$EXPECTED_SHA" origin/main; then
    echo "提交 $EXPECTED_SHA 不是 origin/main 的祖先；拒绝部署。" >&2
    exit 1
  fi
  TARGET_REF="$EXPECTED_SHA"
fi
git reset --hard "$TARGET_REF"

cd deploy
# 更新前先备份（DEV-U104/105）：备份失败即中止更新
if ! ENV_FILE=.env ./backup.sh; then
  echo "更新前备份失败，已中止更新。" >&2
  exit 1
fi
docker compose -f docker-compose.prod.yml up -d --build --remove-orphans
docker compose -f docker-compose.prod.yml ps
echo "更新完成。健康检查：curl -fsS https://ops.88813888.xyz/healthz"
