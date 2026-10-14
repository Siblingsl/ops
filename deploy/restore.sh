#!/usr/bin/env bash
# Restore the newest database/assets backup into an isolated Compose project.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/ops}"
if [[ "$BACKUP_DIR" != /* ]]; then
  BACKUP_DIR="$SCRIPT_DIR/$BACKUP_DIR"
fi

if [[ ! -d "$BACKUP_DIR" ]]; then
  echo "备份目录不存在：$BACKUP_DIR" >&2
  exit 1
fi

latest_db="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'ops-db-*.sql.gz' -printf '%f\n' | LC_ALL=C sort | tail -n 1)"
if [[ -z "$latest_db" ]]; then
  echo "没有找到数据库备份：$BACKUP_DIR/ops-db-*.sql.gz" >&2
  exit 1
fi

stamp="${latest_db#ops-db-}"
stamp="${stamp%.sql.gz}"
if [[ ! "$stamp" =~ ^[0-9]{8}-[0-9]{6}$ ]]; then
  echo "数据库备份文件名时间戳无效：$latest_db" >&2
  exit 1
fi

db_backup="$BACKUP_DIR/$latest_db"
assets_backup="$BACKUP_DIR/ops-assets-$stamp.tar.gz"
if [[ ! -f "$assets_backup" ]]; then
  echo "缺少与数据库备份配对的应用数据：$assets_backup" >&2
  exit 1
fi
gzip -t "$db_backup" "$assets_backup"

project="ops-restore-$stamp-$$"
if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" || \
      -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" || \
      -n "$(docker network ls -q --filter "label=com.docker.compose.project=$project")" ]]; then
  echo "临时 Compose 项目已存在，拒绝覆盖：$project" >&2
  exit 1
fi

compose() {
  docker compose --project-name "$project" --env-file /dev/null --project-directory "$SCRIPT_DIR" -f "$runtime_compose" "$@"
}

app_run_id=""
runtime_compose=""
compose_ready=0
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if ((compose_ready == 1)); then
    containers="$(docker ps -aq --filter "label=com.docker.compose.project=$project")"
    while IFS= read -r container_id; do
      [[ -z "$container_id" ]] || docker rm -f "$container_id" >/dev/null || status=1
    done <<< "$containers"
    if ! compose down --volumes --remove-orphans >/dev/null; then
      echo "清理临时 Compose 项目失败：$project" >&2
      status=1
    fi
  fi
  [[ -z "$runtime_compose" ]] || rm -f -- "$runtime_compose"
  unset OPS_MASTER_KEY POSTGRES_PASSWORD OPS_PUBLIC_IP OPS_COOKIE_SECURE
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

umask 077
runtime_compose="$(mktemp --suffix=.yml "${TMPDIR:-/tmp}/ops-restore-compose.XXXXXX")"
export OPS_PUBLIC_IP=127.0.0.1
export OPS_MASTER_KEY="$(openssl rand -base64 32 | tr -d '\n')"
export POSTGRES_PASSWORD="$(openssl rand -hex 32)"
export OPS_COOKIE_SECURE=0

awk '
  { sub(/\r$/, "") }
  /^    env_file:$/ { skipping=1; removed++; next }
  skipping && /^    environment:$/ { skipping=0 }
  skipping { next }
  { print }
  END { if (removed != 1) exit 1 }
' docker-compose.prod.yml > "$runtime_compose"
if grep -q '^    env_file:' "$runtime_compose"; then
  echo "无法从临时配置中移除生产 env_file，拒绝继续" >&2
  exit 1
fi
compose_ready=1

started_at=$SECONDS
compose up -d postgres

ready=0
for ((i = 0; i < 60; i++)); do
  if compose exec -T postgres pg_isready -U ops -d postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
if ((ready == 0)); then
  echo "临时数据库在 120 秒内未就绪" >&2
  exit 1
fi

compose exec -T postgres dropdb -U ops --maintenance-db=postgres --if-exists ops
compose exec -T postgres createdb -U ops --maintenance-db=postgres -O ops ops
gzip -dc "$db_backup" | compose exec -T postgres psql -U ops -d ops -v ON_ERROR_STOP=1

# The new project has an empty app_data volume; extract only into its /data volume.
compose run --rm --no-deps -T --entrypoint sh app -ec 'tar -xzf - -C /' < "$assets_backup"

image_record="$(compose exec -T postgres psql -X -q -A -t -F $'\t' -U ops -d ops -v ON_ERROR_STOP=1 \
  -c "SELECT storage_path, bytes, sha256 FROM asset WHERE mime LIKE 'image/%' ORDER BY created_at DESC LIMIT 1")"
if [[ -z "$image_record" ]]; then
  echo "恢复后的数据库没有图片记录，无法完成图片校验" >&2
  exit 1
fi
IFS=$'\t' read -r image_path image_bytes image_sha256 <<< "$image_record"
if [[ "$image_path" != assets/* || "$image_path" == *'..'* || ! "$image_bytes" =~ ^[0-9]+$ || ! "$image_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "恢复后的图片记录无效，拒绝访问数据目录之外的路径" >&2
  exit 1
fi
compose run --rm --no-deps -T --entrypoint sh app -ec \
  'path="/data/$1"; test -s "$path"; actual="$(wc -c < "$path")"; hash="$(sha256sum "$path" | cut -d" " -f1)"; test "$actual" -eq "$2"; test "$hash" = "$3"' \
  _ "$image_path" "$image_bytes" "$image_sha256"

# Compose run does not publish service ports unless requested. Bind an ephemeral port to loopback only.
app_run_id="$(compose run -d --no-deps --publish '127.0.0.1::8080' app)"
published="$(docker port "$app_run_id" 8080/tcp | head -n 1)"
port="${published##*:}"
if [[ ! "$port" =~ ^[0-9]+$ ]]; then
  echo "无法读取临时应用的本地健康检查端口" >&2
  exit 1
fi

health_ok=0
for ((i = 0; i < 60; i++)); do
  if [[ "$(curl -fsS --max-time 3 "http://127.0.0.1:$port/healthz" 2>/dev/null || true)" == "ok" ]]; then
    health_ok=1
    break
  fi
  sleep 2
done
if ((health_ok == 0)); then
  echo "恢复后的应用未能在 120 秒内通过 /healthz" >&2
  exit 1
fi

elapsed=$((SECONDS - started_at))
if ((elapsed >= 600)); then
  echo "恢复演练超过 10 分钟目标：${elapsed} 秒" >&2
  exit 1
fi
echo "恢复演练通过：$(basename "$db_backup")、$(basename "$assets_backup")；/healthz 与图片字节数/SHA-256 校验通过；耗时 ${elapsed} 秒。"
