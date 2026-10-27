# Web 前端上 Cloudflare Pages（后端仍在阿里云青岛）

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

## 0. 为什么不用 Pages Functions 反代 /api

三个原因，都是硬约束：

1. `_redirects` 不支持代理到外部域名（官方原文："Proxying will only support relative URLs on your site. You cannot proxy external domains."），所以反代只能写 Functions。
2. Pages Functions 免费额度是每天 10 万次请求，前端一次页面加载就是几十个 API 请求，很容易打满；纯静态项目的静态请求不计费、不限量。
3. Functions 转发 SSE（`/api/v1/notifications/stream`、智能体事件流）会引入额外缓冲与超时风险，聊天式界面会变成"卡住不动"。

所以走"浏览器直连后端 + 后端 CORS"这条路。前端域名与 `ops.88813888.xyz` 同属 `88813888.xyz`（same-site），会话 Cookie 保持 `SameSite=Lax` 就能随跨源请求发送，不需要 `SameSite=None`。

## 1. 前端域名与备案（先看这一段）

云服务器在**阿里云青岛（中国大陆）**，域名 `88813888.xyz` **未备案**。这意味着：

- 直接解析到 `120.27.20.115` 的域名走 80/443，会被阿里云按备案要求拦截（`ops.88813888.xyz` 目前能用，说明它已经在走某种可用路径，具体以你的实际情况为准）。
- **Cloudflare Pages 的前端域名不受此限制**：页面由 CF 全球边缘节点提供，不回源到大陆服务器，所以 `web.88813888.xyz`（CNAME 到 `xxx.pages.dev`，**必须开橙云代理**）可以正常访问。
- 但**前端能打开 ≠ 后端能调通**。浏览器随后会去请求 `https://ops.88813888.xyz/api/v1/...`，这条链路仍然是"用户 → 阿里云青岛"，如果它现在在你的网络环境下能用，改造后也照旧能用；如果它在某些网络下不可用，Cloudflare Pages 帮不了它——那是另一件事（把后端域名也挂到 CF 橙云代理上，或用境外中转，会牵扯 SSE/WS 缓冲与回源延迟，不在本次改造范围内）。

结论：**前端上 CF 解决的是"前端页面在大陆可访问且不消耗服务器带宽"，不解决后端域名本身的备案问题。** 如果目标是"国内任何网络都能稳定调通后端"，那需要给后端域名做备案，或者把后端也搬到境外——那是另一个决策。

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

1. Pages 项目 → **Custom domains** → **Set up a custom domain**。
2. 填 `web.88813888.xyz`（或你最终定的子域名；定了之后要同步改两处：本文件、服务器 `.env` 里的 `OPS_CORS_ORIGINS`）。
3. 因为 `88813888.xyz` 的 NS 已经在 Cloudflare（`daphne.ns.cloudflare.com` / `rudy.ns.cloudflare.com`），CF 会自动加 CNAME 记录，点确认即可。
4. **确保这条 CNAME 是橙云（Proxied）**。灰云会让浏览器直连 `pages.dev` 的 IP，虽然也能用，但失去 CF 的 CDN/证书托管，且部分网络下 `pages.dev` 访问不稳定。
5. 等状态变成 **Active**（通常 1-5 分钟，证书签发偶尔要十几分钟）。

> 注意：不要在 `ops.88813888.xyz` 上重复做这一步。后端域名保持现状（目前是 A 记录直连阿里云、灰云）。若以后要给后端也套 CF，记得 `/api/v1/desktop/channel` 的 WebSocket 与 SSE 需要 `proxy_buffering off`，并且 CF 免费版对 SSE 有 100 秒空闲断连的限制。

### 2.4 记下 project name

后面 GitHub 的 `CF_PAGES_PROJECT` 要填这个值（本文用 `ops-web`）。

## 3. GitHub 侧配置

### 3.1 Secrets（Settings → Secrets and variables → Actions → Secrets）

| 名称 | 值 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 2.2 生成的 Token |
| `CLOUDFLARE_ACCOUNT_ID` | 2.2 拿到的 Account ID |

原有的 `DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_PATH` / `DEPLOY_SSH_KEY` 保持不变，后端部署照旧走 SSH。

### 3.2 Variables（同页面的 Variables 标签，可选）

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `CF_PAGES_PROJECT` | `ops-web` | Pages 项目名 |
| `OPS_API_BASE` | `https://ops.88813888.xyz` | 前端构建时写入的后端地址 |

不配也能跑，workflow 里有默认值。

### 3.3 workflow 行为

`.github/workflows/pages.yml`：

- 触发：push 到 `main` 且改动涉及 `web/**` 或该 workflow 文件；也支持手动 `workflow_dispatch`。
- 构建：`pnpm install --frozen-lockfile` → `OPS_API_BASE=... pnpm run build` → `web/dist`。
- 部署：`wrangler pages deploy web/dist --project-name=<项目> --branch=main`。
- 首次运行会自动尝试 `wrangler pages project create`，失败（项目已存在）则继续部署。

后端部署（`deploy.yml` → `deploy/update.sh`）不受影响，两条流水线互不阻塞。

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
# 同站不同源，保持 lax 即可
OPS_COOKIE_SAMESITE=lax
```

注意：

- 值必须是**完整来源**（`scheme://host[:port]`），**不能带路径、不能带尾斜杠**；写错会被配置校验拒绝并拒绝启动，错误信息形如 `OPS_CORS_ORIGINS 中没有合法的来源（应形如 https://web.88813888.xyz）`。
- 多个来源用英文逗号分隔：`https://web.88813888.xyz,https://staging-web.88813888.xyz`。
- 如果之前按 `deploy/https-setup.md` 上了 HTTPS，`OPS_COOKIE_SECURE` 已经是 `1`，保持即可。
- `OPS_STATIC_DIR=/app/static` **不要删**——桌面端和 `ops.88813888.xyz` 直连访问都靠它。

### 4.2 应用

```bash
cd /path/to/OPS
bash deploy/update.sh
```

脚本会 `git reset --hard origin/main` → 备份数据库 → `docker compose up -d --build`。改 `.env` 后必须重建容器（`environment` 段的值在容器创建时固化）。

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
