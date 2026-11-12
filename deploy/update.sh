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

COMPOSE_FILES=(-f docker-compose.prod.yml)
# 若已配置 Cloudflare Tunnel，更新时一并拉起 cloudflared，避免只更新 app 后漏掉隧道
if [[ -f docker-compose.tunnel.yml ]] && grep -qE '^CLOUDFLARE_TUNNEL_TOKEN=.+' .env; then
  COMPOSE_FILES+=(-f docker-compose.tunnel.yml)
  echo "检测到 CLOUDFLARE_TUNNEL_TOKEN，将同时确保 ops-cloudflared 运行。"
fi

# 小内存机器上，并行跑着的 app/parser + docker go build 容易把编译拖进交换区直至 SSH 超时。
# 先停业务容器腾出内存；构建失败时再尽力用旧镜像拉回服务。
#
# 关键：构建阶段被 SSH 超时杀掉时，脚本不会走到下面的 if 分支，容器会一直停着，
# nginx 对上游持续 502（2026-11-10 DEV-AI27 A30b 片 2 就是这样把线上打挂的）。
# 因此用 EXIT trap 兜底：只要没标记成功，任何退出路径都尝试用现有镜像拉起容器。
DEPLOY_DONE=0
restore_on_exit() {
  local code=$?
  if [[ "$DEPLOY_DONE" == "1" ]]; then
    return
  fi
  echo "更新未完成（exit=$code）；用现有镜像恢复 app/parser，避免上游持续 502…" >&2
  docker compose "${COMPOSE_FILES[@]}" --env-file .env up -d --no-build --remove-orphans || true
}
trap restore_on_exit EXIT
trap 'exit 129' HUP
trap 'exit 143' TERM

echo "构建前停止 app/parser，降低 go build 内存压力…"
docker compose "${COMPOSE_FILES[@]}" --env-file .env stop app parser_a parser_b || true
# 上次 SSH 超时可能留下仍在跑的 build 容器 / go 进程
docker ps -aq --filter status=running | while read -r cid; do
  image="$(docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null || true)"
  case "$image" in
    golang:*|*golang*bookworm*)
      echo "终止遗留构建容器 $cid ($image)"
      docker kill "$cid" >/dev/null 2>&1 || true
      ;;
  esac
done
pkill -f 'go build -trimpath' >/dev/null 2>&1 || true

if ! docker compose "${COMPOSE_FILES[@]}" --env-file .env up -d --build --remove-orphans; then
  echo "构建或启动失败；尝试用现有镜像恢复 app/parser…" >&2
  docker compose "${COMPOSE_FILES[@]}" --env-file .env up -d --no-build --remove-orphans || true
  exit 1
fi
DEPLOY_DONE=1
docker compose "${COMPOSE_FILES[@]}" --env-file .env ps
echo "更新完成。健康检查：curl -fsS https://ops-api.88813888.xyz/healthz"
