# HTTPS 上线步骤（OPT-01）

本说明只用于仓库外的实际部署，由服务器维护者执行。不要在证书签发前安装 `nginx-ops-https.conf`，否则 Nginx 会因证书文件不存在而无法加载配置。
以下 Compose 命令在服务器仓库的 `deploy/` 目录执行。

## 1. 备份并确认前置条件

在服务器上备份当前 Nginx 配置和 `deploy/.env`，并确认：

- `ops.88813888.xyz` 的 DNS A 记录指向本机公网 IP；
- 云防火墙和主机防火墙允许公网 TCP 80、443；
- 当前 HTTP 站点可访问，且实际 Nginx 配置为 `/.well-known/acme-challenge/` 配置 `/var/www/certbot` webroot（仓库模板 `nginx-ops.conf` 已包含该 location；线上配置需用 `nginx -T` 核对）；
- 生产 `.env` 权限为仅维护者可读，不把其中内容贴进工单或日志。

```bash
sudo cp -a /etc/nginx/conf.d/ops.conf /etc/nginx/conf.d/ops.conf.before-https
cp -a .env .env.before-https
sudo mkdir -p /var/www/certbot
sudo nginx -t
```

如果实际配置文件不在 `/etc/nginx/conf.d/ops.conf`，先用 `nginx -T` 找到对应站点文件，再替换以上路径。
如果线上 HTTP server 尚无 ACME location，先加上下面配置并通过 `nginx -t` 后 reload，再申请证书：

```nginx
location ^~ /.well-known/acme-challenge/ {
    root /var/www/certbot;
}
```

## 2. 签发证书

安装 Certbot 及其 webroot 支持后执行：

```bash
sudo certbot certonly --webroot -w /var/www/certbot -d ops.88813888.xyz
sudo certbot certificates
```

确认 `fullchain.pem` 和 `privkey.pem` 均已生成。保留 HTTP challenge location，以便证书续期。

## 3. 启用 HTTPS 与短期 HSTS

将仓库中的 HTTPS 模板安装为实际站点配置。模板将 HTTP 普通请求 301 到固定 HTTPS 域名，仅 ACME challenge 留在 HTTP；HTTPS 反代保留 SSE 透传设置，并为 `/api/v1/desktop/channel` 配置精确匹配的 WebSocket Upgrade 路由，再发送 `Strict-Transport-Security: max-age=300`。

```bash
sudo cp -a nginx-ops-https.conf /etc/nginx/conf.d/ops.conf
sudo nginx -t
sudo systemctl reload nginx
```

然后在生产 `.env` 中设置 `OPS_COOKIE_SECURE=1` 并只重建应用容器：

```bash
docker compose --env-file .env -f docker-compose.prod.yml up -d --force-recreate app
```

逐项验证：

```bash
curl -sSI http://ops.88813888.xyz/
curl -fsS https://ops.88813888.xyz/healthz
sudo certbot renew --dry-run
```

HTTP 应返回指向 HTTPS 的 301；健康检查应返回 `ok`。以已认证桌面客户端完成 WSS 通道握手与一轮心跳/断开重连，不能只用健康检查替代 WebSocket 验收。在浏览器登录响应的 `Set-Cookie` 中确认会话 Cookie 含 `Secure`、`HttpOnly`、`SameSite=Lax`，并确认 HTTPS 页面、登录和作品图片正常。等待短期 HSTS 验证后再做 SSL Labs 检查。

## 4. 拉长 HSTS

短期验证和证书续期演练都通过后，将 HTTPS server 中的 HSTS 行改为：

```nginx
add_header Strict-Transport-Security "max-age=31536000" always;
```

先执行 `sudo nginx -t`，再 reload；通过 HTTPS 响应头确认新值生效，并完成 SSL Labs 检查，评级需达到 A。没有确认所有子域名都永久支持 HTTPS 前，不要添加 `includeSubDomains` 或 `preload`。

## 5. 回滚

如果启用后健康检查或登录异常，恢复备份配置并先检查再 reload；将 `.env` 中的 `OPS_COOKIE_SECURE` 改回 `0` 后，只重建 app 容器：

```bash
sudo cp -a /etc/nginx/conf.d/ops.conf.before-https /etc/nginx/conf.d/ops.conf
sudo nginx -t
sudo systemctl reload nginx
```

在 `.env` 中恢复 `OPS_COOKIE_SECURE=0` 后执行第 3 节的 Compose 命令。若浏览器已收到 HSTS，短期 `max-age=300` 会在最多五分钟后过期；期间应尽可能保留 HTTPS 服务。HSTS 已拉长后，浏览器会在有效期内强制使用 HTTPS，即使服务器回退到 HTTP，因此回滚时优先修复并继续提供 HTTPS，不要指望 HTTP 能立即恢复。

## 6. 日常维护

每次改动后运行 `nginx -t` 再 reload。保持证书自动续期任务启用，并每月执行一次 `sudo certbot renew --dry-run`；续期失败时先修复挑战路径和端口，再继续使用 HTTPS。
