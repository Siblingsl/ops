# 桌面端内置 UI 与 API 域名迁移

目标：后端继续运行在现有云服务器；Electron 安装包本地加载桌面专用 UI；桌面 API 和 WSS 使用 `https://ops-api.88813888.xyz`；普通 Web 源码继续保存在仓库，但本次不发布到 Cloudflare Pages。

桌面 UI 现从 `desktop/renderer-src/` 构建，Web 源码位于 `web/`；两端的共用功能需要分别维护。本迁移不改变桌面页面的外观或交互。

## 迁移顺序

不要先推代码再补 DNS/TLS。推送到 `main` 会触发 CI，但服务器自动部署已由 `OPS_PRODUCTION_DEPLOY_ENABLED` 闸门控制；首次迁移必须先准备域名和反代，再手动部署。

### 1. 先只读检查服务器当前反代

你之前在服务器执行的检查显示 `443` 没有监听，而 `xianyu-nginx-api` 是 Docker Nginx。Cloudflare 当前是 Full 模式，因此要先确保源站 `443` 有 TLS 证书和监听；Full 模式会按访客的 HTTPS 请求连接源站 HTTPS，没有 443 会导致连接失败。

SSH 登录服务器后执行以下只读命令：

```bash
cd /opt/ops
docker compose -f deploy/docker-compose.prod.yml ps
docker port xianyu-nginx-api
docker inspect --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}' xianyu-nginx-api
docker inspect --format '{{json .HostConfig.PortBindings}}' xianyu-nginx-api
docker exec xianyu-nginx-api nginx -T 2>&1 | grep -nE 'listen|server_name|ssl_certificate|proxy_pass|desktop/channel|root '
ss -ltnp '( sport = :80 or sport = :443 )'
```

把命令输出发回后，再按容器真实配置目录和端口映射更新反代。先不要把 `nginx-ops-https.conf` 复制到宿主机，也不要运行 `systemctl reload nginx`；那份模板是宿主机 Nginx 配置，而你当前跑的是 Docker Nginx。不得对生产库执行 `docker compose down -v`。

### 2. 在 Cloudflare 新增 API DNS 记录

打开 Cloudflare 的 `88813888.xyz` → **DNS** → **记录** → **添加记录**：

| 字段 | 填写 |
| --- | --- |
| 类型 | `A` |
| 名称 | `ops-api` |
| IPv4 地址 | `120.27.20.115` |
| 代理状态 | 已代理（橙色云朵） |
| TTL | 自动 |

保存后确认记录是 `ops-api.88813888.xyz`。先保留原来的 `ops.88813888.xyz` 记录，暂时不要改或删除；新客户端验收完成后再清理。

### 3. 给 Docker Nginx 准备源站 HTTPS

在 Cloudflare `88813888.xyz` → **SSL/TLS** → **源服务器**（Origin Server）创建一张仅覆盖 `ops-api.88813888.xyz` 的 Origin CA 证书，将证书和私钥安全地放到 Nginx 容器的持久挂载目录，并让 Nginx 在 TCP `443` 提供 HTTPS。私钥不要贴到聊天、GitHub、仓库或普通日志。

