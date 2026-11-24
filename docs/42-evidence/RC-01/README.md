# RC-01 证据归档：微信公众号真实出站、草稿写入与回读

- 执行日期：2026-11-23（CST，Asia/Shanghai）
- 账号：公众号「老S的AI商业笔记」，个人主体、未认证；平台账号 `REF41 真实公众号`
- 凭证注入：真实 AppID/AppSecret 仅从本地 PostgreSQL `wechat_credential`（密文）+ 本地 master key 文件读取；未写入代码、文档、日志、测试夹具或 git。本文所有 AppID/Secret 均不落盘。
- 执行边界：只创建并删除测试草稿；未调用发表、群发、freepublish，未触碰已发布内容。
- 同日追加：`10-13` 为 D-221 产品路由与 Web/桌面 UI 复验；产品路由删除只操作新临时草稿，既有 2 篇真实草稿未删除。
- 环境：本机 OPS server `127.0.0.1:18080`，`OPS_DEV=0`，真实 `https://api.weixin.qq.com`；数据库 `ops_ref41`。

## 1. 真实出站 IP、40164 与白名单修复

### 1.1 修复前：真实 40164

首次真实 `GetToken`（2026-11-23，脱敏摘录，原始输出来自临时 probe）：

```text
token_ok=false errcode=40164 errmsg="invalid ip 221.3.15.164 ipv6 ::ffff:221.3.15.164, not in whitelist rid: 6b03d0ba-6ef39352-2f52751e" elapsed_ms=207
```

结论：真实出站 IP = `221.3.15.164`（IPv6 映射 `::ffff:221.3.15.164`），不在当时的 API IP 白名单，微信拒绝发 token。

产品接口 `POST /api/v1/accounts/<account>/wechat-credential/test` 在修复前复现 40164（脱敏响应，不含凭证）：

```json
{"message":"服务器 IP 不在公众号白名单中。请到公众号后台「设置与开发 → 基本配置 → IP 白名单」添加服务器出口 IP。","ok":false}
```

文件：`07a-credential-test-40164.json`。

### 1.2 修复动作

- 修复位置：微信开发者平台 → 我的业务 → 公众号 → 基础信息 → 开发密钥 → API IP 白名单
- 修复前：`123.234.138.160`
- 修复后：`123.234.138.160, 221.3.15.164`
- 授权：保存时微信要求管理员扫码授权，已由用户扫码确认
- 证据：`04-wechat-developer-platform-whitelist-redacted.png`（已裁掉 AppID/邮箱等账号标识，只保留开发密钥与白名单行）

### 1.3 修复后：token 与基线

修复后真实 probe（2026-11-23）：

```text
token_ok=true token_len=137 expires_in=7200 elapsed_ms=431
draft_count_ok=true total_count=2
```

产品凭证测试修复后：

```json
{"datacube_state":"no_permission","message":"连接正常，已成功获取 access_token","ok":true}
```

文件：`07b-credential-test-ok.json`。`datacube_state=no_permission` 是个人未认证号的预期权限降级，不影响草稿 API。

## 2. access_token → uploadimg → draft/add

### 2.1 产品路由

`POST /api/v1/works/a60c08b3-2815-47e6-b7f0-0ea137d3083e/wechat/push`

请求摘要（脱敏）：登录 cookie + `X-CSRF-Token`，body 为 `{html, revision:7, fields, confirm_over_limit:true}`；正文 HTML 含一张 `/api/v1/assets/5b73f8b8-15df-4f08-9720-654c4a588a58` 图片。未记录 access_token。

### 2.2 第一次真实 draft/add：封面裁剪错误

SSE：

```text
upload_images: running → done (1/1)
upload_cover: running → done
write_draft: running → error
{"code":"wechat_error","detail":{"errcode":"53401","step":"write_draft"},"message":"封面图片尺寸不合法"}
```

文件：`05a-push-attempt-53401.txt`。
原因：初始 `cover_crops` 用整张 900x1200 图同时作为 2.35:1 与 1:1，比例不合法。修正为 `2.35_1: y2=0.3192`、`1_1: y2=0.75` 后重试。

### 2.3 第二次真实 draft/add：成功

SSE：

```text
upload_images: running → done (1/1)
upload_cover: running → done
write_draft: running → done
done {"action":"add","draft_media_id":"EKrmuYPOPNcu1A6jcfSuJtdTXzHJmYJIXPNHAy-rYS9mz5jaXCnPyRXMktHidm08","today_count":1}
```

文件：`05b-push-success.txt`。
真实草稿 media_id：`EKrmuYPOPNcu1A6jcfSuJtdTXzHJmYJIXPNHAy-rYS9mz5jaXCnPyRXMktHidm08`。

数据库落库（`08-db-rows.txt`；该文件是 push 成功后、delete 前的现场；delete + sync-draft 后的最终行见 `08b-db-row-after-delete.txt`，`draft_maybe_published=t`）：

```text
work: status=pushed, revision=7, wechat_draft_media_id=EKrmuYPO...Hidm08, draft_maybe_published=f
push_record: 1 条 failed（53401），1 条 ok
wechat_credential: last_check_ok=t, last_check_result=连接正常，已成功获取 access_token
```

### 2.4 uploadimg 真实图片

`upload_images` 步已真实完成；draft/get 回读正文中的图片为微信 CDN URL：

```text
https://mmbiz.qpic.cn/mmbiz_jpg/casakhZn70ZibQaV4TSRL9dIkYEKwR22jGR5onvjOv7LIKrvU00oDpNmYAt7DoIujeHGHqr52vttHjPDAS1rLibPzpJib59JEqyTjn6zibG864o/640?from=appmsg
```

2026-11-23 复核：`http_code=200`、`content_type=image/jpeg`、`size=19881`。详见 `09-uploadimg-and-image-url.txt`。这不是 mock 图片。

