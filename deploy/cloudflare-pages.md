# Web 前端上 Cloudflare Pages（后端仍在阿里云青岛）

> **当前状态（2026-10-27）**：Web 前端暂不发布到 Cloudflare Pages；`pages.yml` 仅保留手动入口。本文下方的 Pages 部署步骤和旧域名配置均已过时，请勿照做。当前只迁移后端 API 与桌面端，按[桌面端 API 迁移步骤](./desktop-api-migration.md)操作。

对应决策 D-153。改造后的形态：

```
                      ┌──────────────────────────────┐
  浏览器 ────────────▶ │ Cloudflare Pages（纯静态）    │  web.88813888.xyz
                      │  React 产物，无 Functions     │
                      └──────────────┬───────────────┘
                                     │ 跨源 fetch（带 Cookie + CSRF 头）
                                     ▼
                      ┌──────────────────────────────┐
                      │ 阿里云青岛 120.27.20.115      │  ops.88813888.xyz
                      │ Nginx :443 → app:8080         │  （同时仍托管一份
                      │  /api/v1/*  后端 API          │   自托管前端给桌面端用）
                      └──────────────────────────────┘
```

- **web 前端**：Cloudflare Pages 静态托管，构建期用 `OPS_API_BASE` 指向 `https://ops.88813888.xyz`。
- **桌面端**：完全不变，仍然加载后端自托管的 `https://ops.88813888.xyz`（`desktop/src/business-origin.ts` 的 `PRODUCTION_ORIGIN` 没动），所以 `OPS_STATIC_DIR=/app/static` 必须保留。
- **后端**：新增 CORS 白名单（`OPS_CORS_ORIGINS`）。不填 = 不启用 CORS = 只能同源访问，也就是改造前的行为。

本文默认沿用仓库现有生产地址：Web `web.88813888.xyz`、API `ops.88813888.xyz`、Pages 项目 `ops-web`。如果你现在用的域名或服务器不同，按实际地址替换，并让 `OPS_API_BASE` 与 `OPS_CORS_ORIGINS` 使用同一组地址。

## 0. 为什么不用 Pages Functions 反代 /api

本项目使用 Pages 纯静态托管，浏览器直接请求 API 域名，由 Go 后端 CORS 白名单放行。这样 SSE 与 WebSocket 不经过 Pages 转发。前端域名与 `ops.88813888.xyz` 同属 `88813888.xyz`（same-site），会话 Cookie 保持 `SameSite=Lax` 即可，不需要 `SameSite=None`。

## 1. 前端域名与备案（先看这一段）

按当前仓库的生产记录，云服务器在**阿里云青岛（中国大陆）**，域名 `88813888.xyz` **未备案**。如果你实际的服务器地域或域名状态已经不同，请以云厂商和域名管理后台的当前状态为准。此处架构上的影响是：

- 直接解析到 `120.27.20.115` 的域名走 80/443，会被阿里云按备案要求拦截（`ops.88813888.xyz` 目前能用，说明它已经在走某种可用路径，具体以你的实际情况为准）。
- **Cloudflare Pages 托管的是前端静态页面**：给 Pages 项目绑定 `web.88813888.xyz` 后，页面由 Cloudflare 提供，不回源到这台服务器。大陆访问情况还取决于域名和网络环境。
- 但**前端能打开 ≠ 后端能调通**。浏览器随后会去请求 `https://ops.88813888.xyz/api/v1/...`，这条链路仍然是"用户 → 阿里云青岛"，如果它现在在你的网络环境下能用，改造后也照旧能用；如果它在某些网络下不可用，Cloudflare Pages 帮不了它——那是另一件事（把后端域名也挂到 CF 橙云代理上，或用境外中转，会牵扯 SSE/WS 缓冲与回源延迟，不在本次改造范围内）。

结论：**前端上 CF 解决的是"前端页面在大陆可访问且不消耗服务器带宽"，不解决后端域名本身的备案问题。** 如果目标是"国内任何网络都能稳定调通后端"，那需要给后端域名做备案，或者把后端也搬到境外——那是另一个决策。

## 建议迁移顺序

