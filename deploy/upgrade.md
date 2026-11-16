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

## 4 智能体 / AI 生产默认值（CF-SKAG-04，2026-11-12）

> 范围：**文档化 + 一次 `OPS_DEV=0` 演练**。本节**不修改任何默认值**、不改代码 / 配置 / 迁移 / 特性开关，不写真实密钥，不启动完整服务，不调用真实模型或平台。
> 来源：`docs/35` §1.1 / §2.1 / §3 波次 L0；`docs/34` §8 CF-SKAG-04；`docs/16` §14.3；`docs/08:828/834`；`docs/design/ag-go-live-checklist.md`。

### 4.1 现取默认值（逐项给源码锚点）

| 项 | 当前默认 | 源码 / 配置锚点 |
|---|---|---|
| `OPS_AI_WORKERS` | **3**，合法区间 1–32；越界值被忽略并回默认 | `server/internal/config/config.go:93` `c.AIWorkers = 3`；`config.go:98` `n >= 1 && n <= 32` |
| 编排侧覆盖 | `${OPS_AI_WORKERS:-3}` | `deploy/docker-compose.prod.yml:34`；`deploy/.env.example:37` 注释 `# OPS_AI_WORKERS=3` |
| `ai_limit`（每日用量） | 缺省 **`enabled=false, daily_tokens=2000000`**（即未启用限额） | `server/internal/app/review.go:891-892` 的 `coalesce(..., '{"enabled":false,"daily_tokens":2000000}'::jsonb)` |
| `ai_limit` 写入约束 | `daily_tokens` 下限 1000 | `server/internal/app/agent_tools_settings.go:174` |
| 智能体工作区设置 | 缺省 **开启 / 观察者可用 / 允许选模型** 三项全 true；值损坏时回退默认并告警 | `server/internal/app/agent.go:35-43` `defaultAgentSettings()`；`:57-61` |
| 单次运行调用量 | 最多 **12 轮模型调用 + 3 次生成** | `docs/16:1329`；`docs/08:834` |

### 4.2 推荐值与确认口径（**建议，不是已改**）

1. **保持 `OPS_AI_WORKERS=3` 起步**，按真实并发与 `ai_queue_timeout`（60 秒，`docs/16:567`）实测后再调 1–32；智能体每次最多 15 次模型/生成调用，槽位不足会排队，排队不消耗 token 也不启动首字超时（`docs/06:424`）。
2. **`ai_limit` 缺省关闭**：若部署启用限额，须确认 `daily_tokens` 覆盖智能体额外调用，并观察一个完整计费日；不要凭默认值推断「已在限额内」。
3. **智能体设置缺省三项全 true**：上线前由所有者确认 `viewer_enabled=true`（观察者可用）是否符合本部署预期，需要时在「设置 → 智能体」逐项调整；**不新增批量开关**（D-117）。
4. **与 `CF-GATE` 联动**：19 项工作台特性仍**默认全关**（`agent_workbench.go:41-45`），三档开放表见 `docs/design/workbench-feature-tiering.md`，`docs/90` D-187 仍为「提议」、`CF-GATE-03` 未启动；本节**不构成对默认集的批准，也不改任何默认值**。桌面 AI 总闸与工作区二层策略见 `deploy/desktop-api-migration.md` 的「默认开关策略」节。`OPS_DESKTOP_PLATFORM_AUTO_ADOPT` 保持关闭。

### 4.3 `OPS_DEV=0` 演练记录（2026-11-12）

命令（`server/` 目录下，主密钥仅为运行时生成的 32 字节占位值，**未写入任何仓库文件**）：

```
OPS_DEV=0 OPS_MASTER_KEY="$(python -c "import base64;print(base64.b64encode(b'0'*32).decode())")" go test ./internal/config -count=1 -v
```

结果：**`TestLoadCORSAndSameSite` 5 个子用例 + `TestNormalizeOrigin` 全部 PASS，`ok ops/internal/config 0.046s`，EXIT=0**。证明 `OPS_DEV=0`（`config.go:49` `Dev = os.Getenv("OPS_DEV") != "0"`）下配置仍可加载、CORS/SameSite 解析不回归；非 Dev 分支的 `WechatBase` 走 `https://api.weixin.qq.com`（`config.go:103-106`），本地 mock 地址不会被带进生产形状。

**演练边界（如实登记）**：这只是一次**配置层演练**——未启动 `ops` 服务、未连数据库、未跑迁移、未验证 `AIWorkers` 在运行时进程中的实际取值（该值由 §4.1 静态源码核对）、未调用真实模型 / 真实平台、未做任何并发或排队压测、未在真实部署环境勾选上线检查。不得把它写成「生产默认值已验收」。

### 4.4 未验 / 剩余

- 真实部署下的并发槽位与每日上限覆盖（C2/C3）由 `CF-SKAG-03` 检查表与 `CF-SKAG-01/02` 的真 Key / 部署环境承接。
- 发布版本 HC-01～31 全量回归与 E2E-23/25 真模型人工复现仍缺（`docs/16` §14.3）。
- 本节交% 来自「文档 + 演练记录可关闭」，**不是生产默认已部署或已验收**。

### 4.5 回退

删本节 + 回写 `docs/34` §1 / §8.0 / §8 / §11、`docs/35` §1.1 / §0.2 / §2.1 / §4、`docs/08` 实施记录；**无代码 / 配置 / 默认值 / 迁移 / 特性开关变更**，`CF-GATE-03` 保持 `blocked`，19 项特性仍默认全关。