这一步的具体文件路径和容器重载命令取决于第 1 步检查出来的 Docker 挂载与端口映射；拿到输出前不要照抄宿主机 Nginx 命令。还需在云服务器安全组和主机防火墙放行 TCP `443`。确认 `https://ops-api.88813888.xyz/healthz` 可返回 `ok` 后，再到 Cloudflare **SSL/TLS → 概述**将模式改成 **完全（严格）**。严格模式要求源站证书未过期、覆盖该主机名且由受信 CA 或 Cloudflare Origin CA 签发。[Cloudflare 的代理 DNS 说明](https://developers.cloudflare.com/dns/proxy-status/) · [Cloudflare 完全（严格）模式要求](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)

### 4. 推送代码并下载 CI 生成的桌面安装包

在本地仓库：

```powershell
cd F:\code\project\OPS
git status --short
git diff --check
```

先确认改动清单里没有把生产 `.env`、密钥或你自己的 `AGENTS.md` 放进提交。只暂存本任务文件，不要用 `git add -A`：

```powershell
git add .gitignore .github/workflows/ci.yml .github/workflows/deploy.yml .github/workflows/pages.yml deploy/.env.example deploy/Caddyfile deploy/Dockerfile deploy/cloudflare-pages.md deploy/desktop-api-migration.md deploy/docker-compose.prod.yml deploy/https-setup.md deploy/nginx-ops-https.conf deploy/nginx-ops.conf deploy/update.sh desktop/README.md desktop/forge.config.cjs desktop/package.json desktop/public/settings/offline.js desktop/public/settings/settings.js desktop/scripts/start.cjs desktop/src/business-origin.ts desktop/src/desktop-client.ts desktop/src/main.ts desktop/src/settings-types.d.ts desktop/test/business-origin.test.cjs desktop/test/platform-auto-collect.test.cjs desktop/test/start.test.cjs desktop/test/vite-proxy.test.cjs docs/17-Electron客户端改造方案.md server/internal/app/cors.go server/internal/app/cors_test.go server/internal/config/config.go server/internal/config/config_test.go web/package.json web/src/lib/api-base.ts web/vite.config.ts
git diff --cached --check
git commit -m "D-154: 本地打包桌面 UI 并切换 API 域名"
git push origin main
```

CI 会运行后端、Web、桌面单元测试，并由 Windows runner 构建桌面安装程序。CI 成功后打开 GitHub 仓库 **Actions → CI → 对应提交**，下载 artifact：`ops-desktop-windows-x64`。本次没有 Pages 自动发布；不要手动运行 `Pages` 工作流。

部署自动闸门初始未开启。推送期间 `Deploy` 的 push job 应显示为跳过；只有本步骤生成安装包，不会自动重建生产服务器。

### 5. 只改服务器 `.env` 中这三项

在服务器执行：

```bash
cd /opt/ops/deploy
cp -a .env ".env.before-desktop-api.$(date +%Y%m%d-%H%M%S)"
nano .env
```

在现有文件里**只新增或修改**以下配置，保留原来的数据库密码、`OPS_MASTER_KEY` 和其它密钥：

```dotenv
OPS_DOMAIN=ops-api.88813888.xyz
OPS_COOKIE_SECURE=1
OPS_COOKIE_SAMESITE=none
OPS_CORS_ORIGINS=ops-desktop://business
```

保存后检查 Compose 语法，不打印包含密钥的完整配置：

```bash
docker compose -f docker-compose.prod.yml config --quiet
```

生产 Compose 会将 `OPS_STATIC_DIR` 显式设为空，覆盖旧 `.env` 里可能残留的静态目录路径；Go 容器因此只提供 API。数据库与业务数据卷继续沿用现有名称。

### 6. 手动部署后端 API-only 版本

GitHub 仓库打开 **Actions → Deploy → Run workflow**：

1. Branch 选择 `main`。
2. `action` 选择 `deploy`。
3. 点击运行，等待同一提交的 CI 成功及部署完成。

本次部署通过 `deploy/update.sh` 先做既有备份再更新 Compose，不要手动删除容器卷或数据库。若 Actions 页面没有手动部署入口，先检查 workflow 是否已在默认分支，并确认 `DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_PATH`、SSH 私钥等现有 Actions Secrets 完整；它们不需要 Cloudflare API Token。

### 7. 验证域名、CORS 与 Cookie

在服务器或本地终端执行：

```bash
curl -fsS https://ops-api.88813888.xyz/healthz
curl -fsS https://ops-api.88813888.xyz/api/v1/healthz
curl -i -X OPTIONS 'https://ops-api.88813888.xyz/api/v1/auth/me' \
  -H 'Origin: ops-desktop://business' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: x-csrf-token'
```

两条健康检查应返回 `ok`；预检应返回 `204`，响应中应有：

```text
Access-Control-Allow-Origin: ops-desktop://business
Access-Control-Allow-Credentials: true
```

在客户端上安装 CI artifact 中的 Squirrel 安装包，完整退出旧桌面客户端后启动新版并重新登录。API 主机名改变后会话 Cookie 不会迁移，第一次需要重新登录；本机模型密钥和平台登录 profile 会沿用旧的数据命名空间，不会因 API 域名改变而丢失。确认桌面 UI 与旧版一致，并实际验证登录、作品读取/保存、文件上传、WSS 客户端连接和断线重连。

桌面通道 `/api/v1/desktop/channel` 仍由客户端使用 WSS 连接，不使用 CORS；Nginx 必须保留该路径的 WebSocket Upgrade 转发。SSE、上传请求也必须经过同一 API 反代。

### 8. 清理旧域名并恢复后续自动部署

新版客户端确认正常后，才可在 Cloudflare DNS 删除旧的 `ops` A 记录。代码仍保留字符串 `https://ops.88813888.xyz` 作为兼容本机 profile 数据的键，它不再发起任何网络请求。

如果希望后续 `main` 推送自动更新服务器，在 GitHub 仓库 **Settings → Secrets and variables → Actions → Variables** 新建：

```text
名称：OPS_PRODUCTION_DEPLOY_ENABLED
值：true
```

首次迁移期间不要设置该变量。若更愿意每次手动部署，可保持变量缺省。Cloudflare Pages 继续保持未发布；若以后恢复 Web 发布，需要另行把 Web 域名加入服务器 CORS 白名单并验证 Web Cookie，不能直接复用当前仅含桌面来源的白名单。

## 出错时

- 健康检查失败：先查看 `docker compose -f deploy/docker-compose.prod.yml ps` 和 app 日志，不要删卷；必要时通过 Actions 手动重新部署最近一次可用提交。
- CORS 预检不是 `204`：检查容器内 `OPS_CORS_ORIGINS` 是否精确为 `ops-desktop://business`，且无尾斜线或多余空格。
- Cookie 登录后仍未授权：确认服务端最终值为 `OPS_COOKIE_SECURE=1`、`OPS_COOKIE_SAMESITE=none`，Cloudflare 和源站全程 HTTPS，之后重启 app 并重新登录。
- Cloudflare 报 525/526：分别检查源站 443、证书主机名、证书有效期和 SSL/TLS 模式；不要切换到 Flexible 绕过 TLS。