1. 创建 Pages Direct Upload 项目，拿到 Account ID、API Token，并先把 Cloudflare 与服务器 SSH 凭据配进 GitHub。
2. 在服务器 `.env` 加入 Web 来源白名单并确认 HTTPS Cookie 配置。
3. 把本次仓库改动推到 `main`，等待 GitHub 的 `CI`、`Deploy`、`Pages` 工作流结束；Pages 此时先发布到 `*.pages.dev`。
4. 确认服务器 `Deploy` 成功、API CORS 预检返回 204 后，再给 Pages 绑定正式 Web 域名。这样正式入口不会早于后端白名单生效。
5. 按第 5 节完成 Web 登录和桌面端回归。

## 2. Cloudflare 侧操作

### 2.1 建 Pages 项目（Direct Upload，不接 Git 集成）

用 GitHub Actions 上传构建产物，而不是让 CF 自己拉仓库构建——因为构建需要 `OPS_API_BASE`，交给 CI 更可控，也不占 CF 的构建分钟数。

1. 登录 <https://dash.cloudflare.com>，左侧 **Workers & Pages** → **Create** → **Pages** → **Upload assets**。
2. 项目名填 `ops-web`（对应 workflow 里的 `CF_PAGES_PROJECT`，可以改，两边保持一致）。
3. 第一次会让你上传一个目录，随便传个空目录占位即可（后面 CI 会覆盖）。

### 2.2 拿 Account ID 和 API Token

1. **Account ID**：Dashboard 任意页面右侧栏 → **Account ID**，或 **Workers & Pages** 页面 URL 里 `accounts/<32位十六进制>` 那一段。
2. **API Token**：右上角头像 → **My Profile** → **API Tokens** → **Create Token** → **Create Custom Token**：
   - Permissions：`Account` → `Cloudflare Pages` → `Edit`
   - Account Resources：限定到你这个账号
   - 生成后**只显示一次**，立刻复制。

### 2.3 绑定自定义域名

首次迁移时等服务器的 `Deploy` 工作流成功、API CORS 预检通过后再执行本节；此之前 Pages 可先用 `*.pages.dev` 验证静态资源。

1. Pages 项目 → **Custom domains** → **Set up a custom domain**。先在 Pages 项目里绑定域名，再配置 DNS；不要只手动添加 CNAME，否则可能出现 522。
2. 填 `web.88813888.xyz`（或你最终定的子域名；定了之后要同步改两处：本文件、服务器 `.env` 里的 `OPS_CORS_ORIGINS`）。
3. 如果域名 DNS 在这个 Cloudflare Zone，确认自动创建的 CNAME；如果 DNS 在别的服务商，手动添加 CNAME：名称为 `web`，目标为 `ops-web.pages.dev`（以 Pages 项目显示的 `*.pages.dev` 地址为准）。不要自行修改 Pages 自动创建的 DNS 代理状态。
4. 等 Pages 自定义域名状态变成 **Active**，并确认 HTTPS 证书有效。

> 注意：不要在 `ops.88813888.xyz` 上重复做这一步。后端域名保持现状（目前是 A 记录直连阿里云、DNS only）。若以后把后端也改为经 Cloudflare 代理，需单独验证 SSE 与 `/api/v1/desktop/channel` WebSocket 的行为；本方案不把 API 流量经过 Pages。

### 2.4 记下 project name

后面 GitHub 的 `CF_PAGES_PROJECT` 要填这个值（本文用 `ops-web`）。

## 3. GitHub 侧配置

### 3.1 Secrets（Settings → Secrets and variables → Actions → Secrets）

| 名称 | 值 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 2.2 生成的 Token |
| `CLOUDFLARE_ACCOUNT_ID` | 2.2 拿到的 Account ID |

如果尚未配置服务器 SSH 部署，再添加这些 Secrets：

| 名称 | 值 |
| --- | --- |
| `DEPLOY_HOST` | 服务器 SSH 地址或 IP |
| `DEPLOY_USER` | 用于部署的 SSH 用户 |
| `DEPLOY_PATH` | 服务器上的仓库目录，例如 `/opt/ops` |
| `DEPLOY_SSH_KEY` 或 `DEPLOY_SSH_KEY_B64` | 对应公钥已放入服务器 `authorized_keys` 的私钥；二选一 |

### 3.2 Variables（同页面的 Variables 标签，可选）

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `CF_PAGES_PROJECT` | `ops-web` | Pages 项目名 |
| `OPS_API_BASE` | `https://ops.88813888.xyz` | 前端构建时写入的后端地址 |

不配也能跑，workflow 里有默认值。

### 3.3 workflow 行为

`.github/workflows/ci.yml`、`pages.yml` 与 `deploy.yml`：