## 3. 公众号后台可见

- `00-wechat-backend-draft-list.png`：后台首页「近期草稿」出现「RC-01 真实草稿闭环 2026-11-23」，更新时间 15:04。
- `01-wechat-backend-preview.png`：草稿预览页标题一致，正文首段一致，正文图片可见，作者显示「老S的AI商业笔记」，时间 2026-11-23 15:04。
- `02-wechat-backend-preview-body.png`：正文后半段可见「本草稿不会发表、不会群发……」「记录时间：2026-11-23 CST。真实出站 IP：221.3.15.164」。

截图均来自本机 Chrome 已登录的公众号后台；未执行任何发表/群发操作。

## 4. draft/get → batchget/count → delete

### 4.1 产品单篇 draft/get

`POST /api/v1/works/a60c08b3-2815-47e6-b7f0-0ea137d3083e/wechat/sync-draft`

首次调用遇到真实 `40001 invalid credential`（原因：临时 probe 重新取 token，使缓存 token 失效）：

```text
微信接口错误 40001：invalid credential, access_token is invalid or not latest...
```

随后用产品凭证测试刷新 token 并重试，产品路由 PASS：

```json
{"maybe_published":false,"message":"草稿仍在草稿箱中"}
```

文件：`06-sync-draft.json`。该 40001 未跳过，完整记录并重试成功；不改写为一次通过。

`draft/delete` 后再调一次产品 `sync-draft`，正确返回 `{"maybe_published":true,...}`，DB 行 `draft_maybe_published=t`；见 `06b-sync-draft-after-delete.json` 与 `08b-db-row-after-delete.txt`。

### 4.2 适配器直调（历史基线：当时产品尚无 batchget/count/delete 路由）

命令：临时 probe `server/cmd/rc01probe`，`RC01_DRAFT_FLOW=<media_id>`；用同一真实 token 顺序执行：

```text
draft_get_ok=true title="RC-01 真实草稿闭环 2026-11-23" content_chars=651 content_sha256=48f7f000410b4cfbf8a2c500eea3dcd31c40dc416ea909401268c76b24dbea31
draft_get_contains_rc01=true draft_get_contains_batchget=true image_url_count=1
draft_batchget_ok=true total_count=3 item_count=3
draft_batchget_has_target=true
draft_count_before_delete_ok=true total_count=3
draft_delete_ok=true
draft_get_after_delete_ok=true errcode=40007
draft_count_after_delete_ok=true total_count=2
```

文件：`03-draft-get-batchget-count-delete.txt`。
解释：创建前基线 2 → 创建后 3 → 删除后 2；删除后同一 media_id 的 draft/get 返回 `40007`，证明删除真实生效。

### 4.3 产品路由与双端 UI（D-221 补齐，2026-11-23）

D-221 / FR-M10-14 补齐三条产品路由：

```text
GET    /api/v1/accounts/{accountId}/wechat/drafts?offset=&count=
GET    /api/v1/accounts/{accountId}/wechat/drafts/count
DELETE /api/v1/accounts/{accountId}/wechat/drafts/{mediaId}   body 必须 {"confirm":true}
```

- list/count 任意工作区成员可读；delete 仅 owner；单次仅一个 media_id，无批量接口。
- 删除成功后把引用该 media_id 的 work 行 `draft_maybe_published=true`，写审计 `wechat_draft_delete`。
- Web 与桌面 renderer 账号设置页均接入「公众号草稿箱」卡片；非 owner 只读，owner 才能逐篇删除；没有「全部删除」入口。

真实产品路由复验（`10-product-route-drafts.txt`）：基线 count=2 → 用专用临时草稿后 count=3、list total=3 → 不带 confirm 返回 409 `confirm_required` → 带 confirm 删除 200 → count 回落 2；既有两篇真实草稿未被触碰。

双端页面复验：

- `11-web-draft-panel.png`：Web 账号设置页草稿箱卡片，2 行、共 2 篇，显示标题/media_id 摘要/最后修改时间/删除按钮。
- `12-web-draft-delete-confirm.png`：Web 删除确认弹窗，文案含「只删除这一篇、不会发表、不会群发、删除后无法恢复、系统不会自动删除作品关联的其他草稿」；取消后仍 2 行。
- `13-desktop-renderer-draft-panel.png`：桌面 renderer 同一真实页面，2 行、共 2 篇。

### 4.4 第 5 条最终判定

- D-221 已接入 list/count/delete 产品路由，并在 Web、桌面 renderer 双端账号设置页接入草稿箱巡检 UI。
- 删除必须逐篇确认、仅 owner；不提供批量删除，不因删除作品自动删草稿。
- 第 5 条按「产品已接入」分支 PASS；不再把 batchget/count/delete 登记为后续需求，也不把适配器冒充产品功能。

## 5. 结论

五条通过标准逐条核对：

1. 真实凭证经加密配置注入，未落文档/日志/git；PASS。
2. access_token 成功；真实 uploadimg；带图 draft/add；后台同标题/正文/图片可见；PASS。
3. 产品 draft/get 回读成功；产品 list/count/delete 路由真实跑通 3→2，无 confirm 返回 409、confirm 删除 200；适配器 batchget 与删除后 40007 保留为历史证据；PASS。
4. 真实出站 IP 221.3.15.164 已记录；首次 40164 已记录并完成白名单修复，重试 token 成功；PASS。
5. D-221 已接入 list/count/delete 产品路由与双端账号设置页 UI；删除仅 owner、逐篇确认、无批量入口；真实路由与双端页面均复验通过；PASS。

因此 RC-01 可标记「已闭环」，且草稿箱巡检/逐篇删除已是用户可用产品功能；证据文件均在本目录。
