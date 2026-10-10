# AGENTS.md

本仓库是"公众号 + 小红书 AI 辅助运营平台"（D-036 起：多租户工作区 + 邀请码协作；历史 MVP 为单用户）。设计文档在 `docs/`，开发前先读任务对应的文档条目。

## 先读文档再写代码

- 功能与验收标准：`docs/04-需求与功能分级.md`
- 页面与交互、异常处理：`docs/05-业务流程与交互.md`
- 数据表、模块、AI 任务契约、接口清单：`docs/06-数据与技术架构.md`
- 任务拆分与测试：`docs/08-开发与测试计划.md`
- 决策记录：`docs/90-决策与变更记录.md`（实现与设计不一致时，先在这里登记）

## 目录

```
server/   Go 后端（cmd/ops 为入口；internal/ 为业务模块）
web/      React + TypeScript + Vite 前端
deploy/   Docker Compose（dev 为本地数据库）
docs/     设计文档
```

## 本地开发

```powershell
docker compose -f deploy/docker-compose.dev.yml up -d   # PostgreSQL，端口 5440
cd server; go run ./cmd/ops serve                       # API :8080，模拟微信与模拟模型 :8091
cd web; pnpm install; pnpm dev                          # 前端 :5173，代理 /api 到 :8080
```

本地默认使用模拟微信服务器和模拟模型（`OPS_DEV=1`），不需要任何真实密钥。

## 不可越过的红线

- 不实现任何发表、群发、定时发布、批量推送功能；
- 不添加"全部起草""全部确认""全部入库"之类的按钮或接口；
- 不做模拟登录、浏览器自动化，不逆向签名、不破解验证码、不使用账号登录态或代理池；热榜与小红书、公众号公开页面只能按 `docs/11-账号运营与热点采集规划.md` 的限额读取（D-047）；
- 不在代码、日志、测试数据中写入真实密钥；
- 不删除或跳过 HC-01 至 HC-25 测试（`server/internal/app/hc_test.go`）。

## 提交

- 一次一个任务，提交信息写任务编号，如 `DEV-109: 分段块编辑器`。
- 单人主干开发：直接在 `main` 上小步提交，发布时打标签。