- Pages 只在 push 到 `main` 且改动涉及 `web/**` 或 `pages.yml` 时部署；手动 `workflow_dispatch` 只能选择 `main`。
- Pages 部署和服务器部署都会等待同一提交的 `CI` 工作流成功；失败、取消或 20 分钟仍未完成时停止部署。
- Pages 构建：`pnpm install --frozen-lockfile` → `OPS_API_BASE=... pnpm run build` → 上传 `web/dist`。发布只使用这次 CI 对应的提交。
- 服务器部署：CI 成功后经 SSH 调用 `deploy/update.sh <提交SHA>`，脚本校验提交仍属于 `origin/main`，再构建并重启后端容器。
- 第一次 Pages 工作流会尝试创建 Direct Upload 项目；项目已存在时继续部署。`CF_PAGES_PROJECT` 必须与创建时的项目名一致。

这样 CI 失败时两个生产环境都不会更新。后端仍会在 Docker 镜像中构建并保留一份静态页面，供桌面端使用。

## 4. 服务器侧操作

### 4.1 改 `deploy/.env`

```bash
cd /path/to/OPS/deploy
cp .env .env.bak
```

在 `.env` 里加/改两行（其余保持不变）：

```ini
# 允许 Cloudflare Pages 上的前端跨源调用 API；域名定了就换成实际值
OPS_CORS_ORIGINS=https://web.88813888.xyz
# 服务器已启用 HTTPS 时设为 1
OPS_COOKIE_SECURE=1
# 同站不同源，保持 lax 即可
OPS_COOKIE_SAMESITE=lax
```

如果当前服务器仓库还没有 `.env`，先按 `deploy/.env.example` 创建并填写现有生产密钥；不要把 `.env` 提交到 GitHub。确认 API 域名的 HTTPS 证书正常，云厂商安全组允许公网 TCP 443（如使用 ACME HTTP 验证还需 TCP 80），SSH 端口只开放给你的管理来源。不要把应用回环端口 `44537` 或 PostgreSQL `5432` 暴露到公网。

注意：

- 值必须是**完整来源**（`scheme://host[:port]`），**不能带路径、不能带尾斜杠**；写错会被配置校验拒绝并拒绝启动，错误信息形如 `OPS_CORS_ORIGINS 中没有合法的来源（应形如 https://web.88813888.xyz）`。
- 多个来源用英文逗号分隔：`https://web.88813888.xyz,https://staging-web.88813888.xyz`。
- 服务器使用 HTTPS 时，`OPS_COOKIE_SECURE=1`；`SameSite=Lax` 可在同站不同源的 Pages/API 间随 `credentials: include` 请求发送。
- `OPS_STATIC_DIR=/app/static` **不要删**——桌面端和 `ops.88813888.xyz` 直连访问都靠它。

### 4.2 应用

```bash
cd /path/to/OPS
bash deploy/update.sh
```

改完 `.env` 后手动执行上面的命令可立即重建并应用配置；常规代码发布由 GitHub Actions 在 CI 成功后 SSH 执行脚本并传入已验证的提交 SHA。

脚本会先拉取代码并备份，再构建镜像、重建容器。自动发布传入 CI 已验证的提交 SHA；手动执行则部署 `origin/main`。改 `.env` 后必须重建容器（Compose `environment` 的值在容器创建时固化）。

### 4.3 Nginx 不用改

`deploy/nginx-ops-https.conf` 里的 `location /` 已经把 `/api/` 全部转发给 Go，OPTIONS 预检请求也一样转发；CORS 响应头由 Go 中间件统一产出，**不要在 Nginx 里再加 `add_header Access-Control-*`**，否则会出现重复头，浏览器会直接判定失败。

## 5. 验证

### 5.1 后端 CORS 是否生效

在任意机器上：

```bash
# 预检
curl -i -X OPTIONS https://ops.88813888.xyz/api/v1/auth/me \
  -H 'Origin: https://web.88813888.xyz' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: x-csrf-token'

# 期望：HTTP/2 204
#       Access-Control-Allow-Origin: https://web.88813888.xyz
#       Access-Control-Allow-Credentials: true
#       Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
#       Access-Control-Max-Age: 600

# 未在白名单的来源必须被拒
curl -i -X OPTIONS https://ops.88813888.xyz/api/v1/auth/me \
  -H 'Origin: https://evil.example.com' \
  -H 'Access-Control-Request-Method: GET'
# 期望：HTTP/2 403，且没有 Access-Control-Allow-Origin
```

