# 升级与回滚（DEV-U105，12 文档）

## 升级

`deploy/update.sh` 一键完成：**更新前自动备份 → 拉代码 → 构建镜像 → 滚动启动**。
备份落在 `BACKUP_DIR`（默认 `/var/backups/ops`），失败即中止更新。

```bash
cd /opt/ops/deploy
./update.sh
curl -fsS http://127.0.0.1:44537/healthz   # 返回 ok 再放流量
# 若已配置隧道，update.sh 会自动带上 docker-compose.tunnel.yml（见 cloudflare-tunnel.md）
```

手动流程（等价步骤）：

1. `./backup.sh` — 备份数据库与数据卷
2. `git fetch origin && git reset --hard origin/main`
3. `docker compose --env-file .env -f docker-compose.prod.yml up -d --build`  
   （有隧道时再加 `-f docker-compose.tunnel.yml`）
4. `curl -fsS http://127.0.0.1:44537/healthz`

## 回滚

回滚 = **回到旧代码版本 + 恢复最近一次备份**。数据库迁移只向前（goose），旧镜像运行新表结构的字段会被忽略，不会损坏；但如果新版本迁移**删除或改写**了旧版本仍需要的列，必须先恢复备份再回滚代码。

```bash
# 1) 停应用
docker compose --env-file .env -f docker-compose.prod.yml stop app

# 2) 恢复最近一次备份（步骤见 restore.md）
gunzip -c /var/backups/ops/ops-db-<最近>.sql.gz | \
  docker compose --env-file .env -f docker-compose.prod.yml exec -T postgres \
  psql -U ops -d ops -v ON_ERROR_STOP=1

# 3) 回到上一个已知可用版本并启动
git log --oneline -5                # 找到上一个可用提交
git checkout <上一个可用提交>
docker compose --env-file .env -f docker-compose.prod.yml up -d --build
curl -fsS http://127.0.0.1:44537/healthz
```

## 注意事项

- `update.sh` 使用 `git reset --hard origin/main`，部署目录不要有本地改动。
- 迁移在服务启动时自动执行（`serve`/`migrate` 均会跑 goose），无需手动迁移。
- 降级前先看 90 文档对应迁移的 Down 说明（如 00020 的 Down 要求没有新类型账号数据）。

## 3. 本地隔离验收记录（2026-10-11，DEV-U105）

使用 `docker-compose.prod.yml` + `docker-compose.e2e.yml`、项目名 `ops-prod-e2e` 与独立卷。旧镜像 `ops-app:local` 的数据库为迁移 20，先注册测试用户与账号、在 `/data` 写入验收标记，再保存 `pg_dump -Fc` 与数据卷归档。切换 `ops-app:prod-e2e` 后自动升级到迁移 23，原账号保持可读，healthz 200，六条生产模式浏览器冒烟通过。

回滚采用恢复到新实例的方式：在同一隔离 PostgreSQL 内新建 `ops_rollback_20261011`，通过 `pg_restore --no-owner --exit-on-error` 恢复升级前备份；将 assets 归档恢复到独立 `ops-prod-e2e_rollback_assets` 卷，用旧镜像启动回环端口 44539 的 `ops-prod-e2e-rollback`。确认迁移仍为 20、原用户密码可登录、账号 ID/名称/类型不变、文件标记一致、healthz 200。升级后的库（23）及文件卷保留，无 Down 迁移或日常库删除。演练中的模型/密钥全部是本地 mock 测试值，不能用于真实部署。

本轮停止 PostgreSQL 容器动作被自动审批拒绝，未执行；此前的停库 503/起库 200 实测记录保留，独立回归 `TestU105HealthzChecksDatabase` 再次通过。此项与回滚恢复验证分别记录，不把未执行动作写成成功。公网证书、真实模型/平台仍需另行验收。
