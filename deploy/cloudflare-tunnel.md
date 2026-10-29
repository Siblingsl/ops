# OPS API 使用 Cloudflare Tunnel（避开大陆机未备案公网拦截）

与闲鱼栈的 `cloudflared` 同思路：服务器**主动出站**连 Cloudflare，用户只访问 CF；  
**不要**再把 `ops-api` 的 A 记录指到 `120.27.20.115`（指过去会被阿里云插备案拦截页）。

桌面端继续使用 `https://ops-api.88813888.xyz`（CF 提供对外 HTTPS）。

## 1. 在 Cloudflare 创建隧道

1. 打开 [Zero Trust](https://one.dash.cloudflare.com/) → **Networks** → **Tunnels** → **Create a tunnel**
2. 选 **Cloudflared**，名称例如 `ops-api`
3. 复制安装用的 **token**（形如一长串，只显示一次；保存好）
4. 在隧道的 **Public Hostname** 里添加：

| 字段 | 值 |
| --- | --- |
| Subdomain | `ops-api` |
| Domain | `88813888.xyz` |
| Type | `HTTP` |
| URL | `http://127.0.0.1:44537` |

如需兼容旧名，可再加一条 `ops` → 同一 URL。

5. 保存。CF 会自动加 **CNAME**（指向 `xxxx.cfargotunnel.com`，橙云）。  
   若 DNS 里还有 `ops-api` 的 **A → 120.27.20.115**，**删掉或改成隧道 CNAME**，不要两套并存。

## 2. 服务器写入 token 并启动

```bash
cd /opt/ops/deploy
cp -a .env ".env.bak.tunnel.$(date +%Y%m%d-%H%M%S)"
# 追加一行（把 token 换成你的，不要提交到 git）
grep -q '^CLOUDFLARE_TUNNEL_TOKEN=' .env \
  && sed -i 's/^CLOUDFLARE_TUNNEL_TOKEN=.*/CLOUDFLARE_TUNNEL_TOKEN=你的token/' .env \
  || echo 'CLOUDFLARE_TUNNEL_TOKEN=你的token' >> .env
chmod 600 .env

# 确认 API 本机仍健康
curl -fsS http://127.0.0.1:44537/healthz

# 需要先有仓库里的 docker-compose.tunnel.yml（git pull 或手动放好）
docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml --env-file .env up -d cloudflared
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -E 'ops-cloudflared|NAMES'
docker logs ops-cloudflared --tail=30
```

日志里应出现 `Registered tunnel connection` 之类字样，不应反复报 token 错误。

## 3. 从 edge-nginx 拿掉 OPS 公网站点（避免再走备案拦截）

编辑 `/opt/xianyu-tool/nginx/api.conf`，**删除或注释**所有  
`server_name ops.88813888.xyz` / `ops-api.88813888.xyz` 的 `server { ... }` 块  
（含 80/443）。闲鱼等其它站点不要动。

```bash
docker exec edge-nginx nginx -t && docker exec edge-nginx nginx -s reload
```

## 4. 应用 Cookie（对外仍是 HTTPS）

`.env` 保持：

```dotenv
OPS_COOKIE_SECURE=1
OPS_COOKIE_SAMESITE=none
OPS_CORS_ORIGINS=ops-desktop://business
OPS_DOMAIN=ops-api.88813888.xyz
```

若改过需重建 app：

```bash
docker compose -f docker-compose.prod.yml --env-file .env up -d --force-recreate app
```

## 5. 验收

本机：

```bash
curl -fsS http://127.0.0.1:44537/healthz
```

电脑（应返回纯文本 `ok`，不是备案 HTML、不是 JSON 404）：

```powershell
curl.exe -m 15 -fsS https://ops-api.88813888.xyz/healthz
```

## 6. 日常更新

日常只需：

```bash
cd /opt/ops/deploy
./update.sh
```

`update.sh` 若检测到 `.env` 里已有非空的 `CLOUDFLARE_TUNNEL_TOKEN` 且存在 `docker-compose.tunnel.yml`，会自动带上隧道 compose，一并确保 `ops-cloudflared` 在跑，无需再记第二条命令。

手动叠加启动（排障时）：

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml --env-file .env up -d
```

## 说明

- 隧道**不能代替**国内面向公众网站的合规要求；此处仅解决「未备案域名被阿里云公网入口拦截」的技术路径，与闲鱼现网做法对齐。
- WebSocket（`/api/v1/desktop/channel`）与 SSE 经 cloudflared 默认可用，无需再开源站 443。
- Token 泄露后在 Zero Trust 里轮换 token 并更新 `.env`。