```bash
# 真实请求也要回 ACAO，并暴露分页头
curl -i https://ops.88813888.xyz/api/v1/healthz -H 'Origin: https://web.88813888.xyz'
# 期望：Access-Control-Allow-Origin + Access-Control-Expose-Headers 里含
#       X-Request-ID, X-Total-Count, X-Has-More, X-Offset, X-Limit, X-Next-Cursor, X-OPS-Basis-Revision
```

### 5.2 桌面端通道没有被影响

```bash
# 桌面 WS 通道设计上要求"没有 Origin 头"，CORS 中间件对它完全放行
curl -i https://ops.88813888.xyz/api/v1/desktop/channel -H 'Origin: https://web.88813888.xyz'
# 期望：403 desktop_ai_forbidden，且响应里没有 Access-Control-Allow-Origin
```

### 5.3 前端页面

1. 打开 `https://web.88813888.xyz`，DevTools → Network：
   - 静态资源（`/assets/*.js`、`/sw.js`）来自 `web.88813888.xyz`；
   - `/api/v1/*` 请求打到 `ops.88813888.xyz`，状态 200，请求头带 `X-CSRF-Token`；
   - 响应头有 `Access-Control-Allow-Origin: https://web.88813888.xyz`。
2. 登录一次，Application → Cookies 里应有 `ops_session`（Domain = `ops.88813888.xyz`，HttpOnly，SameSite=Lax）。
3. 随便改一条内容（触发 POST/PUT），确认没有 `csrf_invalid`。
4. 打开"作品列表"翻页，确认分页正常（这依赖 `X-Has-More` / `X-Total-Count` 被 CORS 暴露；没暴露时会静默退化成"只有第一页"）。
5. 进智能体对话页，确认事件流有持续输出（SSE 没被缓冲）。
6. 上传一张图片、点导出 Markdown、点技能导出 `.md`——这三条分别验证 `assetUrl()`、`apiBase()` 拼接与跨源 blob 下载。
7. 桌面端打开，确认仍是 `ops.88813888.xyz` 自托管页面且功能正常（`OPS_STATIC_DIR` 保留的意义）。

## 6. 回滚

前端出问题：在 Cloudflare Pages 项目 → **Deployments** → 找到上一个正常版本 → **Rollback**。纯静态，秒级生效，不影响后端。

后端出问题：把 `.env` 里的 `OPS_CORS_ORIGINS` 清空（回到"只允许同源"），然后 `bash deploy/update.sh`。此时 `https://ops.88813888.xyz` 自托管页面完全正常，只有 CF 上的前端会跨源失败。

## 7. 常见问题

**登录后立刻被踢回登录页**
Cookie 没带上。检查：`OPS_CORS_ORIGINS` 与浏览器地址栏的 origin 是否**逐字符相同**（`http` vs `https`、有没有 `www`、端口）；前端是否用 `credentials: 'include'`（代码里已改）；`OPS_COOKIE_SECURE=1` 时前端必须是 https。

**改了内容提示"页面已过期，请刷新后重试"**
CSRF 头没发出去或预检被拒。检查浏览器 Network 里那条请求之前的 OPTIONS 是否 204、`Access-Control-Allow-Headers` 是否含 `x-csrf-token`。

**列表只显示第一页 / 总数显示 0**
`Access-Control-Expose-Headers` 缺失或被 Nginx 的 `add_header` 覆盖。确认只在 Go 里设置 CORS 头。

**智能体回复"卡住"不流式**
SSE 被中间层缓冲。确认请求直达 `ops.88813888.xyz`（没经过 CF 代理），Nginx `location /` 里 `proxy_buffering` 是 on 但后端已用 `X-Accel-Buffering: no` 关闭；若以后给后端套了 CF 橙云，需要额外处理。

**Cloudflare 部署报 `Project not found`**
`CF_PAGES_PROJECT` 与 Dashboard 里的项目名不一致，或者 Token 没有 Pages:Edit 权限。

**`_headers` 里的缓存策略没生效**
`web/public/_headers` 必须被构建复制到 `web/dist/_headers`。检查 CI 的 Build 步骤后 dist 里有没有这个文件；另外 Pages 的缓存策略只作用于静态资源，不作用于 API（本项目 API 不在 CF 上）。
